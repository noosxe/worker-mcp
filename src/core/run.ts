import { randomBytes } from "node:crypto";

import type { Usage } from "../providers/types.js";

/**
 * Runs: one task given to a worker, from start to a result. Nothing here knows
 * a provider; the session feeds a `Run` from the worker's events and the MCP
 * tools read it. A run settles exactly once, and its result stays readable
 * after its worker is gone.
 */

export type RunState =
	| "starting"
	| "running"
	| "awaiting_approval"
	| "completed"
	| "failed"
	| "cancelled"
	| "timed_out";

export type TerminalState = Extract<
	RunState,
	"completed" | "failed" | "cancelled" | "timed_out"
>;

const TERMINAL = new Set<RunState>([
	"completed",
	"failed",
	"cancelled",
	"timed_out",
]);

export const isTerminal = (state: RunState): state is TerminalState =>
	TERMINAL.has(state);

/** A tool call held for the coordinator. */
export interface PendingApprovalInfo {
	actionId: string;
	tool: string;
	/** What the worker asked to do, one line. */
	summary: string;
	input: unknown;
	riskLevel?: number;
	riskLabel?: string;
	/** Why the gate sent it to the coordinator. */
	reason?: string;
	/** A hard limit (a protected path): only the coordinator can allow it. */
	hardLimit?: boolean;
	/** The run's `seq` when the approval appeared. */
	seq: number;
	/** When the approval is denied if nobody answered (epoch ms). */
	expiresAt: number;
}

export interface ActivityEntry {
	seq: number;
	text: string;
}

export interface GateSummary {
	autoAllowed: number;
	autoDenied: number;
	escalated: number;
	/** Up to a few lines about what ran or was refused without asking. */
	notable: string[];
}

const MAX_ACTIVITY = 100;
const MAX_NOTABLE = 20;

/** Text with a hard size bound that drops the oldest and keeps absolute offsets. */
export class OutputBuffer {
	private text = "";
	private dropped = 0;

	constructor(private readonly max: number) {}

	append(chunk: string): void {
		this.text += chunk;
		if (this.text.length > this.max) {
			const drop = this.text.length - this.max;
			this.text = this.text.slice(drop);
			this.dropped += drop;
		}
	}

	/** Characters ever appended, including any dropped. */
	get total(): number {
		return this.dropped + this.text.length;
	}

	/** True once the oldest output has been dropped. */
	get truncated(): boolean {
		return this.dropped > 0;
	}

	/** Everything still held. */
	get all(): string {
		return this.text;
	}

	/** Up to `max` characters from absolute offset `from`. */
	slice(
		from: number,
		max: number,
	): { text: string; offset: number; nextOffset: number } {
		const offset = Math.min(Math.max(from, this.dropped), this.total);
		const text = this.text.slice(
			offset - this.dropped,
			offset - this.dropped + max,
		);
		return { text, offset, nextOffset: offset + text.length };
	}
}

export class Run {
	state: RunState = "starting";
	/** Bumps on every observable change; the cursor for `wait_run`. */
	seq = 0;
	startedAt: number | undefined;
	endedAt: number | undefined;
	/** Set on every run of a worker when the worker goes away. */
	workerClosedAt: number | undefined;
	error: string | undefined;
	usage: Usage | undefined;
	readonly output: OutputBuffer;
	readonly activity: ActivityEntry[] = [];
	readonly approvals = new Map<string, PendingApprovalInfo>();
	/** `seq` of the last approval that timed out; wakes a wait once. */
	lastExpiredSeq = 0;
	readonly gate: GateSummary = {
		autoAllowed: 0,
		autoDenied: 0,
		escalated: 0,
		notable: [],
	};

	constructor(
		readonly id: string,
		readonly workerId: string,
		readonly prompt: string,
		readonly intent: string | undefined,
		readonly createdAt: number,
		outputBufferChars: number,
	) {
		this.output = new OutputBuffer(outputBufferChars);
	}

	get terminal(): boolean {
		return isTerminal(this.state);
	}

	noteGate(kind: "allowed" | "denied" | "escalated", line: string): void {
		if (kind === "allowed") this.gate.autoAllowed++;
		else if (kind === "denied") this.gate.autoDenied++;
		else this.gate.escalated++;
		if (this.gate.notable.length < MAX_NOTABLE) this.gate.notable.push(line);
	}
}

/** Why a wait returned. */
export type WaitReason = "terminal" | "approval" | "timeout" | "detached";

export interface RunStoreOptions {
	/** How long a finished run is kept once its worker is gone. */
	retentionMs: number;
	/** Most finished runs kept at once. */
	maxRetained: number;
	/** Hard bound on any wait. */
	maxWaitMs: number;
	outputBufferChars: number;
	now?: () => number;
}

export type RunListener = (message: string, run: Run) => void;

/**
 * What a waiter has already seen. A caller with a cursor has seen everything
 * up to it. One without a cursor wants any approval still pending, but is not
 * woken for an expiry that happened before it asked.
 */
interface Since {
	approval: number;
	expiry: number;
}

interface Waiter {
	run: Run;
	since: Since;
	wake: (reason: WaitReason) => void;
}

