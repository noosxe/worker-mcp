import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { z } from "zod";

import { WORKER_ID_PATTERN } from "../ids.js";
import type { BootRegistry } from "./boots.js";
import { type Logger, noopLogger } from "./log.js";
import {
	ensurePrivateDir,
	pidAlive,
	readPrivateFile,
	writeFileAtomic,
} from "./private-dir.js";

/**
 * Worker records and session directories under `<stateDir>/workers`.
 *
 * ```
 * workers/                  0700
 *   <lineage>/              0700   the first worker id, also the session id
 *     worker.json           0600   written by the server only
 *     owner                 0600   who holds the worker (see `claim`)
 *     session/              0700   the provider's own session files
 * ```
 *
 * The session holds the whole conversation, including file contents and
 * command output, so it is private: directories are 0700, files are 0600 (the
 * agent creates its file with the process umask; `tighten` fixes that), and
 * everything is checked with `lstat` and written atomically like the run
 * records. `worker.json` never holds a prompt, a tool argument, a credential
 * or an approval.
 */

export const WORKER_RECORD_VERSION = 1;
const BOOT_ID = /^[a-z0-9]{12}$/;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_OWNER_BYTES = 1024;
/** An `owner.breaking` directory older than this belongs to a breaker that died. */
const BREAKING_STALE_MS = 60_000;
/** An owner file that cannot be parsed is given this long to be finished. */
const OWNER_GRACE_MS = 5_000;
/** A directory with no record, left by a crash between its creation and the record. */
const ORPHAN_MS = 3_600_000;

export const DEFAULT_SESSION_RETENTION_MS = 3 * 24 * 3_600_000;
export const DEFAULT_MAX_SESSION_BYTES = 256 * 1024 * 1024;

export const workerRecordSchema = z.object({
	version: z.literal(WORKER_RECORD_VERSION),
	lineage: z.string().regex(WORKER_ID_PATTERN),
	/** Every worker id this lineage has had, newest last. */
	ids: z.array(z.string().max(64)).max(1000),
	name: z.string().max(64).optional(),
	provider: z.string().max(64),
	providerVersion: z.string().max(200).optional(),
	model: z.string().max(200).optional(),
	cwd: z.string().max(4096),
	sandbox: z.object({
		requested: z.enum(["none", "workspace"]).optional(),
		applied: z.enum(["none", "workspace"]),
	}),
	toolIsolation: z.boolean(),
	/** The risk policy as the caller set it (for reference; never restored as is). */
	policy: z.unknown().optional(),
	session: z.object({
		id: z.string().max(64),
		dir: z.string().max(4096),
	}),
	/** Only its length: the text itself is in the session. */
	systemPromptChars: z.number().int().min(0).optional(),
	createdAt: z.string().max(40),
	lastActiveAt: z.string().max(40),
	lastBootId: z.string().regex(BOOT_ID),
});
export type WorkerRecord = z.infer<typeof workerRecordSchema>;

const ownerSchema = z.object({
	bootId: z.string().regex(BOOT_ID),
	pid: z.number().int().positive(),
	/** The process's start time from `/proc/<pid>/stat`, to tell a reused pid. */
	startedAt: z.string().max(40).optional(),
});
export type OwnerClaim = z.infer<typeof ownerSchema>;

/** The worker is held by a live server, or its process is still exiting. */
export class OwnerBusyError extends Error {
	override name = "OwnerBusyError";
	constructor(
		message: string,
		readonly reason: "live" | "exiting" | "contended",
	) {
		super(message);
	}
}

/** Start time of a process (clock ticks since boot, as text), or undefined. */
export function processStartTime(pid: number): string | undefined {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		// The command name is in parentheses and may hold spaces: count from the end.
		const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return rest[19]; // field 22 overall; `rest` starts at field 3
	} catch {
		return undefined;
	}
}

export interface WorkerStoreOptions {
	/** `<stateDir>/workers`. */
	dir: string;
	bootId: string;
	boots: BootRegistry;
	retentionMs?: number;
	maxBytes?: number;
	log?: Logger;
	now?: () => number;
}

export interface WorkerLayout {
	lineage: string;
	/** `<dir>/<lineage>`. */
	dir: string;
	/** `<dir>/<lineage>/session`, already created 0700. */
	sessionDir: string;
}

export interface NewWorker {
	lineage: string;
	name?: string;
	provider: string;
	providerVersion?: string;
	model?: string;
	cwd: string;
	sandbox: { requested?: "none" | "workspace"; applied: "none" | "workspace" };
	toolIsolation: boolean;
	policy?: unknown;
	systemPromptChars?: number;
}

