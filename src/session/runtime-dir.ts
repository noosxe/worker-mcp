import * as fs from "node:fs";
import * as path from "node:path";

import { type Logger, noopLogger } from "../core/log.js";

const INSTANCE_PREFIX = "worker-mcp-";
const INSTANCE_PATTERN = /^worker-mcp-(\d+)$/;

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM means the process exists but belongs to someone else.
		return (e as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/**
 * The server instance's private runtime directory, `<base>/worker-mcp-<pid>`
 * (mode 0700). Constructing one does no I/O: the directory is created by the
 * first `ensure()` and removed by `dispose()` on a clean shutdown.
 */
export class RuntimeDir {
	readonly dir: string;
	private created = false;

	constructor(
		readonly base: string,
		private readonly pid: number = process.pid,
		private readonly log: Logger = noopLogger,
	) {
		this.dir = path.join(base, `${INSTANCE_PREFIX}${pid}`);
	}

	/**
	 * Return the directory's path, creating it if needed. Called before every
	 * worker spawn, so a directory deleted under a live server (a tmp reaper, a
	 * manual cleanup, a logout clearing `$XDG_RUNTIME_DIR`) is made again.
	 *
	 * Whatever is found is checked with `lstat`, never followed: a symlink, a
	 * non-directory, a directory owned by someone else or one that is not
	 * exactly 0700 makes this throw, so the spawn is refused instead of
	 * trusting something another process could have planted. A missing entry is
	 * created with `mkdir(mode 0700)`; if another process wins the race and the
	 * name appears first (EEXIST), the result is verified like any existing
	 * entry rather than reused blindly.
	 */
	ensure(): string {
		if (!this.created) {
			this.ensureBase();
			this.sweepStale();
			// A directory with this name is left over from an earlier process that
			// had our pid: it is not in use, because we are the process with that pid.
			// Only a plain directory of ours is removed; anything else is unsafe.
			this.removeLeftover();
			this.makeInstanceDir();
			this.created = true;
			return this.dir;
		}
		this.ensureBase();
		if (this.lstatOrNull(this.dir) === null) {
			this.makeInstanceDir();
			this.log.warn(
				"The private runtime directory was missing and has been recreated.",
			);
		} else {
			this.verifyPrivate(this.dir);
		}
		return this.dir;
	}

	/** A fresh private (0700) subdirectory for one worker. */
	createWorkerDir(): string {
		const parent = this.ensure();
		const dir = fs.mkdtempSync(path.join(parent, "worker-"));
		fs.chmodSync(dir, 0o700);
		return dir;
	}

	/** Remove the whole directory. Safe to call at any time, more than once. */
	dispose(): void {
		this.created = false;
		try {
			fs.rmSync(this.dir, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}

	private lstatOrNull(p: string): fs.Stats | null {
		try {
			return fs.lstatSync(p);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw e;
		}
	}

	/** Throw unless `p` is a plain directory of ours that nobody else can use. */
	private verifyPrivate(p: string, base = false): void {
		const st = this.lstatOrNull(p);
		if (st === null) throw new Error(`${p} does not exist`);
		if (st.isSymbolicLink()) throw new Error(`${p} is a symbolic link`);
		if (!st.isDirectory()) throw new Error(`${p} is not a directory`);
		if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
			throw new Error(`${p} is not owned by the current user`);
		}
		// The base may be a shared location such as `$XDG_RUNTIME_DIR`: it only
		// has to be closed to writes by others. Our own directory must be 0700.
		const mode = st.mode & 0o777;
		if (base ? (mode & 0o022) !== 0 : mode !== 0o700) {
			throw new Error(
				`${p} has unsafe permissions (${(st.mode & 0o777).toString(8)})`,
			);
		}
	}

	/** The directory holding the instance directory: made if missing, else verified. */
	private ensureBase(): void {
		if (this.lstatOrNull(this.base) === null) {
			fs.mkdirSync(this.base, { recursive: true, mode: 0o700 });
		}
		this.verifyPrivate(this.base, true);
	}

	private makeInstanceDir(): void {
		try {
			fs.mkdirSync(this.dir, { mode: 0o700 });
			fs.chmodSync(this.dir, 0o700); // in case the umask removed bits
		} catch (e) {
			// Lost a race: something else made the name first. It is verified,
			// never adopted unchecked.
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		this.verifyPrivate(this.dir);
	}

	private removeLeftover(): void {
		const st = this.lstatOrNull(this.dir);
		if (st === null) return;
		if (!st.isDirectory() || st.isSymbolicLink()) {
			throw new Error(`${this.dir} is not a plain directory`);
		}
		this.verifyOwner(st);
		fs.rmSync(this.dir, { recursive: true, force: true });
	}

	private verifyOwner(st: fs.Stats): void {
		if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
			throw new Error(`${this.dir} is not owned by the current user`);
		}
	}

	/**
	 * Remove instance directories left by a killed server. Only a plain
	 * directory of ours, named for a pid that is no longer running, is touched.
	 */
	private sweepStale(): void {
		let names: string[];
		try {
			names = fs.readdirSync(this.base);
		} catch {
			return;
		}
		for (const name of names) {
			const match = INSTANCE_PATTERN.exec(name);
			if (!match) continue;
			const pid = Number(match[1]);
			if (pid === this.pid || pidAlive(pid)) continue;
			const full = path.join(this.base, name);
			try {
				const st = fs.lstatSync(full);
				if (!st.isDirectory()) continue;
				if (
					typeof process.getuid === "function" &&
					st.uid !== process.getuid()
				) {
					continue;
				}
				fs.rmSync(full, { recursive: true, force: true });
			} catch {
				// not ours or already gone
			}
		}
	}
}
