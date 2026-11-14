import { type Config, defaultConfig } from "../config.js";
import { ChildRegistry } from "../core/child.js";
import { type OpenedWorker, openWorker } from "../core/host.js";
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
	WorkerEvent,
	WorkerProvider,
} from "../providers/types.js";
import { BoundedLog } from "./bounded-log.js";
import { detectLoop } from "./loop-detector.js";
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

/** One line describing an action: its command or target path, truncated. */
function summariseAction(a: AutoApprovedAction): string {
	const raw = [a.input.command, a.input.cmd, a.input.script, a.input.path]
		.concat([a.input.filePath, a.input.file, a.input.targetFile])
		.find((v): v is string => typeof v === "string");
	const oneLine = (raw ?? "").replace(/\s+/g, " ").trim();
	return oneLine.length > SUMMARY_MAX_CHARS
		? `${oneLine.slice(0, SUMMARY_MAX_CHARS)}…`
		: oneLine;
}

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
}

interface PendingApproval {
	call: RawToolCall;
	action: PendingAction;
	outcome: GateOutcome | null;
	resolve: (d: ApprovalDecision) => void;
	cancelled: boolean;
}

/**
 * One worker as the MCP tools see it: a status, a single command in flight,
 * and the approvals the coordinator has to answer. The agent itself sits
 * behind the provider interface; this class holds no protocol.
 */
export class Session {
	private static readonly MAX_LOG_LINES = 2000;
	private static readonly MAX_AUTO_APPROVED_SHOWN = 20;
	private static readonly MAX_AUTO_APPROVED_LOG = 500;

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
	public onStatusChange:
		| ((sessionId: string, status: SessionStatus, message?: string) => void)
		| null = null;

	private worker: OpenedWorker | null = null;
	private alive = false;
	/** Approvals waiting for the coordinator, oldest first. */
	private readonly pending = new Map<string, PendingApproval>();
	private resolveCommand: ((value: string) => void) | null = null;
	private rejectCommand: ((reason: Error) => void) | null = null;
	private currentRun: {
		runId: string;
		abort: AbortController;
		texts: string[];
		turnOutput: string;
	} | null = null;
	private runCounter = 0;
	private abortInFlight = false;
	private activeTaskId: string | null = null;
	private terminating = false;
	/** Set when a call asked for `summarize`, which is deprecated and ignored. */
	private summarizeIgnored = false;

	private readonly config: Config;
	private readonly runtime: RuntimeDir | undefined;
	private readonly processEnv: NodeJS.ProcessEnv;
	private readonly children: ChildRegistry;
	private readonly provider: WorkerProvider | undefined;

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

	/** Recent log lines of this worker, newest last. */
	public get logs(): string[] {
		return this.logBuffer.lines;
	}