/** A new run id: `r_` and 16 characters, unique for this process. */
export function newRunId(): string {
	return `r_${randomBytes(10).toString("base64url").replace(/[-_]/g, "x").slice(0, 16)}`;
}

export class RunStore {
	private readonly runs = new Map<string, Run>();
	private readonly waiters = new Set<Waiter>();
	private readonly listeners = new Map<string, Set<RunListener>>();
	private readonly now: () => number;

	constructor(private readonly opts: RunStoreOptions) {
		this.now = opts.now ?? Date.now;
	}

	get maxWaitMs(): number {
		return this.opts.maxWaitMs;
	}

	create(workerId: string, prompt: string, intent?: string): Run {
		this.prune();
		const run = new Run(
			newRunId(),
			workerId,
			prompt,
			intent,
			this.now(),
			this.opts.outputBufferChars,
		);
		this.runs.set(run.id, run);
		return run;
	}

	get(runId: string): Run | undefined {
		this.prune();
		return this.runs.get(runId);
	}

	/** Runs of one worker, oldest first. */
	runsOf(workerId: string): Run[] {
		this.prune();
		return [...this.runs.values()].filter((r) => r.workerId === workerId);
	}

	/** Number of runs held, finished or not. */
	get size(): number {
		return this.runs.size;
	}

	// ---- changes ---------------------------------------------------------------

	/** Record that something observable changed. `message` goes to listeners. */
	touch(run: Run, message?: string): void {
		run.seq++;
		this.wakeWaiters(run);
		if (message !== undefined) this.notify(run, message);
	}

	setState(run: Run, state: RunState): void {
		if (run.terminal || run.state === state) return;
		run.state = state;
		if (state === "running" && run.startedAt === undefined) {
			run.startedAt = this.now();
		}
		this.touch(run, `state: ${state}`);
	}

	/** Add a line to the run's activity (a tool call, a notice). */
	addActivity(run: Run, text: string): void {
		if (run.terminal) return;
		run.seq++;
		run.activity.push({ seq: run.seq, text });
		if (run.activity.length > MAX_ACTIVITY) run.activity.shift();
		this.wakeWaiters(run);
		this.notify(run, text);
	}

	/** Append to the run's output. Does not wake waiters. */
	addOutput(run: Run, text: string): void {
		if (run.terminal || text === "") return;
		run.output.append(run.output.total > 0 ? `\n\n${text}` : text);
		run.seq++;
	}

	addApproval(
		run: Run,
		info: Omit<PendingApprovalInfo, "seq">,
		message: string,
	): void {
		if (run.terminal) return;
		run.seq++;
		run.approvals.set(info.actionId, { ...info, seq: run.seq });
		this.setStateQuiet(run, "awaiting_approval");
		this.wakeWaiters(run);
		this.notify(run, message);
	}

	/** An approval was answered, cancelled or expired. */
	removeApproval(run: Run, actionId: string, expired = false): void {
		if (!run.approvals.delete(actionId)) return;
		run.seq++;
		if (expired) run.lastExpiredSeq = run.seq;
		if (run.approvals.size === 0 && !run.terminal) {
			this.setStateQuiet(run, "running");
		}
		this.wakeWaiters(run);
		this.notify(run, expired ? "approval timed out" : "approval answered");
	}

	private setStateQuiet(run: Run, state: RunState): void {
		if (run.terminal) return;
		run.state = state;
	}

	/**
	 * The only way into a terminal state. Returns false, and changes nothing,
	 * when the run already ended.
	 */
	settle(
		run: Run,
		state: TerminalState,
		fields: { error?: string; usage?: Usage } = {},
	): boolean {
		if (run.terminal) return false;
		run.state = state;
		run.endedAt = this.now();
		run.error = fields.error;
		run.usage = fields.usage;
		run.approvals.clear();
		run.seq++;
		this.wakeWaiters(run);
		this.notify(run, `state: ${state}`);
		this.prune();
		return true;
	}

	/** A worker is gone: its runs start to expire. */
	workerClosed(workerId: string): void {
		const at = this.now();
		for (const run of this.runs.values()) {
			if (run.workerId === workerId) run.workerClosedAt ??= at;
		}
		this.prune();
	}

	/** Drop expired runs, then the oldest finished ones past the cap. */
	prune(): void {
		const now = this.now();
		const finished: Run[] = [];
		for (const run of this.runs.values()) {
			if (!run.terminal) continue;
			const gone = run.workerClosedAt;
			if (gone !== undefined) {
				const from = Math.max(gone, run.endedAt ?? gone);
				if (now - from >= this.opts.retentionMs) {
					this.runs.delete(run.id);
					this.listeners.delete(run.id);
					continue;
				}
			}
			finished.push(run);
		}
		const excess = finished.length - this.opts.maxRetained;
		if (excess > 0) {
			finished.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
			for (const run of finished.slice(0, excess)) {
				this.runs.delete(run.id);
				this.listeners.delete(run.id);
			}
		}
	}

	// ---- waiting ---------------------------------------------------------------

