import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type { Config } from "../config.js";
import { buildWorkerEnv } from "../session/launch.js";
import { LineFramer } from "./framing.js";
import { type Logger, noopLogger } from "./log.js";
import { TreeTracker } from "./proctree.js";

/**
 * The one place that starts worker processes. A provider describes the
 * command (`ChildSpec`); everything that must hold for every worker is done
 * here, so a provider cannot skip it: the environment allowlist, a process
 * group of its own, bounded framing, EPIPE-safe writes and a kill that also
 * reaches descendants in other process groups.
 */

export type SandboxMode = "none" | "workspace";

export interface ChildSpec {
	argv: [string, ...string[]];
	cwd: string;
	/** Provider extras, merged over the allowlisted environment. */
	env?: Record<string, string>;
	/** Only mode in v1: JSON lines in both directions. */
	stdio: "jsonl";
	/** Decided by the core. Only "none" exists until the sandbox phase. */
	sandbox: SandboxMode;
	/** Extra read-write paths for the sandbox (reserved). */
	writablePaths?: string[];
}

export interface ChildExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	/** Set when the process never started (missing binary, bad cwd). */
	error?: Error;
}

export interface ChildProblem {
	kind: "bad_json" | "line_too_long" | "stderr_line_truncated" | "stdin_error";
	detail: string;
}

export interface ManagedChild {
	/** Undefined when the process could not be started. */
	readonly pid: number | undefined;
	/** Resolves once the process started; rejects when it could not. */
	readonly started: Promise<void>;
	/** Resolves on the real exit, after the output pipes drained. Never rejects. */
	readonly exited: Promise<ChildExit>;
	/** True once `terminate` was called. */
	readonly terminating: boolean;
	/**
	 * Write one JSON line. Returns false, never throws, once stdin is gone or
	 * too much output is already waiting. `done` reports the eventual write
	 * result (an EPIPE arrives here, not as an exception).
	 */
	send(msg: unknown, done?: (err: Error | null) => void): boolean;
	/** Complete stdout lines, capped, empty lines skipped. */
	onLine(cb: (line: string) => void): void;
	/** Parsed stdout lines; a line that is not JSON is reported as a problem. */
	onMessage(cb: (msg: unknown) => void): void;
	/** Stderr lines, each truncated. */
	onStderr(cb: (line: string) => void): void;
	/** Framing and pipe problems that did not stop the worker. */
	onProblem(cb: (problem: ChildProblem) => void): void;
	/**
	 * SIGTERM to the worker, then after `graceMs` SIGKILL to its group and to
	 * every remembered descendant, however many groups they are spread over.
	 * Idempotent: later calls return the first call's promise. Resolves on the
	 * real exit.
	 */
	terminate(graceMs?: number): Promise<void>;
}

export interface ChildLimits {
	/** Longest accepted stdout line, in characters. Longer lines are dropped. */
	maxLineChars: number;
	/** Longest stderr line passed on, in characters. The rest is cut. */
	maxStderrLineChars: number;
	/** Output queued for a child that does not read stdin, in bytes. */
	maxPendingWriteBytes: number;
	/** How often the process tree is recorded while a child runs. */
	treePollMs: number;
	/** Default grace between SIGTERM and SIGKILL. */
	graceMs: number;
}

export const DEFAULT_CHILD_LIMITS: ChildLimits = {
	maxLineChars: 8 * 1024 * 1024,
	maxStderrLineChars: 1024,
	maxPendingWriteBytes: 8 * 1024 * 1024,
	treePollMs: process.platform === "linux" ? 1000 : 5000,
	graceMs: 3000,
};

export interface ChildRegistryOptions {
	/** The server's environment: the source of the worker's allowlisted env. */
	env: NodeJS.ProcessEnv;
	envConfig: Pick<Config["env"], "allow" | "forceDropExempt">;
	limits?: Partial<ChildLimits>;
	log?: Logger;
}

/** Wait this long for the pipes to drain after the process exited. */
const DRAIN_MS = 500;
/** Wait this long for the exit after SIGKILL before giving up. */
const KILL_WAIT_MS = 5000;

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

function signalGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		// no such group: nothing left in it
	}
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		// already gone
	}
}

class Child implements ManagedChild {
	readonly started: Promise<void>;
	readonly exited: Promise<ChildExit>;
	private readonly proc: ChildProcess;
	private readonly tracker: TreeTracker | null;
	private readonly lineCbs: ((line: string) => void)[] = [];
	private readonly messageCbs: ((msg: unknown) => void)[] = [];
	private readonly stderrCbs: ((line: string) => void)[] = [];
	private readonly problemCbs: ((p: ChildProblem) => void)[] = [];
	private terminatePromise: Promise<void> | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private exitedFlag = false;