const describe = (e: unknown): string => {
	const code = (e as NodeJS.ErrnoException).code;
	const msg =
		e instanceof Error ? e.message.split("\n")[0].slice(0, 160) : "error";
	return code ? `${code}: ${msg}` : msg;
};

const lstatOrNull = (p: string): fs.Stats | null => {
	try {
		return fs.lstatSync(p);
	} catch {
		return null;
	}
};

const ownedByUs = (st: fs.Stats): boolean =>
	typeof process.getuid !== "function" || st.uid === process.getuid();

export class WorkerStore {
	private readonly log: Logger;
	private readonly now: () => number;
	private readonly retentionMs: number;
	private readonly maxBytes: number;
	private ready = false;

	constructor(private readonly opts: WorkerStoreOptions) {
		this.log = opts.log ?? noopLogger;
		this.now = opts.now ?? Date.now;
		this.retentionMs = opts.retentionMs ?? DEFAULT_SESSION_RETENTION_MS;
		this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_SESSION_BYTES;
	}

	get dir(): string {
		return this.opts.dir;
	}

	private lineageDir(lineage: string): string {
		if (!WORKER_ID_PATTERN.test(lineage)) {
			throw new Error("the lineage has an unexpected shape");
		}
		return path.join(this.opts.dir, lineage);
	}

	private ensureRoot(): void {
		if (this.ready && fs.existsSync(this.opts.dir)) return;
		this.ready = false;
		ensurePrivateDir(this.opts.dir);
		this.ready = true;
	}

	/**
	 * Make the directories of a new lineage, take its `owner` and write its
	 * record. Throws on failure (the caller then runs the worker without a
	 * session); on a failure after the directory exists it is removed again.
	 */
	create(input: NewWorker): WorkerLayout {
		this.ensureRoot();
		const dir = this.lineageDir(input.lineage);
		const sessionDir = path.join(dir, "session");
		try {
			ensurePrivateDir(dir);
			ensurePrivateDir(sessionDir);
			this.claim(input.lineage);
			const now = new Date(this.now()).toISOString();
			const record: WorkerRecord = {
				version: WORKER_RECORD_VERSION,
				lineage: input.lineage,
				ids: [input.lineage],
				name: input.name,
				provider: input.provider,
				providerVersion: input.providerVersion,
				model: input.model,
				cwd: input.cwd,
				sandbox: input.sandbox,
				toolIsolation: input.toolIsolation,
				policy: input.policy,
				session: { id: input.lineage, dir: sessionDir },
				systemPromptChars: input.systemPromptChars,
				createdAt: now,
				lastActiveAt: now,
				lastBootId: this.opts.bootId,
			};
			this.writeRecord(input.lineage, record);
		} catch (e) {
			// Someone else's live worker is not ours to remove.
			if (!(e instanceof OwnerBusyError)) this.remove(input.lineage);
			throw e;
		}
		return { lineage: input.lineage, dir, sessionDir };
	}

	// ---- the record ---------------------------------------------------------

	private writeRecord(lineage: string, record: WorkerRecord): void {
		const file = path.join(this.lineageDir(lineage), "worker.json");
		const tmp = path.join(
			this.lineageDir(lineage),
			`.worker.${randomBytes(4).toString("hex")}.tmp`,
		);
		writeFileAtomic(file, `${JSON.stringify(record)}\n`, tmp);
	}

	/** The record of a lineage, or null (missing, unreadable or not in the format). Never throws. */
	read(lineage: string): WorkerRecord | null {
		try {
			const text = readPrivateFile(
				path.join(this.lineageDir(lineage), "worker.json"),
				MAX_RECORD_BYTES,
			);
			if (text === null) return null;
			const parsed = workerRecordSchema.safeParse(JSON.parse(text));
			return parsed.success ? parsed.data : null;
		} catch {
			return null;
		}
	}

	/** Note activity and the server that had the worker last. Never throws. */
	touch(lineage: string): void {
		try {
			const rec = this.read(lineage);
			if (!rec) return;
			this.writeRecord(lineage, {
				...rec,
				lastActiveAt: new Date(this.now()).toISOString(),
				lastBootId: this.opts.bootId,
			});
		} catch (e) {
			this.log.debug(`worker record not touched: ${describe(e)}`);
		}
	}

	// ---- the session files --------------------------------------------------

