import { type Config, defaultConfig } from "../config.js";
import { ChildRegistry } from "../core/child.js";
import { type OpenedWorker, openWorker } from "../core/host.js";
import { debugEnabled, describeError, shortDigest } from "../core/log.js";
import { RepeatCheck } from "../core/repeat-check.js";
import {
	type Run,
	RunStore,
	type RunSink,
	type TerminalState,
} from "../core/run.js";
import type { GateOutcome } from "../gate/classifier.js";
import {
	DEFAULT_MAX_AUTO_APPROVE,
	Gate as ApprovalGate,
} from "../gate/gate.js";
import {
	DEFAULT_RISK_POLICY,
	normalizePolicy,
	type RiskPolicy,
} from "../gate/policy.js";
import { RISK_LABELS, RiskLevel } from "../gate/risk.js";
import type { GateServices } from "../gate/services.js";
import { Boot } from "../ids.js";
import type {
	ApprovalDecision,
	RawToolCall,
	Usage,
	WorkerEvent,
	WorkerProvider,
} from "../providers/types.js";
import { wrapUntrusted } from "../render.js";
import { BoundedLog } from "./bounded-log.js";
import type { ResumedInfo } from "./resume.js";
import type { RuntimeDir } from "./runtime-dir.js";

export type SessionStatus =
	| "IDLE"
	| "RUNNING"
	| "AWAITING_APPROVAL"
	| "CRASHED"
	| "FINISHED";

export interface AutoApprovedAction {
	actionId: string;
	/** The run the call belonged to, when there was one. */
	runId?: string;
	toolName: string;
	input: Record<string, unknown>;
	riskLevel: RiskLevel;
	riskLabel: string;
	reason: string;
	timestamp: string;
	/** The override pattern that triggered the auto-approval, if any */
	matchedOverride?: string;
}

export interface PolicyReport {
	/** The policy now in force. */
	policy: RiskPolicy;
	/** What the server's ceiling lowered, one line each. */
	clamped: string[];
}

export interface PendingAction {
	/** The server-made approval id (`a_…`). */
	actionId: string;
	runId: string;
	tool: string;
	kind: string;
	command?: string;
	paths: { path: string; inWorkspace: boolean; protected: boolean }[];
	riskLevel?: RiskLevel;
	riskLabel?: string;
	/** Why the gate sent this to the coordinator. */
	reason?: string;
	/** A hard limit (a protected path): only the coordinator can allow it. */
	hardLimit?: boolean;
}

const safeJson = (v: unknown): string => JSON.stringify(v) ?? "undefined";

const SUMMARY_MAX_CHARS = 120;

/** One line describing a tool input: its command or target path, truncated. */
function summariseInput(input: unknown): string {
	const i = (input ?? {}) as Record<string, unknown>;
	const raw = [i.command, i.cmd, i.script, i.path]
		.concat([i.filePath, i.file, i.targetFile])
		.find((v): v is string => typeof v === "string");
	const oneLine = (raw ?? "").replace(/\s+/g, " ").trim();
	return oneLine.length > SUMMARY_MAX_CHARS
		? `${oneLine.slice(0, SUMMARY_MAX_CHARS)}…`
		: oneLine;
}

const summariseAction = (a: AutoApprovedAction): string =>
	summariseInput(a.input);

/** What a session needs from the server; all optional for unit tests. */
export interface SessionDeps {
	config?: Config;
	/** Required to start a worker: where its private directory is created. */
	runtime?: RuntimeDir;
	/** The server's environment, the source of the worker's allowlisted env. */
	env?: NodeJS.ProcessEnv;
	/** Starts and kills worker processes; one per server. */
	children?: ChildRegistry;
	/** The agent this session runs; required to start it. */
	provider?: WorkerProvider;
	/** The server process, whose tag goes into approval ids. */
	boot?: Boot;
	/** Where this session's runs live; one per server. */
	runs?: RunStore;
	/** How long an aborted run may take to settle before it is forced. */
	abortGraceMs?: number;
	/** The caller's name for the worker; unique among live workers. */
	name?: string;
	/** The clock, for idle tracking. */
	now?: () => number;
	/** The classifiers, cache and audit file shared by the server's workers. */
	gateServices?: GateServices;
	/** Called once when the worker process is gone without being asked to. */
	onGone?: (session: Session) => void;
	/** The sandbox this worker runs in, as the manager decided. Default: none. */
	sandbox?: "none" | "workspace";
	/** What deciding the sandbox changed or warned about. */
	sandboxReport?: { clamped: string[]; notes: string[] };
	/** Run shell commands in the second sandbox (only with `workspace`). */
	toolIsolation?: boolean;
	/** Keep the conversation here (see `WorkerSpec.session`). */
	session?: { dir: string; id: string; mode?: "new" | "resume" };
	/** Set when the worker continues an earlier conversation. */
	resumed?: ResumedInfo;
}

/** A failure with a stable code, so the MCP tools can name it. */
export class RunError extends Error {
	override name = "RunError";
	constructor(
		readonly code:
			| "WORKER_BUSY"
			| "WORKER_NOT_RUNNING"
			| "APPROVAL_NOT_FOUND"
			| "RUN_START_FAILED",
		message: string,
		readonly runId?: string,
	) {
		super(message);
	}
}

interface PendingApproval {
	/** The server-made id the coordinator answers with. */
	id: string;
	call: RawToolCall;
	action: PendingAction;
	run: Run;
	outcome: GateOutcome | null;
	resolve: (d: ApprovalDecision) => void;
	timer: ReturnType<typeof setTimeout> | null;
	cancelled: boolean;
}

