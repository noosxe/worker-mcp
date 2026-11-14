import * as fs from "node:fs";
import * as path from "node:path";

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
	) {
		this.dir = path.join(base, `${INSTANCE_PREFIX}${pid}`);
	}

	/** Create the directory if needed and return its path. */
	ensure(): string {
		if (this.created) return this.dir;
		fs.mkdirSync(this.base, { recursive: true, mode: 0o700 });
		this.sweepStale();
		// A directory with this name is left over from an earlier process that
		// had our pid: it is not in use, because we are the process with that pid.
		fs.rmSync(this.dir, { recursive: true, force: true });
		fs.mkdirSync(this.dir, { mode: 0o700 });
		const st = fs.lstatSync(this.dir);
		if (!st.isDirectory()) throw new Error(`${this.dir} is not a directory`);
		if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
			throw new Error(`${this.dir} is not owned by the current user`);
		}
		fs.chmodSync(this.dir, 0o700);
		this.created = true;
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