	/** Why a wait on `run` would return right now, or null. */
	private wakeReason(run: Run, since: Since): WaitReason | null {
		if (run.terminal) return "terminal";
		for (const a of run.approvals.values()) {
			if (a.seq > since.approval) return "approval";
		}
		if (run.lastExpiredSeq > since.expiry) return "approval";
		return null;
	}

	/**
	 * Wait for something worth waking for: a terminal state, a new pending
	 * approval, or an approval that expired. New output alone does not end a
	 * wait. Never longer than `maxWaitMs` (clamped to the store's bound). An
	 * aborted `signal` detaches the wait; the run is untouched.
	 */
	waitForChange(
		run: Run,
		opts: { sinceSeq?: number; maxWaitMs: number; signal?: AbortSignal },
	): Promise<WaitReason> {
		const since: Since = {
			approval: opts.sinceSeq ?? 0,
			expiry: opts.sinceSeq ?? run.seq,
		};
		const immediate = this.wakeReason(run, since);
		if (immediate) return Promise.resolve(immediate);
		const ms = Math.max(0, Math.min(opts.maxWaitMs, this.opts.maxWaitMs));
		if (ms === 0) return Promise.resolve("timeout");
		if (opts.signal?.aborted) return Promise.resolve("detached");
		return new Promise<WaitReason>((resolve) => {
			let done = false;
			const finish = (reason: WaitReason) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				this.waiters.delete(waiter);
				opts.signal?.removeEventListener("abort", onAbort);
				resolve(reason);
			};
			const onAbort = () => finish("detached");
			const timer = setTimeout(() => finish("timeout"), ms);
			const waiter: Waiter = { run, since, wake: finish };
			this.waiters.add(waiter);
			opts.signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private wakeWaiters(run: Run): void {
		for (const w of this.waiters) {
			if (w.run !== run) continue;
			const reason = this.wakeReason(run, w.since);
			if (reason) w.wake(reason);
		}
	}

	// ---- listeners (progress) ------------------------------------------------------

	subscribe(runId: string, listener: RunListener): () => void {
		let set = this.listeners.get(runId);
		if (!set) this.listeners.set(runId, (set = new Set()));
		set.add(listener);
		return () => {
			set.delete(listener);
		};
	}

	private notify(run: Run, message: string): void {
		const set = this.listeners.get(run.id);
		if (!set) return;
		for (const l of set) {
			try {
				l(message, run);
			} catch {
				// a listener must never break the run
			}
		}
	}
}

// ---- views -------------------------------------------------------------------

export interface RunView {
	runId: string;
	workerId: string;
	state: RunState;
	seq: number;
	elapsedMs: number;
	pendingApprovals: {
		actionId: string;
		tool: string;
		summary: string;
		riskLabel?: string;
		reason?: string;
		hardLimit?: boolean;
		expiresInMs: number;
	}[];
	/** Tool calls and notices since `sinceSeq`, at most the last 10. */
	activity: string[];
	output: {
		text: string;
		offset: number;
		nextOffset: number;
		totalChars: number;
		/** The oldest output was dropped to stay within the buffer. */
		truncated: boolean;
		/** More output is waiting past `nextOffset`. */
		more: boolean;
	};
	error?: string;
	usage?: Usage;
	gate: GateSummary;
	/** What to call next. */
	next: string;
}

export interface ViewOptions {
	sinceSeq?: number;
	outputOffset?: number;
	maxChars: number;
	now?: number;
}

export function runView(run: Run, opts: ViewOptions): RunView {
	const now = opts.now ?? Date.now();
	const end = run.endedAt ?? now;
	const slice = run.output.slice(opts.outputOffset ?? 0, opts.maxChars);
	const since = opts.sinceSeq ?? 0;
	const view: RunView = {
		runId: run.id,
		workerId: run.workerId,
		state: run.state,
		seq: run.seq,
		elapsedMs: Math.max(0, end - run.createdAt),
		pendingApprovals: [...run.approvals.values()].map((a) => ({
			actionId: a.actionId,
			tool: a.tool,
			summary: a.summary,
			riskLabel: a.riskLabel,
			reason: a.reason,
			hardLimit: a.hardLimit,
			expiresInMs: Math.max(0, a.expiresAt - now),
		})),
		activity: run.activity
			.filter((a) => a.seq > since)
			.slice(-10)
			.map((a) => a.text),
		output: {
			text: slice.text,
			offset: slice.offset,
			nextOffset: slice.nextOffset,
			totalChars: run.output.total,
			truncated: run.output.truncated,
			more: slice.nextOffset < run.output.total,
		},
		error: run.error,
		usage: run.usage,
		gate: run.gate,
		next: "",
	};
	view.next = nextHint(run, view);
	return view;
}

function nextHint(run: Run, view: RunView): string {
	if (view.output.more) {
		return `More output: call get_run with runId ${run.id} and offset ${view.output.nextOffset}.`;
	}
	if (run.terminal) return "The run is over; this is its result.";
	if (view.pendingApprovals.length > 0) {
		return "Decide with approve_action or reject_action, then call wait_run again.";
	}
	return `Call wait_run with runId ${run.id}, sinceSeq ${run.seq} and outputOffset ${view.output.nextOffset}.`;
}
