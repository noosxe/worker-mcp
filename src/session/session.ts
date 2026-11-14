import { type Config, defaultConfig } from "../config.js";
import { ChildRegistry } from "../core/child.js";
import { type OpenedWorker, openWorker } from "../core/host.js";
import { RepeatCheck } from "../core/repeat-check.js";
import { type Run, RunStore, type TerminalState } from "../core/run.js";
import type { GateOutcome } from "../gate/classifier.js";
import {
	DEFAULT_MAX_AUTO_APPROVE,
	Gate as ApprovalGate,
} from "../gate/gate.js";
import {
	DEFAULT_RISK_POLICY,
	normalizePolicy,
	type NormalizedPolicy,
	type RiskPolicy,
} from "../gate/policy.js";
import { RISK_LABELS, RiskLevel } from "../gate/risk.js";
import type {
	ApprovalDecision,
	RawToolCall,
	Usage,
	WorkerEvent,
	WorkerProvider,
} from "../providers/types.js";
import { BoundedLog } from "./bounded-log.js";
import type { RuntimeDir } from "./runtime-dir.js";

export type SessionStatus =
	| "IDLE"
	| "RUNNING"
	| "AWAITING_APPROVAL"
	| "CRASHED"
	| "FINISHED";

export interface AutoApprovedAction {
	actionId: string;
	toolName: string;
	input: Record<string, unknown>;
	riskLevel: RiskLevel;
	riskLabel: string;
	reason: string;
	timestamp: string;
	/** The override pattern that triggered the auto-approval, if any */
	matchedOverride?: string;
}

export interface PolicyReport extends Pick<
	NormalizedPolicy,
	"converted" | "notes"
> {
	/** The policy now in force. */
	policy: RiskPolicy;
	/** What the server's ceiling lowered, one line each. */
	clamped: string[];
}