/** The run in flight and what the session needs to end it. */
interface ActiveRun {
	run: Run;
	abort: AbortController;
	repeat: RepeatCheck;
	/** Streamed text of the current assistant message. */
	turnOutput: string;
	/** Set when the run is being stopped for a reason: the state it ends in. */
	cause: { state: TerminalState; error?: string } | null;
	aborting: boolean;
	maxTimer: ReturnType<typeof setTimeout> | null;
	/** Run time left for `maxTimer` while it is paused for an approval. */
	maxRemainingMs: number;
	/** When `maxTimer` was last (re)started, to work out the time left. */
	maxStartedAt: number;
	graceTimer: ReturnType<typeof setTimeout> | null;
}

class StartTimeout extends Error {}

/**
 * One worker as the MCP tools see it: a status, at most one run in flight,
 * and the approvals the coordinator has to answer. The agent itself sits
 * behind the provider interface; this class holds no protocol. A run's state
 * and result live in the `RunStore`, so they outlive this session.
 */
export class Session {
	private static readonly MAX_LOG_LINES = 2000;
	private static readonly MAX_AUTO_APPROVED_SHOWN = 20;
	private static readonly MAX_AUTO_APPROVED_LOG = 500;
	private static readonly MAX_HISTORY = 500;

	/** The server-made worker id (`w_…`). */
	public sessionId: string;
	/** The name the caller gave the worker, if any. */
	public readonly name: string | undefined;
	public cwd: string;
	public model: string | undefined;
	public systemPrompt: string | undefined;
	public status: SessionStatus = "IDLE";
	private readonly logBuffer = new BoundedLog(Session.MAX_LOG_LINES);
	/** Messages of the conversation: the prompts and the assistant's replies. */
	public history: unknown[] = [];
	public autoApprovedActions: AutoApprovedAction[] = [];
	/** Total auto-approved so far, and how many of those a result has reported. */
	private autoApprovedTotal = 0;
	private autoApprovedReported = 0;
	/** Calls the policy denied outright, reported once like auto-approvals. */
	private autoDenied: string[] = [];
	private readonly approvalGate: ApprovalGate;
	/** What happened to the policy given at spawn: clamped, converted. */
	public readonly policyReport: PolicyReport | null;
	/** How the worker is confined; fixed at spawn. */
	public readonly sandbox: "none" | "workspace";
	private readonly toolIsolation: boolean;
	private readonly sessionSpec:
		| { dir: string; id: string; mode?: "new" | "resume" }
		| undefined;
	/** What was found when the worker was resumed, or null for a new one. */
	public readonly resumed: ResumedInfo | null;
	/** The server's note for the first prompt of a resumed worker, until it is sent. */
	private pendingNote: string | undefined;
	/** The run the repeat guard ends with: the first run that carried the note. */
	private guardRunId: string | undefined;
	/** What the server changed or warned about when it chose the sandbox. */
	public readonly sandboxReport: { clamped: string[]; notes: string[] };

	private worker: OpenedWorker | null = null;
	private alive = false;
	/** Approvals waiting for the coordinator, oldest first. */
	private readonly pending = new Map<string, PendingApproval>();
	/** Provider call id to approval id, for the gate log (bounded). */
	private readonly approvalByCall = new Map<string, string>();
	private currentRun: ActiveRun | null = null;
	private terminating = false;

	private readonly config: Config;
	private readonly runtime: RuntimeDir | undefined;
	private readonly processEnv: NodeJS.ProcessEnv;
	private readonly children: ChildRegistry;
	private readonly provider: WorkerProvider | undefined;
	readonly runs: RunStore;
	private readonly boot: Boot;
	private readonly abortGraceMs: number;
	private readonly now: () => number;
	private readonly onGone: ((session: Session) => void) | undefined;
	/** When the worker last had nothing to do (epoch ms). */
	private lastActiveAt: number;
	private goneReported = false;
	private starting = false;

	constructor(
		sessionId: string,
		cwd: string,
		model?: string,
		systemPrompt?: string,
		riskPolicy?: unknown,
		deps: SessionDeps = {},
	) {
		this.config = deps.config ?? defaultConfig();
		this.runtime = deps.runtime;
		this.processEnv = deps.env ?? {};
		this.children =
			deps.children ??
			new ChildRegistry({ env: this.processEnv, envConfig: this.config.env });
		this.provider = deps.provider;
		this.boot = deps.boot ?? new Boot();
		this.runs = deps.runs ?? runStoreFor(this.config, this.boot);
		this.abortGraceMs = deps.abortGraceMs ?? 3000;
		this.now = deps.now ?? Date.now;
		this.onGone = deps.onGone;
		this.sandbox = deps.sandbox ?? "none";
		this.toolIsolation = deps.toolIsolation ?? false;
		this.sessionSpec = deps.session;
		this.resumed = deps.resumed ?? null;
		this.pendingNote = deps.resumed?.note;
		this.sandboxReport = deps.sandboxReport ?? { clamped: [], notes: [] };
		this.lastActiveAt = this.now();
		this.name = deps.name;
		this.sessionId = sessionId;
		this.cwd = cwd;
		this.model = model;
		this.systemPrompt = systemPrompt;
		const services = deps.gateServices;
		const gateConfig = this.config.gate;
		this.approvalGate = new ApprovalGate({
			cwd,
			workerId: sessionId,
			bootId: this.boot.id,
			model,
			mode: gateConfig.mode,
			classifiers: services?.classifiers,
			classifierAllowCeiling:
				RiskLevel[gateConfig.httpAllowCeiling] ?? RiskLevel.HIGH,
			onClassifierFailure: gateConfig.onClassifierFailure,
			cache: services?.cache,
			configVersion: services?.configVersion,
			recentActions: gateConfig.recentActions,
			audit: services?.audit,
			secretFiles: gateConfig.classifiers.flatMap((c) =>
				c.tokenFile === undefined ? [] : [c.tokenFile],
			),
			home: this.processEnv.HOME || undefined,
			maxAutoApprove:
				RiskLevel[this.config.gate.maxAutoApprove] ?? DEFAULT_MAX_AUTO_APPROVE,
			policy: DEFAULT_RISK_POLICY,
			protected: {
				stateDir: this.config.stateDir,
				runtimeDir: this.config.runtimeDir,
				extra: [
					...this.config.gate.protectedPaths,
					// An audit file outside the state directory is protected too.
					...(this.config.audit.enabled ? [this.config.audit.file] : []),
				],
			},
		});
		this.policyReport =
			riskPolicy === undefined ? null : this.applyRiskPolicy(riskPolicy);
		this.log(`Session initialized for directory: ${cwd}`);
	}