	/**
	 * Make every file in the session directory private (0600). The agent
	 * creates its session file with the process umask (0644); the 0700
	 * directory already keeps other users out, this removes the bits that
	 * would matter if the directory ever were opened up. Files are opened
	 * without following symlinks and only regular files of ours are changed.
	 * Never throws.
	 */
	tighten(lineage: string): void {
		try {
			const sessionDir = path.join(this.lineageDir(lineage), "session");
			for (const name of fs.readdirSync(sessionDir)) {
				const file = path.join(sessionDir, name);
				const st = lstatOrNull(file);
				if (!st?.isFile() || !ownedByUs(st) || (st.mode & 0o077) === 0)
					continue;
				let fd: number | undefined;
				try {
					fd = fs.openSync(
						file,
						fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
					);
					fs.fchmodSync(fd, 0o600);
				} catch (e) {
					this.log.debug(`session file not made private: ${describe(e)}`);
				} finally {
					if (fd !== undefined) fs.closeSync(fd);
				}
			}
		} catch {
			// no session directory yet
		}
	}

	// ---- ownership ----------------------------------------------------------

	private ownerFile(lineage: string): string {
		return path.join(this.lineageDir(lineage), "owner");
	}

	private readOwner(lineage: string): OwnerClaim | "unreadable" | null {
		const file = this.ownerFile(lineage);
		try {
			const text = readPrivateFile(file, MAX_OWNER_BYTES);
			if (text === null) return null;
			const parsed = ownerSchema.safeParse(JSON.parse(text));
			return parsed.success ? parsed.data : "unreadable";
		} catch {
			return "unreadable";
		}
	}

	private writeOwnerExclusive(lineage: string, claim: OwnerClaim): void {
		const fd = fs.openSync(
			this.ownerFile(lineage),
			fs.constants.O_WRONLY |
				fs.constants.O_CREAT |
				fs.constants.O_EXCL |
				fs.constants.O_NOFOLLOW,
			0o600,
		);
		try {
			fs.writeFileSync(fd, `${JSON.stringify(claim)}\n`);
		} finally {
			fs.closeSync(fd);
		}
	}

	/** Why a claim by someone else stands, or null when it is stale. */
	private blocked(
		lineage: string,
		owner: OwnerClaim | "unreadable",
	): OwnerBusyError | null {
		if (owner === "unreadable") {
			const st = lstatOrNull(this.ownerFile(lineage));
			if (st && this.now() - st.mtimeMs < OWNER_GRACE_MS) {
				return new OwnerBusyError(
					"the worker's owner file is being written by another server",
					"contended",
				);
			}
			return null;
		}
		if (this.opts.boots.isLive(owner.bootId)) {
			return new OwnerBusyError(
				`this worker is live in another worker-mcp server (boot ${owner.bootId})`,
				"live",
			);
		}
		if (pidAlive(owner.pid)) {
			const now = processStartTime(owner.pid);
			// Unknown start times (no /proc) are taken as the same process: wait.
			if (
				owner.startedAt === undefined ||
				now === undefined ||
				now === owner.startedAt
			) {
				return new OwnerBusyError(
					"the previous worker process is still exiting; try again in a few seconds",
					"exiting",
				);
			}
		}
		return null;
	}