	constructor(
		spec: ChildSpec,
		env: Record<string, string>,
		private readonly limits: ChildLimits,
		private readonly log: Logger,
		private readonly onGone: (child: Child) => void,
	) {
		const [command, ...args] = spec.argv;
		this.proc = spawn(command, args, {
			cwd: spec.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			// Its own process group, so the whole group can be signalled.
			detached: true,
		});
		const proc = this.proc;

		let markStarted!: () => void;
		let failStart!: (e: Error) => void;
		this.started = new Promise<void>((resolve, reject) => {
			markStarted = resolve;
			failStart = reject;
		});
		// An unobserved rejection must not become an unhandled one.
		this.started.catch(() => {});

		this.tracker =
			proc.pid === undefined
				? null
				: new TreeTracker(proc.pid, process.platform);

		let settleExit!: (e: ChildExit) => void;
		let spawned = false;
		this.exited = new Promise<ChildExit>((resolve) => {
			settleExit = (e) => {
				if (this.exitedFlag) return;
				this.exitedFlag = true;
				if (this.pollTimer) clearInterval(this.pollTimer);
				resolve(e);
				this.onGone(this);
			};
		});

		proc.once("spawn", () => {
			spawned = true;
			markStarted();
			if (this.tracker) {
				this.pollTimer = setInterval(
					() => this.tracker?.refresh(),
					this.limits.treePollMs,
				);
				this.pollTimer.unref();
			}
		});
		proc.once("error", (err) => {
			if (!spawned) {
				failStart(err);
				settleExit({ code: null, signal: null, error: err });
			} else {
				this.log.warn(`child process error: ${err.message}`);
			}
		});

		// Handlers go on before the first write or read, so a closed pipe can
		// never surface as an uncaught 'error' event.
		proc.stdin?.on("error", (err) => {
			this.problem({ kind: "stdin_error", detail: err.message });
		});
		proc.stdout?.on("error", () => {});
		proc.stderr?.on("error", () => {});

		this.wireStdout(proc);
		this.wireStderr(proc);

		let exitInfo: {
			code: number | null;
			signal: NodeJS.Signals | null;
		} | null = null;
		proc.once("exit", (code, signal) => {
			exitInfo = { code, signal };
			// Whatever the worker left running goes with it.
			this.sweep();
			// 'close' waits for every holder of the pipes; do not wait forever
			// for a descendant that kept them open.
			setTimeout(() => {
				proc.stdout?.destroy();
				proc.stderr?.destroy();
				settleExit({ code, signal });
			}, DRAIN_MS).unref();
		});
		proc.once("close", (code, signal) => {
			settleExit(exitInfo ?? { code, signal });
		});
	}

	get pid(): number | undefined {
		return this.proc.pid;
	}

	get terminating(): boolean {
		return this.terminatePromise !== null;
	}

	private problem(p: ChildProblem): void {
		this.log.debug(`child ${this.pid}: ${p.kind}: ${p.detail}`);
		for (const cb of this.problemCbs) cb(p);
	}

	private wireStdout(proc: ChildProcess): void {
		const decoder = new StringDecoder("utf8");
		const framer = new LineFramer(
			this.limits.maxLineChars,
			(line) => this.dispatchLine(line),
			(n) =>
				this.problem({
					kind: "line_too_long",
					detail: `dropped a line over ${this.limits.maxLineChars} characters (at least ${n})`,
				}),
		);
		proc.stdout?.on("data", (chunk: Buffer) =>
			framer.push(decoder.write(chunk)),
		);
		proc.stdout?.on("end", () => {
			framer.push(decoder.end());
			framer.end();
		});
	}

	private dispatchLine(line: string): void {
		if (line.trim() === "") return;
		for (const cb of this.lineCbs) cb(line);
		if (this.messageCbs.length === 0) return;
		let msg: unknown;
		try {
			msg = JSON.parse(line);
		} catch {
			this.problem({
				kind: "bad_json",
				detail: `a stdout line was not JSON (${line.length} characters)`,
			});
			return;
		}
		for (const cb of this.messageCbs) cb(msg);
	}

	private wireStderr(proc: ChildProcess): void {
		const max = this.limits.maxStderrLineChars;
		const decoder = new StringDecoder("utf8");
		let truncatedNoted = false;
		const framer = new LineFramer(
			// Cap the partial-line buffer at the same bound as the line itself.
			max * 4,
			(line) => this.emitStderr(line, max),
			(n) => {
				// Far over the cap: the line is dropped, not buffered.
				if (!truncatedNoted) {
					truncatedNoted = true;
					this.problem({
						kind: "stderr_line_truncated",
						detail: `a stderr line of at least ${n} characters was dropped`,
					});
				}
			},
		);
		proc.stderr?.on("data", (chunk: Buffer) =>
			framer.push(decoder.write(chunk)),
		);
		proc.stderr?.on("end", () => {
			framer.push(decoder.end());
			framer.end();
		});
	}