export interface PendingAction {
	actionId: string;
	tool: string;
	arguments: unknown;
	context: string;
	riskLevel?: RiskLevel;
	riskLabel?: string;
	/** Why the gate sent this to the coordinator. */
	reason?: string;
	/** A hard limit (a protected path): only the coordinator can allow it. */
	hardLimit?: boolean;
}

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
	/** Where this session's runs live; one per server. */
	runs?: RunStore;
	/** How long an aborted run may take to settle before it is forced. */
	abortGraceMs?: number;
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

	public sessionId: string;
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

	private worker: OpenedWorker | null = null;
	private alive = false;
	/** Approvals waiting for the coordinator, oldest first. */
	private readonly pending = new Map<string, PendingApproval>();
	private currentRun: ActiveRun | null = null;
	private terminating = false;
	/** Set when a call asked for `summarize`, which is deprecated and ignored. */
	private summarizeIgnored = false;

	private readonly config: Config;
	private readonly runtime: RuntimeDir | undefined;
	private readonly processEnv: NodeJS.ProcessEnv;
	private readonly children: ChildRegistry;
	private readonly provider: WorkerProvider | undefined;
	readonly runs: RunStore;
	private readonly abortGraceMs: number;

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
		this.runs = deps.runs ?? runStoreFor(this.config);
		this.abortGraceMs = deps.abortGraceMs ?? 3000;
		this.sessionId = sessionId;
		this.cwd = cwd;
		this.model = model;
		this.systemPrompt = systemPrompt;
		this.approvalGate = new ApprovalGate({
			cwd,
			workerId: sessionId,
			home: this.processEnv.HOME || undefined,
			maxAutoApprove:
				RiskLevel[this.config.gate.maxAutoApprove] ?? DEFAULT_MAX_AUTO_APPROVE,
			policy: DEFAULT_RISK_POLICY,
			protected: {
				stateDir: this.config.stateDir,
				runtimeDir: this.config.runtimeDir,
				extra: this.config.gate.protectedPaths,
			},
		});
		this.policyReport =
			riskPolicy === undefined ? null : this.applyRiskPolicy(riskPolicy);
		this.log(`Session initialized for directory: ${cwd}`);
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

	/** The first pending approval, which is the one the coordinator sees. */
	public get pendingAction(): PendingAction | null {
		for (const p of this.pending.values()) return p.action;
		return null;
	}

	/** The run in flight, if any. */
	public get activeRun(): Run | null {
		return this.currentRun?.run ?? null;
	}

	public async start(): Promise<void> {
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
				},
				children: this.children,
				runtime: this.runtime,
				policy: { sandbox: "none", allowUngatedInSandbox: false },
				emit: (event) => this.onEvent(event),
				approve: (call, signal) => this.approve(call, signal),
				log: {
					debug: (m) => this.log(`[debug] ${m}`),
					info: (m) => this.log(m),
					warn: (m) => this.log(`[warn] ${m}`),
					error: (m) => this.log(`[error] ${m}`),
				},
			});
		} catch (e) {
			this.status = "CRASHED";
			this.log(
				`Failed to start: ${e instanceof Error ? e.message : String(e)}`,
			);
			throw e;
		}
		this.alive = true;
		this.status = "IDLE";
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
				if (mine) {
					const what = summariseInput(event.input);
					this.runs.addActivity(
						active.run,
						what ? `${event.toolName}: ${what}` : event.toolName,
					);
				}
				return;
			case "notice":
				this.log(`[${event.level}] ${event.text}`);
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
			this.log(`Run failed: ${event.error}`);
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
	}

	private describeExit(e: { code: number | null; signal: string | null }) {
		return `code ${e.code}${e.signal ? `, signal ${e.signal}` : ""}`;
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
		if (!this.runs.settle(active.run, state, fields)) return false;
		if (active.maxTimer) clearTimeout(active.maxTimer);
		if (active.graceTimer) clearTimeout(active.graceTimer);
		if (this.currentRun === active) this.currentRun = null;
		this.dropPending("the run ended before the call was answered");
		if (this.alive && !this.terminating) this.status = "IDLE";
		return true;
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
			this.log(
				`Failed to abort: ${err instanceof Error ? err.message : String(err)}`,
			);
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
	}

	// ---- approvals ---------------------------------------------------------------

	/** The provider asks whether a tool call may run. */
	private approve(
		call: RawToolCall,
		signal: AbortSignal,
	): Promise<ApprovalDecision> {
		const decided = this.approvalGate.decide(
			{
				provider: this.provider?.id ?? "unknown",
				toolName: call.toolName,
				input: call.input,
				depth: call.origin?.depth,
			},
			call.callId,
		);
		return Promise.resolve(decided).then((outcome) =>
			this.applyOutcome(call, outcome, signal),
		);
	}

	private applyOutcome(
		call: RawToolCall,
		outcome: GateOutcome,
		signal: AbortSignal,
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
				`[AUTO-APPROVED] [${label}] Action ${call.callId}: ${message} (${outcome.reason})`,
			);
			run?.noteGate("allowed", line);
			this.autoApprovedTotal++;
			this.autoApprovedActions.push({
				actionId: call.callId,
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
				`[AUTO-DENIED] [${label}] Action ${call.callId}: ${message} (${outcome.reason})`,
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
		return this.escalate(call, message, outcome, run, signal);
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
	): Promise<ApprovalDecision> {
		const label = RISK_LABELS[outcome.level];
		return new Promise((resolve) => {
			const action: PendingAction = {
				actionId: call.callId,
				tool: "confirm",
				arguments: { title: "worker-mcp-gate", message },
				context:
					"A tool execution or high-risk operation requires supervisor consent.",
				riskLevel: outcome.level,
				riskLabel: label,
				reason: outcome.reason,
				hardLimit: !outcome.autoAllowable,
			};
			const timeoutMs = this.config.gate.approvalTimeoutMs;
			const entry: PendingApproval = {
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
						call.callId,
						`approval timed out: the coordinator did not answer within ${Math.round(timeoutMs / 1000)} s`,
						"timeout",
					),
				timeoutMs,
			);
			entry.timer.unref?.();
			this.pending.set(call.callId, entry);
			signal.addEventListener(
				"abort",
				() => this.cancelPending(call.callId, "the run was aborted"),
				{ once: true },
			);
			if (signal.aborted) {
				this.cancelPending(call.callId, "the run was aborted");
				return;
			}
			this.log(
				`[INTERCEPTED] [${label}] Action ${call.callId} awaiting coordinator approval: ${message}`,
			);
			run.noteGate(
				"escalated",
				`${call.toolName} [${label}] ${summariseInput(call.input)}`,
			);
			this.status = "AWAITING_APPROVAL";
			this.runs.addApproval(
				run,
				{
					actionId: call.callId,
					tool: call.toolName,
					summary: summariseInput(call.input),
					input: call.input,
					riskLevel: outcome.level,
					riskLabel: label,
					reason: outcome.reason,
					hardLimit: !outcome.autoAllowable,
					expiresAt: Date.now() + timeoutMs,
				},
				`awaiting approval: ${call.toolName} ${summariseInput(call.input)}`.trim(),
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
		this.approvalGate.recordResolution(actionId, "deny", by, reason);
		this.runs.removeApproval(entry.run, actionId, by === "timeout");
		entry.resolve({ kind: "deny", reason });
		this.afterPendingChanged();
	}

	/** Pending approvals are gone without an answer: record them as cancelled. */
	private dropPending(reason: string) {
		for (const id of this.pending.keys()) this.cancelPending(id, reason);
	}

	private afterPendingChanged(): void {
		if (this.pending.size === 0 && this.status === "AWAITING_APPROVAL") {
			this.status = this.currentRun ? "RUNNING" : "IDLE";
		}
	}

	// ---- reporting -----------------------------------------------------------------

	/**
	 * Append the actions auto-approved since the last result, so the caller sees
	 * what ran without asking. Each action is reported once.
	 */
	private takeAutoApprovedNotes(): string {
		const denied = this.takeAutoDeniedNotes();
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
		return `${denied}\n\nAuto-approved without asking (${unreported}):\n${lines.join("\n")}`;
	}

	private takeAutoDeniedNotes(): string {
		if (this.autoDenied.length === 0) return "";
		const lines = this.autoDenied.map((d) => `- ${d}`);
		this.autoDenied = [];
		return `\n\nDenied by the risk policy without asking (${lines.length}):\n${lines.join("\n")}`;
	}

	private takeSummarizeNote(): string {
		if (!this.summarizeIgnored) return "";
		this.summarizeIgnored = false;
		return "\n\nNote: `summarize` is deprecated and was ignored; the full output is returned.";
	}

	public getAutoApprovedLog(): AutoApprovedAction[] {
		return [...this.autoApprovedActions];
	}

	/** Every gate decision for this worker, newest last (a bounded ring). */
	public getGateLog() {
		return this.approvalGate.log.entries();
	}

	/** The policy in force, after any ceiling clamp. */
	public get riskPolicy(): RiskPolicy {
		return this.approvalGate.policy;
	}

	/**
	 * Replace the policy (v1 or v2 shape). It is lowered to the server's
	 * ceiling; the result says what was lowered. Throws on an invalid policy.
	 */
	public applyRiskPolicy(input: unknown): PolicyReport {
		const normalized = normalizePolicy(input);
		const { policy, clamped } = this.approvalGate.setPolicy(normalized.policy);
		return {
			policy,
			clamped,
			converted: normalized.converted,
			notes: normalized.notes,
		};
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
				`Session ${this.sessionId} has no running pi process (status: ${this.status}). Respawn it with spawn_pi_session.`,
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
		const run = this.runs.create(this.sessionId, prompt, intent);
		const active: ActiveRun = {
			run,
			abort: new AbortController(),
			repeat: new RepeatCheck(),
			turnOutput: "",
			cause: null,
			aborting: false,
			maxTimer: null,
			graceTimer: null,
		};
		this.currentRun = active;
		this.status = "RUNNING";
		this.remember({
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: prompt }] },
		});
		const maxRunMs = this.config.limits.maxRunMs;
		active.maxTimer = setTimeout(
			() =>
				this.abortWith(active, {
					state: "timed_out",
					error: `the run exceeded the ${maxRunMs} ms limit and was aborted`,
				}),
			maxRunMs,
		);
		active.maxTimer.unref?.();

		const startMs = this.config.limits.runStartTimeoutMs;
		let startTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				worker.handle.startRun({
					runId: run.id,
					prompt,
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
		// An approval or a quick finish may already have moved the run on.
		if (run.state === "starting") this.runs.setState(run, "running");
		return run;
	}

	/** Note that a call asked for `summarize`, which is ignored. */
	public markSummarize(flag: boolean): void {
		this.summarizeIgnored = flag;
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
		summarize?: boolean,
	): Run {
		const entry = this.pending.get(actionId);
		if (!entry) {
			throw new RunError(
				"APPROVAL_NOT_FOUND",
				`No pending action matching ID: ${actionId} currently awaiting approval`,
			);
		}
		this.approvalGate.recordResolution(
			actionId,
			resolution,
			"coordinator",
			note,
		);
		if (entry.timer) clearTimeout(entry.timer);
		this.pending.delete(actionId);
		if (summarize === true) this.summarizeIgnored = true;
		this.runs.removeApproval(entry.run, actionId);
		this.afterPendingChanged();
		entry.resolve(decision);
		return entry.run;
	}

	public approveAction(actionId: string, summarize?: boolean): Run {
		this.log(`Approving action ${actionId}`);
		return this.answer(
			actionId,
			{ kind: "allow" },
			"allow",
			"approved by the coordinator",
			summarize,
		);
	}

	public rejectAction(
		actionId: string,
		reason?: string,
		summarize?: boolean,
	): Run {
		this.log(`Rejecting action ${actionId} with reason: ${reason || "none"}`);
		return this.answer(
			actionId,
			{
				kind: "deny",
				reason: reason || "Tool execution blocked by the coordinator agent.",
			},
			"deny",
			"rejected by the coordinator",
			summarize,
		);
	}

	// ---- the blocking (legacy) view -------------------------------------------------

	/**
	 * Send a prompt and wait for its text, as `send_pi_command` always has:
	 * the result when the run ends, or an `AWAITING_APPROVAL` message when it
	 * stops at an approval. Rejects when the run fails or times out.
	 */
	public async sendCommand(
		commandText: string,
		summarize?: boolean,
	): Promise<string> {
		const run = await this.startRun(commandText);
		this.summarizeIgnored = summarize === true;
		return (await this.waitText(run)) as string;
	}

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
			const notes = this.takeAutoApprovedNotes();
			const fullOutput = run.output.all;
			return `${fullOutput || "Agent finished task run successfully."}${notes}${this.takeSummarizeNote()}`;
		}
		const p = this.pendingAction;
		if (!p) return `RUNNING: ${run.id} is still ${run.state}.`;
		const hard = p.hardLimit ? " Hard limit: only you can allow this." : "";
		const message = (p.arguments as { message: string }).message;
		return `AWAITING_APPROVAL: [${p.riskLabel ?? "UNKNOWN"} RISK] Intercepted tool call. Action ID: ${p.actionId}. Message: ${message}${hard}${this.takeAutoApprovedNotes()}\n\nRun: ${run.id}. approve_action and reject_action return at once; call wait_run with this runId to follow the run.`;
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
		this.runs.workerClosed(this.sessionId);
		if (worker) await worker.close({ graceMs: 3000, reason });
	}
}

/** A store configured from the server's limits. */
export function runStoreFor(config: Config): RunStore {
	return new RunStore({
		retentionMs: config.limits.resultRetentionMs,
		maxRetained: config.limits.maxRetainedRuns,
		maxWaitMs: config.limits.maxWaitMs,
		outputBufferChars: config.limits.outputBufferChars,
	});
}