	/**
	 * Take the worker for this server. Creates `owner` exclusively; when one
	 * exists it is a live claim (another live server, or a process that is
	 * still exiting: `OwnerBusyError`) or a stale one, which is broken: the
	 * breaker makes `owner.breaking` (atomic, so only one succeeds), checks
	 * again, removes the old file and creates its own.
	 */
	claim(lineage: string, pid: number = process.pid): void {
		const mine: OwnerClaim = {
			bootId: this.opts.bootId,
			pid,
			startedAt: processStartTime(pid),
		};
		try {
			this.writeOwnerExclusive(lineage, mine);
			return;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		const owner = this.readOwner(lineage);
		if (owner === null) {
			// It went away in between: one more plain attempt.
			this.writeOwnerExclusive(lineage, mine);
			return;
		}
		if (owner !== "unreadable" && owner.bootId === this.opts.bootId) {
			throw new OwnerBusyError("this worker is live in this server", "live");
		}
		const busy = this.blocked(lineage, owner);
		if (busy) throw busy;

		const breaking = `${this.ownerFile(lineage)}.breaking`;
		try {
			fs.mkdirSync(breaking, { mode: 0o700 });
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			const st = lstatOrNull(breaking);
			if (st && this.now() - st.mtimeMs > BREAKING_STALE_MS) {
				fs.rmSync(breaking, { recursive: true, force: true });
				fs.mkdirSync(breaking, { mode: 0o700 });
			} else {
				throw new OwnerBusyError(
					"another server is taking over this worker",
					"contended",
				);
			}
		}
		try {
			const again = this.readOwner(lineage);
			if (again !== null) {
				const stillBusy = this.blocked(lineage, again);
				if (stillBusy) throw stillBusy;
				fs.rmSync(this.ownerFile(lineage), { force: true });
			}
			this.writeOwnerExclusive(lineage, mine);
		} finally {
			fs.rmSync(breaking, { recursive: true, force: true });
		}
	}

	/** Record the provider process that now holds the worker. Never throws. */
	setOwnerPid(lineage: string, pid: number): void {
		try {
			const owner = this.readOwner(lineage);
			if (owner === null || owner === "unreadable") return;
			if (owner.bootId !== this.opts.bootId) return;
			const file = this.ownerFile(lineage);
			const claim: OwnerClaim = {
				bootId: owner.bootId,
				pid,
				startedAt: processStartTime(pid),
			};
			writeFileAtomic(
				file,
				`${JSON.stringify(claim)}\n`,
				path.join(
					this.lineageDir(lineage),
					`.owner.${randomBytes(4).toString("hex")}.tmp`,
				),
			);
		} catch (e) {
			this.log.debug(`worker owner not updated: ${describe(e)}`);
		}
	}

	/** Give the worker up if this server holds it (idle close, crash, shutdown). Never throws. */
	release(lineage: string): void {
		try {
			const owner = this.readOwner(lineage);
			if (owner === null) return;
			if (owner !== "unreadable" && owner.bootId !== this.opts.bootId) return;
			fs.rmSync(this.ownerFile(lineage), { force: true });
		} catch (e) {
			this.log.debug(`worker owner not released: ${describe(e)}`);
		}
	}

	/** Whether a running server holds the lineage (this one included). */
	heldByLiveServer(lineage: string): boolean {
		const owner = this.readOwner(lineage);
		if (owner === null) return false;
		if (owner === "unreadable") return this.blocked(lineage, owner) !== null;
		return this.opts.boots.isLive(owner.bootId);
	}

	// ---- removal and retention ----------------------------------------------

	/** Delete the lineage: record, owner and session. Never throws. */
	remove(lineage: string): void {
		try {
			fs.rmSync(this.lineageDir(lineage), { recursive: true, force: true });
		} catch (e) {
			this.log.warn(
				`worker-mcp: a worker's session was not removed: ${describe(e)}`,
			);
		}
	}

	private lineages(): string[] {
		try {
			return fs
				.readdirSync(this.opts.dir)
				.filter((n) => WORKER_ID_PATTERN.test(n));
		} catch {
			return [];
		}
	}

	/** Bytes of the files in a lineage and the newest modification time. */
	private measure(lineage: string): { bytes: number; mtime: number } {
		let bytes = 0;
		let mtime = 0;
		const walk = (dir: string, depth: number) => {
			let names: string[];
			try {
				names = fs.readdirSync(dir);
			} catch {
				return;
			}
			for (const name of names) {
				const full = path.join(dir, name);
				const st = lstatOrNull(full);
				if (!st) continue;
				if (st.isDirectory()) {
					if (depth < 3) walk(full, depth + 1);
				} else if (st.isFile() && name !== "owner" && !name.endsWith(".tmp")) {
					bytes += st.size;
					mtime = Math.max(mtime, st.mtimeMs);
				}
			}
		};
		walk(this.lineageDir(lineage), 0);
		// A directory with no file in it (yet) is as old as the directory.
		if (mtime === 0) {
			mtime = lstatOrNull(this.lineageDir(lineage))?.mtimeMs ?? 0;
		}
		return { bytes, mtime };
	}

	/**
	 * Delete sessions with no activity for the retention time, then the oldest
	 * until the total is under the size cap. A lineage held by a live server
	 * (this one or another) is never deleted. Returns how many were removed.
	 */
	prune(): number {
		const now = this.now();
		const items = this.lineages().map((lineage) => ({
			lineage,
			...this.measure(lineage),
		}));
		items.sort((a, b) => a.mtime - b.mtime);
		let removed = 0;
		const gone = new Set<string>();
		const drop = (lineage: string) => {
			this.remove(lineage);
			gone.add(lineage);
			removed++;
		};
		for (const it of items) {
			if (this.heldByLiveServer(it.lineage)) continue;
			const orphan = this.read(it.lineage) === null;
			const limit = orphan ? ORPHAN_MS : this.retentionMs;
			if (now - it.mtime >= limit) drop(it.lineage);
		}
		let total = items
			.filter((i) => !gone.has(i.lineage))
			.reduce((n, i) => n + i.bytes, 0);
		for (const it of items) {
			if (total <= this.maxBytes) break;
			if (gone.has(it.lineage) || this.heldByLiveServer(it.lineage)) continue;
			drop(it.lineage);
			total -= it.bytes;
		}
		return removed;
	}
}