	/** Payload-carrying lines (tool inputs, worker text): only at `debug`. */
	private debug(message: string) {
		if (debugEnabled()) this.log(`[debug] ${message}`);
	}

	private log(message: string) {
		const timestamp = new Date().toISOString();
		const formatted = `[${timestamp}] ${message}`;
		// Bounded, so a long-lived session cannot grow without limit.
		this.logBuffer.push(formatted);
		console.error(`[Session ${this.sessionId}] ${formatted}`);
	}

	/** Append to the conversation history, which keeps only the newest entries. */
	private remember(entry: unknown): void {
		this.history.push(entry);
		if (this.history.length > Session.MAX_HISTORY) {
			this.history.splice(0, this.history.length - Session.MAX_HISTORY);
		}
	}

	/** Recent log lines of this worker, newest last. */
	public get logs(): string[] {
		return this.logBuffer.lines;
	}

	/** Approvals waiting for the coordinator, oldest first. Never null. */
	public get pendingActions(): PendingAction[] {
		return [...this.pending.values()].map((p) => p.action);
	}

	/** The first pending approval, which is the one the coordinator sees. */
	public get pendingAction(): PendingAction | null {
		return this.pendingActions[0] ?? null;
	}

	public hasPendingApproval(approvalId: string): boolean {
		return this.pending.has(approvalId);
	}

	/**
	 * When the worker became idle, or null while it is busy: running, waiting
	 * for an approval or not alive.
	 */
	public idleSince(): number | null {
		if (!this.alive || this.currentRun || this.pending.size > 0) return null;
		return this.lastActiveAt;
	}

	private reportGone(): void {
		if (this.goneReported) return;
		this.goneReported = true;
		this.onGone?.(this);
	}

	/** The run in flight, if any. */
	public get activeRun(): Run | null {
		return this.currentRun?.run ?? null;
	}

	/** Pids of the worker's processes now running. */
	public processIds(): number[] {
		return this.worker?.host.pids() ?? [];
	}

	/** `start()` is in progress: the worker is not alive yet but is taken. */
	public isStarting(): boolean {
		return this.starting;
	}

	public async start(): Promise<void> {
		this.starting = true;
		try {
			await this.open();
		} finally {
			this.starting = false;
		}
	}

	private async open(): Promise<void> {
		if (!this.provider) {
			throw new Error("Cannot start a worker: no provider was given.");
		}
		if (!this.runtime) {
			throw new Error(
				"Cannot start a worker: no runtime directory was provided.",
			);
		}
		this.log(`Opening a ${this.provider.id} worker in: ${this.cwd}`);
		try {
			this.worker = await openWorker({
				provider: this.provider,
				spec: {
					workerId: this.sessionId,
					cwd: this.cwd,
					model: this.model,
					systemPrompt: this.systemPrompt,
					options: {},
					session: this.sessionSpec,
				},
				children: this.children,
				runtime: this.runtime,
				policy: {
					sandbox: this.sandbox,
					allowUngatedInSandbox: false,
					toolIsolation: this.toolIsolation,
				},
				emit: (event) => this.onEvent(event),
				approve: (call, signal) => this.approve(call, signal),
				log: {
					debug: (m) => this.debug(m),
					info: (m) => this.log(m),
					warn: (m) => this.log(`[warn] ${m}`),
					error: (m) => this.log(`[error] ${m}`),
				},
			});
		} catch (e) {
			this.status = "CRASHED";
			this.log(`Failed to start: ${describeError(e)}`);
			throw e;
		}
		this.alive = true;
		this.status = "IDLE";
		this.lastActiveAt = this.now();
	}

	// ---- events from the provider ------------------------------------------------