	private emitStderr(line: string, max: number): void {
		if (line.trim() === "") return;
		const text = line.length > max ? `${line.slice(0, max)}…` : line;
		for (const cb of this.stderrCbs) cb(text);
	}

	send(msg: unknown, done?: (err: Error | null) => void): boolean {
		const stdin = this.proc.stdin;
		const fail = (reason: string): false => {
			done?.(new Error(reason));
			return false;
		};
		if (this.exitedFlag || !stdin || stdin.destroyed || !stdin.writable) {
			return fail("the worker's stdin is closed");
		}
		if (stdin.writableLength > this.limits.maxPendingWriteBytes) {
			return fail("the worker is not reading its stdin");
		}
		let payload: string;
		try {
			payload = `${JSON.stringify(msg)}\n`;
		} catch {
			return fail("the message cannot be serialised");
		}
		try {
			stdin.write(payload, "utf8", (err) => done?.(err ?? null));
		} catch (e) {
			return fail(e instanceof Error ? e.message : String(e));
		}
		return true;
	}

	onLine(cb: (line: string) => void): void {
		this.lineCbs.push(cb);
	}
	onMessage(cb: (msg: unknown) => void): void {
		this.messageCbs.push(cb);
	}
	onStderr(cb: (line: string) => void): void {
		this.stderrCbs.push(cb);
	}
	onProblem(cb: (p: ChildProblem) => void): void {
		this.problemCbs.push(cb);
	}

	terminate(graceMs: number = this.limits.graceMs): Promise<void> {
		this.terminatePromise ??= this.doTerminate(graceMs);
		return this.terminatePromise;
	}

	private async doTerminate(graceMs: number): Promise<void> {
		const pid = this.proc.pid;
		if (pid === undefined) {
			await this.exited;
			return;
		}
		this.log.debug(`terminating child ${pid}`);
		// Record the tree first: after the worker dies its children are orphaned
		// and cannot be found from it any more.
		this.tracker?.refresh();
		if (!this.exitedFlag) signalPid(pid, "SIGTERM");

		const deadline = Date.now() + graceMs;
		while (!this.exitedFlag && Date.now() < deadline) {
			await Promise.race([
				this.exited,
				sleep(Math.min(250, Math.max(10, deadline - Date.now()))),
			]);
			if (!this.exitedFlag) this.tracker?.refresh();
		}

		// Anything still around gets SIGKILL: the group, then the descendants
		// that live in other groups.
		this.sweep();
		await Promise.race([this.exited, sleep(KILL_WAIT_MS)]);
		if (!this.exitedFlag) {
			this.log.warn(`child ${pid} did not exit after SIGKILL`);
		}
	}

	/** SIGKILL the worker's group and every remembered descendant. */
	sweep(): void {
		const pid = this.proc.pid;
		if (pid === undefined) return;
		signalGroup(pid, "SIGKILL");
		this.tracker?.signalAll("SIGKILL");
	}

	/** Synchronous, for a second shutdown signal: no waiting. */
	killNow(): void {
		this.sweep();
	}
}

/** Starts and keeps track of every worker process of this server. */
export class ChildRegistry {
	private readonly children = new Set<Child>();
	private readonly limits: ChildLimits;
	private readonly log: Logger;

	constructor(private readonly opts: ChildRegistryOptions) {
		this.limits = { ...DEFAULT_CHILD_LIMITS, ...opts.limits };
		this.log = opts.log ?? noopLogger;
	}

	/** Number of children that have not exited yet. */
	get size(): number {
		return this.children.size;
	}

	spawn(spec: ChildSpec): ManagedChild {
		if (spec.sandbox !== "none") {
			throw new Error(
				`sandbox mode "${spec.sandbox}" is not available in this build`,
			);
		}
		const env = {
			...buildWorkerEnv(this.opts.env, this.opts.envConfig),
			...spec.env,
		};
		const child = new Child(spec, env, this.limits, this.log, (c) =>
			this.children.delete(c),
		);
		this.children.add(child);
		return child;
	}

	/** Terminate every child in parallel; resolves when all have exited. */
	async terminateAll(graceMs?: number): Promise<void> {
		await Promise.all([...this.children].map((c) => c.terminate(graceMs)));
	}

	/** SIGKILL every child's group and tree now, without waiting. */
	killAllNow(): void {
		for (const c of this.children) c.killNow();
	}
}