	/** The first pending approval, which is the one the coordinator sees. */
	public get pendingAction(): PendingAction | null {
		for (const p of this.pending.values()) return p.action;
		return null;
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
		const run = this.currentRun;
		switch (event.type) {
			case "text_delta":
				if (run && event.runId === run.runId) {
					run.turnOutput += event.text;
					if (detectLoop(run.turnOutput, this.config.limits.maxOutputChars)) {
						this.log(
							"[WARNING] Endless output loop detected! Aborting turn...",
						);
						this.abortCommand();
					}
				}
				return;
			case "assistant_message":
				if (run && event.runId === run.runId) {
					run.turnOutput = "";
					if (event.text) run.texts.push(event.text);
					this.history.push({
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
				return;
			case "notice":
				this.log(`[${event.level}] ${event.text}`);
				return;
			case "run_finished":
				if (run && event.runId === run.runId) this.onRunFinished(event);
				return;
			case "exited":
				this.onExited(event);
				return;
			default:
		}
	}

	private onRunFinished(
		event: Extract<WorkerEvent, { type: "run_finished" }>,
	): void {
		const run = this.currentRun;
		if (!run) return;
		this.currentRun = null;
		this.abortInFlight = false;
		this.dropPending();
		this.activeTaskId = null;
		const resolve = this.resolveCommand;
		const reject = this.rejectCommand;
		this.resolveCommand = null;
		this.rejectCommand = null;
		if (event.outcome === "error") {
			this.log(`Run failed: ${event.error}`);
			// A worker that is still there is idle again; a dead one is reported
			// by its exit.
			if (this.alive && this.status === "RUNNING") {
				this.status = "IDLE";
			}
			reject?.(new Error(event.error ?? "the run failed"));
			return;
		}
		this.log("Agent settled.");
		if (this.status === "RUNNING") {
			this.status = "IDLE";
			this.onStatusChange?.(this.sessionId, "IDLE", "Agent settled");
		}
		if (!resolve) return;
		const fullOutput = run.texts.join("\n\n");
		const notes = this.takeAutoApprovedNotes();
		const fallbackResult = `${fullOutput || "Agent finished task run successfully."}${notes}`;
		resolve(`${fallbackResult}${this.takeSummarizeNote()}`);
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
		this.dropPending();
		const crashed = this.status === "CRASHED";
		const reject = this.rejectCommand;
		const resolve = this.resolveCommand;
		this.resolveCommand = null;
		this.rejectCommand = null;
		this.currentRun = null;
		if (reject) {
			// The run's own error normally got here first; this covers the rest.
			reject(
				new Error(`Worker exited unexpectedly (${this.describeExit(event)})`),
			);
		} else {
			resolve?.("Process terminated");
		}
		if (crashed) {
			this.onStatusChange?.(
				this.sessionId,
				"CRASHED",
				`Worker exited unexpectedly (${this.describeExit(event)})`,
			);
		}
	}

	private describeExit(e: { code: number | null; signal: string | null }) {
		return `code ${e.code}${e.signal ? `, signal ${e.signal}` : ""}`;
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
		if (outcome.decision === "allow") {
			this.log(
				`[AUTO-APPROVED] [${label}] Action ${call.callId}: ${message} (${outcome.reason})`,
			);
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
			if (this.autoDenied.length < Session.MAX_AUTO_APPROVED_SHOWN) {
				this.autoDenied.push(`${outcome.call.rawName}: ${outcome.reason}`);
			}
			return Promise.resolve({ kind: "deny", reason: outcome.reason });
		}
		return this.escalate(call, message, outcome, signal);
	}

	/** Hold a tool call for the coordinator until it is answered or cancelled. */
	private escalate(
		call: RawToolCall,
		message: string,
		outcome: GateOutcome,
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
			const entry: PendingApproval = {
				call,
				action,
				outcome,
				resolve,
				cancelled: false,
			};
			const first = this.pending.size === 0;
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
			if (!first) return;
			this.status = "AWAITING_APPROVAL";
			this.onStatusChange?.(
				this.sessionId,
				"AWAITING_APPROVAL",
				`Intercepted tool call: ${message}`,
			);
			this.announcePending();
		});
	}

	/** Tell the caller waiting on a command that an approval is needed. */
	private announcePending(): void {
		const p = this.pendingAction;
		if (!p || !this.resolveCommand) return;
		const hard = p.hardLimit ? " Hard limit: only you can allow this." : "";
		const message = (p.arguments as { message: string }).message;
		this.resolveCommand(
			`AWAITING_APPROVAL: [${p.riskLabel ?? "UNKNOWN"} RISK] Intercepted tool call. Action ID: ${p.actionId}. Message: ${message}${hard}${this.takeAutoApprovedNotes()}`,
		);
		this.resolveCommand = null;
		this.rejectCommand = null;
	}

	/** An approval ended without the coordinator: record it and deny the call. */
	private cancelPending(actionId: string, reason: string): void {
		const entry = this.pending.get(actionId);
		if (!entry || entry.cancelled) return;
		entry.cancelled = true;
		this.pending.delete(actionId);
		this.approvalGate.recordResolution(actionId, "deny", "cancel", reason);
		entry.resolve({ kind: "deny", reason });
		this.afterPendingChanged();
	}

	/** Pending approvals are gone without an answer: record them as cancelled. */
	private dropPending() {
		for (const id of this.pending.keys()) {
			this.cancelPending(id, "the worker ended before the call was answered");
		}
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

	public setActiveTaskId(taskId: string | null): void {
		this.activeTaskId = taskId;
	}

	public getActiveTaskId(): string | null {
		return this.activeTaskId;
	}

	// ---- commands --------------------------------------------------------------------

	/** Abort the currently running command without terminating the session. */
	public abortCommand(): void {
		// Idempotent: a second request while one is pending changes nothing.
		if (this.status !== "RUNNING" || this.abortInFlight || !this.worker) return;
		this.abortInFlight = true;
		this.log(`Command abort requested (task: ${this.activeTaskId})`);
		this.worker.handle.abortRun("abort requested").catch((err) => {
			this.log(
				`Failed to abort: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
		this.currentRun?.abort.abort();
	}

	public sendCommand(
		commandText: string,
		summarize?: boolean,
	): Promise<string> {
		// Reported before the status check so a session whose worker is gone says
		// what to do instead of failing with "Process not running".
		if (!this.isAlive() || !this.worker) {
			throw new Error(
				`Session ${this.sessionId} has no running pi process (status: ${this.status}). Respawn it with spawn_pi_session.`,
			);
		}
		if (this.status !== "IDLE" && this.status !== "FINISHED") {
			throw new Error(
				`Cannot send command when session status is ${this.status}`,
			);
		}

		this.status = "RUNNING";
		this.onStatusChange?.(
			this.sessionId,
			"RUNNING",
			`Executing: ${commandText.substring(0, 100)}`,
		);
		this.summarizeIgnored = summarize === true;
		const run = {
			runId: `r${++this.runCounter}`,
			abort: new AbortController(),
			texts: [] as string[],
			turnOutput: "",
		};
		this.currentRun = run;
		this.history.push({
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: commandText }] },
		});

		return new Promise((resolve, reject) => {
			this.resolveCommand = resolve;
			this.rejectCommand = reject;
			this.worker!.handle.startRun({
				runId: run.runId,
				prompt: commandText,
				signal: run.abort.signal,
			}).catch((err) => {
				if (this.currentRun === run) this.currentRun = null;
				// Never claim IDLE for a session with no process behind it.
				this.status = this.alive ? "IDLE" : "FINISHED";
				this.resolveCommand = null;
				this.rejectCommand = null;
				reject(err);
			});
		});
	}

	/** Answer the pending approval and wait for the run's next stop. */
	private answer(
		actionId: string,
		decision: ApprovalDecision,
		resolution: "allow" | "deny",
		note: string,
		summarize?: boolean,
	): Promise<string> {
		const entry = this.pending.get(actionId);
		if (
			this.status !== "AWAITING_APPROVAL" ||
			!entry ||
			this.pendingAction?.actionId !== actionId
		) {
			throw new Error(
				`No pending action matching ID: ${actionId} currently awaiting approval`,
			);
		}
		this.approvalGate.recordResolution(
			actionId,
			resolution,
			"coordinator",
			note,
		);
		this.pending.delete(actionId);
		if (summarize === true) this.summarizeIgnored = true;

		return new Promise((resolve, reject) => {
			this.resolveCommand = resolve;
			this.rejectCommand = reject;
			if (this.pending.size > 0) {
				// More calls are waiting: the next one is the coordinator's now.
				this.status = "AWAITING_APPROVAL";
				entry.resolve(decision);
				this.announcePending();
				return;
			}
			this.status = "RUNNING";
			entry.resolve(decision);
		});
	}

	public approveAction(actionId: string, summarize?: boolean): Promise<string> {
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
	): Promise<string> {
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

	/**
	 * Stop the worker: SIGTERM, then SIGKILL for it and everything it started
	 * once the grace period is over. Resolves when the process is gone.
	 * Idempotent.
	 */
	public async terminate(): Promise<void> {
		this.log("Terminating subprocess...");
		this.terminating = true;
		const worker = this.worker;
		this.worker = null;
		const wasAlive = this.alive;
		this.alive = false;
		if (wasAlive) this.status = "FINISHED";
		this.dropPending();
		this.currentRun?.abort.abort();
		this.currentRun = null;
		const resolve = this.resolveCommand;
		this.resolveCommand = null;
		this.rejectCommand = null;
		resolve?.("Process terminated");
		this.onStatusChange?.(this.sessionId, "CRASHED", "Process terminated");
		this.activeTaskId = null;
		if (worker) await worker.close({ graceMs: 3000, reason: "requested" });
	}
}