	private onEvent(event: WorkerEvent): void {
		if (this.terminating) return;
		const active = this.currentRun;
		const mine =
			active !== null && "runId" in event && event.runId === active.run.id;
		switch (event.type) {
			case "run_started":
				if (mine) this.runs.setState(active.run, "running");
				return;
			case "text_delta":
				if (mine) this.onDelta(active, event.text);
				return;
			case "assistant_message":
				if (mine) {
					active.turnOutput = "";
					active.repeat.reset();
					this.runs.addOutput(active.run, event.text);
					this.remember({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: event.text }],
						},
					});
				}
				return;
			case "tool_started":
				this.log(`[tool] ${event.toolName} started`);
				this.debug(`[tool] ${event.toolName} input: ${safeJson(event.input)}`);
				if (mine) {
					const what = summariseInput(event.input);
					this.runs.addActivity(
						active.run,
						what ? `${event.toolName}: ${what}` : event.toolName,
					);
				}
				return;
			case "notice":
				if (event.trusted) {
					this.log(`[${event.level}] ${event.text}`);
				} else {
					// Not marked trusted, so it may hold the worker's words: its size at info, the text at debug.
					this.log(
						`[${event.level}] notice from the worker (${event.text.length} characters)`,
					);
					this.debug(`[${event.level}] ${event.text}`);
				}
				return;
			case "run_finished":
				if (mine) this.onRunFinished(active, event);
				return;
			case "exited":
				this.onExited(event);
				return;
			default:
		}
	}

	/** Streamed text: bounded in size, and checked for a worker stuck repeating. */
	private onDelta(active: ActiveRun, text: string): void {
		active.turnOutput += text;
		if (active.turnOutput.length > this.config.limits.maxOutputChars) {
			this.log("[WARNING] Output size limit reached. Aborting the run...");
			this.abortWith(active, {
				state: "failed",
				error: `output limit exceeded: one message passed ${this.config.limits.maxOutputChars} characters`,
			});
			return;
		}
		if (active.repeat.feed(text)) {
			this.log("[WARNING] Repeated output detected. Aborting the run...");
			this.abortWith(active, {
				state: "failed",
				error: "repeated output: the worker kept writing the same line",
			});
		}
	}

	private onRunFinished(
		active: ActiveRun,
		event: Extract<WorkerEvent, { type: "run_finished" }>,
	): void {
		const run = active.run;
		if (run.output.total === 0 && event.finalText) {
			this.runs.addOutput(run, event.finalText);
		}
		const usage = event.usage;
		if (event.outcome === "error") {
			this.log(
				`Run ${run.id} failed (${(event.error ?? "").length} characters of error text)`,
			);
			this.debug(`Run ${run.id} failed: ${event.error}`);
			this.finish(active, "failed", {
				error: event.error ?? "the run failed",
				usage,
			});
			return;
		}
		// A run that was stopped for a reason ends with that reason, unless the
		// worker finished on its own anyway after a plain cancel.
		const cause = active.cause;
		if (event.outcome === "aborted") {
			const c = cause ?? { state: "cancelled" as const };
			this.finish(active, c.state, { error: c.error, usage });
			return;
		}
		if (cause && cause.state !== "cancelled") {
			this.finish(active, cause.state, { error: cause.error, usage });
			return;
		}
		this.log("Agent settled.");
		this.finish(active, "completed", { usage });
	}

	private onExited(event: Extract<WorkerEvent, { type: "exited" }>): void {
		this.alive = false;
		this.worker = null;
		if (event.expected) {
			this.status = "FINISHED";
			this.log(`Process terminated on request (exit code: ${event.code}).`);
		} else if (event.code !== 0 && event.code !== null) {
			this.status = "CRASHED";
			this.log(`Process exited with non-zero code: ${event.code}`);
		} else if (event.signal) {
			this.status = "CRASHED";
			this.log(`Process was killed by ${event.signal}.`);
		} else {
			this.status = "FINISHED";
			this.log("Process completed and exited successfully.");
		}
		const active = this.currentRun;
		if (active) {
			// The run's own error normally got here first; this covers the rest.
			if (event.expected) {
				this.finish(active, "cancelled", { error: "worker closed" });
			} else {
				this.finish(active, "failed", {
					error: `Worker exited unexpectedly (${this.describeExit(event)})`,
				});
			}
		}
		this.dropPending("the worker ended before the call was answered");
		this.runs.workerClosed(this.sessionId);
		// A worker that is gone is not kept in the list or counted against the
		// limit; its runs stay readable.
		this.reportGone();
	}

	private describeExit(e: { code: number | null; signal: string | null }) {
		return e.signal ? `killed by signal ${e.signal}` : `code ${e.code}`;
	}

	// ---- ending a run ------------------------------------------------------------

	/**
	 * Settle the run once and tidy up: timers, approvals, status. Returns false
	 * when it had already ended.
	 */
	private finish(
		active: ActiveRun,
		state: TerminalState,
		fields: { error?: string; usage?: Usage } = {},
	): boolean {
		let usage = fields.usage;
		if (usage && !this.config.usage.reportCost) {
			const { costUsd: _cost, ...tokens } = usage;
			usage = tokens;
		}
		if (!this.runs.settle(active.run, state, { ...fields, usage })) {
			return false;
		}
		if (active.maxTimer) clearTimeout(active.maxTimer);
		if (active.graceTimer) clearTimeout(active.graceTimer);
		if (this.currentRun === active) this.currentRun = null;
		// The repeat guard ends with the first resumed run: by then the
		// coordinator has seen the note and the cut-off calls.
		if (this.guardRunId === active.run.id) {
			this.guardRunId = undefined;
			this.approvalGate.disarmRepeatGuard();
		}
		this.dropPending("the run ended before the call was answered");
		if (this.alive && !this.terminating) this.status = "IDLE";
		this.lastActiveAt = this.now();
		return true;
	}

	/** Start (or restart) the run limit timer with the time left. */
	private armRunTimer(active: ActiveRun): void {
		const maxRunMs = this.config.limits.maxRunMs;
		active.maxStartedAt = Date.now();
		active.maxTimer = setTimeout(
			() =>
				this.abortWith(active, {
					state: "timed_out",
					error: `the run exceeded the ${maxRunMs} ms limit and was aborted`,
				}),
			active.maxRemainingMs,
		);
		active.maxTimer.unref?.();
	}

	/**
	 * The run limit does not count time spent waiting for the coordinator
	 * (each wait is bounded by the approval timeout): stop the timer while
	 * a call awaits approval.
	 */
	private pauseRunTimer(active: ActiveRun): void {
		if (!active.maxTimer) return;
		clearTimeout(active.maxTimer);
		active.maxTimer = null;
		active.maxRemainingMs = Math.max(
			1,
			active.maxRemainingMs - (Date.now() - active.maxStartedAt),
		);
	}

	private resumeRunTimer(active: ActiveRun): void {
		if (active.maxTimer || active.run.terminal || active.aborting) return;
		this.armRunTimer(active);
	}

	/**
	 * Stop the run for `cause`: tell the worker to abort and end the run in the
	 * cause's state when it does. A worker that ignores the abort is forced:
	 * the run ends anyway and the wedged worker is closed.
	 */
	private abortWith(
		active: ActiveRun,
		cause: { state: TerminalState; error?: string },
	): void {
		if (active.run.terminal) return;
		active.cause ??= cause;
		if (active.aborting) return;
		active.aborting = true;
		this.log(`Run ${active.run.id} abort requested (${active.cause.state}).`);
		active.abort.abort();
		this.worker?.handle.abortRun("abort requested").catch((err) => {
			this.log(`Failed to abort: ${describeError(err)}`);
		});
		active.graceTimer = setTimeout(() => {
			const c = active.cause ?? cause;
			if (this.finish(active, c.state, { error: c.error })) {
				this.log("The worker did not settle after the abort; closing it.");
				void this.closeWedged();
			}
		}, this.abortGraceMs);
		active.graceTimer.unref?.();
	}

	/** A worker that cannot be stopped or does not answer is closed. */
	private async closeWedged(): Promise<void> {
		await this.terminate();
		this.status = "CRASHED";
		this.reportGone();
	}

	// ---- approvals ---------------------------------------------------------------

	/** The provider asks whether a tool call may run. */
	private approve(
		call: RawToolCall,
		signal: AbortSignal,
	): Promise<ApprovalDecision> {
		// Made now so the gate's records carry it if the call is escalated.
		const approvalId = this.boot.approvalId();
		const decided = this.approvalGate.decide(
			{
				provider: this.provider?.id ?? "unknown",
				toolName: call.toolName,
				input: call.input,
				depth: call.origin?.depth,
			},
			call.callId,
			{
				runId: this.currentRun?.run.id,
				intent: this.currentRun?.run.intent,
				approvalId,
				signal,
			},
		);
		return Promise.resolve(decided).then((outcome) =>
			this.applyOutcome(call, outcome, signal, approvalId),
		);
	}

	private applyOutcome(
		call: RawToolCall,
		outcome: GateOutcome,
		signal: AbortSignal,
		approvalId: string,
	): Promise<ApprovalDecision> {
		const label = RISK_LABELS[outcome.level];
		const message = JSON.stringify({
			toolName: call.toolName,
			input: call.input,
		});
		const run = this.currentRun?.run;
		const line = `${outcome.call.rawName} [${label}] ${summariseInput(outcome.call.input)}`;
		if (outcome.decision === "allow") {
			this.log(
				`[AUTO-APPROVED] [${label}] ${call.toolName} call ${call.callId} input ${shortDigest(call.input)}`,
			);
			this.debug(
				`[AUTO-APPROVED] call ${call.callId}: ${message} (${outcome.reason})`,
			);
			// A LOW call the rules allowed is only counted; anything else the
			// gate let through unasked is listed with who allowed it.
			const flagged =
				outcome.level > RiskLevel.LOW ||
				outcome.decidedBy !== "rules" ||
				outcome.matchedOverride !== undefined;
			run?.noteGate(
				"allowed",
				`${outcome.call.rawName} [${label}] allowed by ${outcome.decidedBy}${outcome.matchedOverride ? ` (${outcome.matchedOverride})` : ""}: ${summariseInput(outcome.call.input)}`,
				undefined,
				flagged,
			);
			this.autoApprovedTotal++;
			this.autoApprovedActions.push({
				actionId: call.callId,
				runId: run?.id,
				toolName: outcome.call.rawName,
				input: outcome.call.input,
				riskLevel: outcome.level,
				riskLabel: label,
				reason: outcome.reason,
				timestamp: new Date().toISOString(),
				matchedOverride: outcome.matchedOverride,
			});
			if (this.autoApprovedActions.length > Session.MAX_AUTO_APPROVED_LOG) {
				this.autoApprovedActions.splice(
					0,
					this.autoApprovedActions.length - Session.MAX_AUTO_APPROVED_LOG,
				);
			}
			return Promise.resolve({ kind: "allow" });
		}
		if (outcome.decision === "deny") {
			this.log(
				`[AUTO-DENIED] [${label}] ${call.toolName} call ${call.callId} input ${shortDigest(call.input)}`,
			);
			this.debug(
				`[AUTO-DENIED] call ${call.callId}: ${message} (${outcome.reason})`,
			);
			run?.noteGate("denied", `${line}: ${outcome.reason}`);
			if (this.autoDenied.length < Session.MAX_AUTO_APPROVED_SHOWN) {
				this.autoDenied.push(`${outcome.call.rawName}: ${outcome.reason}`);
			}
			return Promise.resolve({ kind: "deny", reason: outcome.reason });
		}
		if (!run) {
			return Promise.resolve({
				kind: "deny",
				reason: "there is no active run to ask about",
			});
		}
		return this.escalate(call, message, outcome, run, signal, approvalId);
	}

	/**
	 * Hold a tool call for the coordinator until it is answered, cancelled or
	 * the approval timeout passes (then it is denied).
	 */
	private escalate(
		call: RawToolCall,
		message: string,
		outcome: GateOutcome,
		run: Run,
		signal: AbortSignal,
		id: string,
	): Promise<ApprovalDecision> {
		const label = RISK_LABELS[outcome.level];
		this.approvalByCall.set(call.callId, id);
		if (this.approvalByCall.size > 500) {
			const oldest = this.approvalByCall.keys().next().value;
			if (oldest !== undefined) this.approvalByCall.delete(oldest);
		}
		return new Promise((resolve) => {
			const paths = outcome.call.paths.map((p) => ({
				path: p.abs,
				inWorkspace: p.inWorkspace,
				protected: p.protected !== undefined,
			}));
			const action: PendingAction = {
				actionId: id,
				runId: run.id,
				tool: call.toolName,
				kind: outcome.call.kind,
				command: outcome.call.command,
				paths,
				riskLevel: outcome.level,
				riskLabel: label,
				reason: outcome.reason,
				hardLimit: !outcome.autoAllowable,
			};
			const timeoutMs = this.config.gate.approvalTimeoutMs;
			const entry: PendingApproval = {
				id,
				call,
				action,
				run,
				outcome,
				resolve,
				timer: null,
				cancelled: false,
			};
			entry.timer = setTimeout(
				() =>
					this.cancelPending(
						id,
						`approval timed out: the coordinator did not answer within ${Math.round(timeoutMs / 1000)} s`,
						"timeout",
					),
				timeoutMs,
			);
			entry.timer.unref?.();
			this.pending.set(id, entry);
			if (this.currentRun?.run === run) this.pauseRunTimer(this.currentRun);
			signal.addEventListener(
				"abort",
				() => this.cancelPending(id, "the run was aborted"),
				{ once: true },
			);
			if (signal.aborted) {
				this.cancelPending(id, "the run was aborted");
				return;
			}
			this.log(
				`[INTERCEPTED] [${label}] ${call.toolName} action ${id} (call ${call.callId}, input ${shortDigest(call.input)}) awaiting coordinator approval`,
			);
			this.debug(`[INTERCEPTED] action ${id}: ${message}`);
			run.noteGate(
				"escalated",
				`${call.toolName} [${label}] ${summariseInput(call.input)}`,
				id,
			);
			this.status = "AWAITING_APPROVAL";
			this.runs.addApproval(
				run,
				{
					actionId: id,
					tool: call.toolName,
					kind: outcome.call.kind,
					command: outcome.call.command,
					paths,
					riskLevel: outcome.level,
					riskLabel: label,
					reason: outcome.reason,
					hardLimit: !outcome.autoAllowable,
					escalatedBecause: outcome.escalatedBecause,
					consulted: outcome.consulted
						.filter((c) => c.by !== "rules")
						.map((c) => ({
							by: c.by,
							verdict: c.verdict,
							confidence: c.confidence,
							reason: c.reason,
							cached: c.cached,
							error: c.error,
						})),
					expiresAt: Date.now() + timeoutMs,
				},
				`awaiting approval: ${call.toolName} [${label}]`,
			);
		});
	}

	/** An approval ended without the coordinator: record it and deny the call. */
	private cancelPending(
		actionId: string,
		reason: string,
		by: "cancel" | "timeout" = "cancel",
	): void {
		const entry = this.pending.get(actionId);
		if (!entry || entry.cancelled) return;
		entry.cancelled = true;
		if (entry.timer) clearTimeout(entry.timer);
		this.pending.delete(actionId);
		this.approvalGate.recordResolution(entry.call.callId, "deny", by, reason);
		this.runs.removeApproval(entry.run, actionId, by === "timeout", {
			decision: by === "timeout" ? "expired" : "cancelled",
			by,
		});
		entry.resolve({ kind: "deny", reason });
		this.afterPendingChanged();
	}

	/** Pending approvals are gone without an answer: record them as cancelled. */
	private dropPending(reason: string) {
		for (const id of this.pending.keys()) this.cancelPending(id, reason);
	}

	private afterPendingChanged(): void {
		if (this.pending.size === 0 && this.currentRun) {
			this.resumeRunTimer(this.currentRun);
		}
		if (this.pending.size === 0 && this.status === "AWAITING_APPROVAL") {
			this.status = this.currentRun ? "RUNNING" : "IDLE";
		}
	}

	// ---- reporting -----------------------------------------------------------------

	/**
	 * Append the actions auto-approved since the last result, so the caller sees
	 * what ran without asking. Each action is reported once.
	 */
	private takeAutoApprovedNotes(runId: string): string {
		const denied = this.takeAutoDeniedNotes(runId);
		const unreported = this.autoApprovedTotal - this.autoApprovedReported;
		this.autoApprovedReported = this.autoApprovedTotal;
		if (unreported <= 0) return denied;
		const entries = this.autoApprovedActions.slice(-unreported);
		const shown = entries.slice(0, Session.MAX_AUTO_APPROVED_SHOWN);
		const lines = shown.map(
			(a) => `- ${a.toolName} [${a.riskLabel}] ${summariseAction(a)}`,
		);
		if (unreported > shown.length) {
			lines.push(`- ... and ${unreported - shown.length} more`);
		}
		return `${denied}\n\nAuto-approved without asking (${unreported}):\n${wrapUntrusted(runId, lines.join("\n"))}`;
	}

	private takeAutoDeniedNotes(runId: string): string {
		if (this.autoDenied.length === 0) return "";
		const lines = this.autoDenied.map((d) => `- ${d}`);
		this.autoDenied = [];
		return `\n\nDenied by the risk policy without asking (${lines.length}):\n${wrapUntrusted(runId, lines.join("\n"))}`;
	}

	public getAutoApprovedLog(): AutoApprovedAction[] {
		return [...this.autoApprovedActions];
	}

	/** Every gate decision for this worker, newest last (a bounded ring). */
	public getGateLog() {
		return this.approvalGate.log.entries();
	}

	/** The `a_…` approval id for a provider call id, when it was escalated. */
	public approvalIdFor(providerCallId: string | undefined): string | undefined {
		return providerCallId === undefined
			? undefined
			: this.approvalByCall.get(providerCallId);
	}

	/** The policy in force, after any ceiling clamp. */
	public get riskPolicy(): RiskPolicy {
		return this.approvalGate.policy;
	}

	/**
	 * Replace the policy. It is lowered to the server's
	 * ceiling; the result says what was lowered. Throws on an invalid policy.
	 */
	public applyRiskPolicy(input: unknown): PolicyReport {
		const normalized = normalizePolicy(input);
		const { policy, clamped } = this.approvalGate.setPolicy(normalized.policy);
		return {
			policy,
			clamped,
		};
	}

	/** The kept conversation this worker belongs to, when it is kept. */
	public get lineage(): string | undefined {
		return this.sessionSpec?.id;
	}

	/** The id of the provider this worker runs on. */
	public get providerId(): string {
		return this.provider?.id ?? "unknown";
	}

	public get capabilities() {
		return this.provider?.capabilities;
	}

	/** Whether a worker process is actually attached to this session. */
	public isAlive(): boolean {
		return this.alive;
	}

	// ---- runs --------------------------------------------------------------------

	/**
	 * Give the worker a task. Resolves once the worker accepted it, not when it
	 * finishes; follow the run through the store. Fails with `WORKER_BUSY` when
	 * a run is already going (its id is on the error) and with
	 * `WORKER_NOT_RUNNING` when no process is attached.
	 */
	public async startRun(prompt: string, intent?: string): Promise<Run> {
		// Reported before the busy check so a session whose worker is gone says
		// what to do instead of failing with "Process not running".
		if (!this.isAlive() || !this.worker) {
			throw new RunError(
				"WORKER_NOT_RUNNING",
				`Session ${this.sessionId} has no running pi process (status: ${this.status}). Respawn it with spawn_worker.`,
			);
		}
		if (this.currentRun) {
			throw new RunError(
				"WORKER_BUSY",
				`Cannot send command when session status is ${this.status}. It is running ${this.currentRun.run.id}: call wait_run with that runId, or cancel_run to stop it.`,
				this.currentRun.run.id,
			);
		}
		const worker = this.worker;
		const run = this.runs.create(this.sessionId, prompt, intent, {
			workerName: this.name,
			provider: this.providerId,
			model: this.model,
			cwd: this.cwd,
			lineage: this.sessionSpec?.id,
		});
		const active: ActiveRun = {
			run,
			abort: new AbortController(),
			repeat: new RepeatCheck(),
			turnOutput: "",
			cause: null,
			aborting: false,
			maxTimer: null,
			maxRemainingMs: 0,
			maxStartedAt: 0,
			graceTimer: null,
		};
		this.currentRun = active;
		this.status = "RUNNING";
		this.remember({
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: prompt }] },
		});
		active.maxRemainingMs = this.config.limits.maxRunMs;
		this.armRunTimer(active);

		const note = this.pendingNote;
		if (note !== undefined && this.resumed) {
			// Calls that may have run before the restart need a new decision to
			// run again; calls that never ran (awaiting approval) do not.
			this.approvalGate.armRepeatGuard(
				this.resumed.interrupted
					.filter((c) => c.status !== "awaiting_approval")
					.map((c) => c.digest),
			);
		}
		const startMs = this.config.limits.runStartTimeoutMs;
		let startTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				worker.handle.startRun({
					runId: run.id,
					// A resumed worker's first prompt starts with the server's note.
					prompt: note === undefined ? prompt : `${note}\n\n${prompt}`,
					signal: active.abort.signal,
				}),
				new Promise<never>((_, reject) => {
					startTimer = setTimeout(
						() =>
							reject(
								new StartTimeout(
									`the worker did not accept the prompt within ${startMs} ms`,
								),
							),
						startMs,
					);
				}),
			]);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.finish(active, "failed", { error: message });
			// A worker that never acknowledges is wedged: do not leave it behind.
			if (e instanceof StartTimeout) void this.closeWedged();
			throw new RunError("RUN_START_FAILED", message, run.id);
		} finally {
			clearTimeout(startTimer);
		}
		// The worker has the note now (and its session holds it): not again.
		this.pendingNote = undefined;
		if (note !== undefined) this.guardRunId = run.id;
		// An approval or a quick finish may already have moved the run on.
		if (run.state === "starting") this.runs.setState(run, "running");
		return run;
	}

	/** Stop the run in flight, if any. Idempotent. */
	public cancelRun(): void {
		const active = this.currentRun;
		if (active) this.abortWith(active, { state: "cancelled" });
	}

	/** Abort the currently running command without terminating the session. */
	public abortCommand(): void {
		this.cancelRun();
	}

	/**
	 * Answer a pending approval. Returns at once; follow the run to see what
	 * the worker does next.
	 */
	private answer(
		actionId: string,
		decision: ApprovalDecision,
		resolution: "allow" | "deny",
		note: string,
	): Run {
		const entry = this.pending.get(actionId);
		if (!entry) {
			throw new RunError(
				"APPROVAL_NOT_FOUND",
				`No pending approval ${actionId}: it was already answered, expired or never existed. Call get_pending_actions to see what is waiting.`,
			);
		}
		this.approvalGate.recordResolution(
			entry.call.callId,
			resolution,
			"coordinator",
			note,
		);
		if (entry.timer) clearTimeout(entry.timer);
		this.pending.delete(actionId);
		this.runs.removeApproval(entry.run, actionId, false, {
			decision: resolution === "allow" ? "approved" : "rejected",
			by: "coordinator",
		});
		this.afterPendingChanged();
		entry.resolve(decision);
		return entry.run;
	}

	/**
	 * Keep an allow for the call behind a pending approval, so an identical
	 * call from this worker is allowed without asking until it closes or its
	 * policy changes. False when the call may not be remembered (a hard limit,
	 * a protected path or CRITICAL), or when there is no such approval.
	 */
	public rememberApproval(actionId: string): boolean {
		const outcome = this.pending.get(actionId)?.outcome;
		return outcome ? this.approvalGate.remember(outcome) : false;
	}

	public approveAction(actionId: string): Run {
		this.log(`Approving action ${actionId}`);
		return this.answer(
			actionId,
			{ kind: "allow" },
			"allow",
			"approved by the coordinator",
		);
	}

	public rejectAction(actionId: string, reason?: string): Run {
		this.log(
			`Rejecting action ${actionId} (${reason ? `reason of ${reason.length} characters` : "no reason"})`,
		);
		this.debug(`Rejecting action ${actionId} with reason: ${reason || "none"}`);
		return this.answer(
			actionId,
			{
				kind: "deny",
				reason: reason || "Tool execution blocked by the coordinator agent.",
			},
			"deny",
			"rejected by the coordinator",
		);
	}

	// ---- the text view -------------------------------------------------

	/**
	 * Wait for the run to end or need an approval and describe it as text.
	 * Returns null when `timeoutMs` passes or `signal` aborts first; the run
	 * carries on either way.
	 */
	public async waitText(
		run: Run,
		opts: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<string | null> {
		const deadline =
			opts.timeoutMs === undefined ? Infinity : Date.now() + opts.timeoutMs;
		// The first pass wakes for any approval already pending; later passes
		// only for a new one.
		let since = 0;
		for (;;) {
			const left = deadline - Date.now();
			if (left <= 0) return null;
			const reason = await this.runs.waitForChange(run, {
				sinceSeq: since,
				maxWaitMs: Math.min(left, this.runs.maxWaitMs),
				signal: opts.signal,
			});
			if (reason === "terminal" || reason === "approval") break;
			if (reason === "detached") return null;
			since = run.seq;
		}
		return this.describeRun(run);
	}

	private describeRun(run: Run): string {
		if (run.terminal) {
			if (run.state === "failed" || run.state === "timed_out") {
				throw new Error(run.error ?? `the run ${run.state}`);
			}
			if (run.state === "cancelled" && run.error) return "Process terminated";
			this.log("Agent settled.");
			const notes = this.takeAutoApprovedNotes(run.id);
			const fullOutput = run.output.all;
			const body = fullOutput
				? wrapUntrusted(run.id, fullOutput)
				: "Agent finished task run successfully.";
			return `${body}${notes}`;
		}
		const p = this.pendingAction;
		if (!p) return `RUNNING: ${run.id} is still ${run.state}.`;
		const hard = p.hardLimit ? " Hard limit: only you can allow this." : "";
		const detail = [
			`Tool: ${wrapUntrusted(run.id, p.tool)} (${p.kind})`,
			p.command === undefined
				? null
				: `Command: ${wrapUntrusted(run.id, p.command)}`,
			p.paths.length === 0
				? null
				: `Paths: ${p.paths.map((x) => `${wrapUntrusted(run.id, x.path)}${x.protected ? " (protected)" : x.inWorkspace ? "" : " (outside the workspace)"}`).join(", ")}`,
		]
			.filter((x) => x !== null)
			.join(". ");
		return `AWAITING_APPROVAL: [${p.riskLabel ?? "UNKNOWN"} RISK] Intercepted tool call. Action ID: ${p.actionId}. ${detail}.${hard}${this.takeAutoApprovedNotes(run.id)}\n\nRun: ${run.id}. approve_action and reject_action return at once; call wait_run with this runId to follow the run.`;
	}

	/**
	 * Stop the worker: SIGTERM, then SIGKILL for it and everything it started
	 * once the grace period is over. Resolves when the process is gone. Its run
	 * ends and stays readable. Idempotent.
	 */
	public async terminate(reason: "requested" | "shutdown" = "requested") {
		this.log("Terminating subprocess...");
		this.terminating = true;
		const worker = this.worker;
		this.worker = null;
		const wasAlive = this.alive;
		this.alive = false;
		if (wasAlive) this.status = "FINISHED";
		const active = this.currentRun;
		if (active) {
			active.abort.abort();
			if (reason === "shutdown") {
				this.finish(active, "failed", { error: "server shutting down" });
			} else {
				this.finish(active, "cancelled", { error: "worker terminated" });
			}
		}
		this.dropPending("the worker was terminated");
		this.approvalGate.forget();
		this.runs.workerClosed(this.sessionId);
		if (worker) await worker.close({ graceMs: 3000, reason });
	}
}

/** A store configured from the server's limits. */
export function runStoreFor(
	config: Config,
	boot?: Boot,
	sink?: RunSink,
): RunStore {
	return new RunStore({
		sink,
		newRunId: boot?.runId,
		retentionMs: config.limits.resultRetentionMs,
		maxRetained: config.limits.maxRetainedRuns,
		maxWaitMs: config.limits.maxWaitMs,
		outputBufferChars: config.limits.outputBufferChars,
	});
}
