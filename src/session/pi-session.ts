import * as fs from "node:fs";

import { type Config, defaultConfig } from "../config.js";
import { ChildRegistry, type ManagedChild } from "../core/child.js";
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
import { parseToolFromMessage } from "../gate/request.js";
import { RISK_LABELS, RiskLevel } from "../gate/risk.js";
import {
	assertGatePresent,
	type Gate,
	PI_HARDENING_FLAGS,
	removeGate,
	writeGate,
} from "./launch.js";
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
export interface PiSessionDeps {
	config?: Config;
	/** Required to start pi: where the gate directory is created. */
	runtime?: RuntimeDir;
	/** The server's environment, the source of the worker's allowlisted env. */
	env?: NodeJS.ProcessEnv;
	/** Starts and kills worker processes; one per server. */
	children?: ChildRegistry;
}

export class PiSession {
	private static readonly MAX_LOG_LINES = 2000;
	private static readonly MAX_AUTO_APPROVED_SHOWN = 20;

	public sessionId: string;
	public cwd: string;
	public model: string | undefined;
	public systemPrompt: string | undefined;
	public status: SessionStatus = "IDLE";
	public pendingAction: PendingAction | null = null;
	public logs: string[] = [];
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
	private static readonly MAX_AUTO_APPROVED_LOG = 500;

	private child: ManagedChild | null = null;
	private resolveCommand: ((value: string) => void) | null = null;
	private rejectCommand: ((reason: Error) => void) | null = null;
	private currentTurnOutput = "";
	private abortTimeout: ReturnType<typeof setTimeout> | null = null;
	private activeTaskId: string | null = null;
	private terminating = false;
	/** Set when a call asked for `summarize`, which is deprecated and ignored. */
	private summarizeIgnored = false;
	private gate: Gate | null = null;
	private historyStartIndex = 0;

	private readonly config: Config;
	private readonly runtime: RuntimeDir | undefined;
	private readonly processEnv: NodeJS.ProcessEnv;
	private readonly children: ChildRegistry;

	constructor(
		sessionId: string,
		cwd: string,
		model?: string,
		systemPrompt?: string,
		riskPolicy?: unknown,
		deps: PiSessionDeps = {},
	) {
		this.config = deps.config ?? defaultConfig();
		this.runtime = deps.runtime;
		this.processEnv = deps.env ?? {};
		this.children =
			deps.children ??
			new ChildRegistry({ env: this.processEnv, envConfig: this.config.env });
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
		this.logs.push(formatted);
		// Bound the trace so a long-lived session cannot grow without limit.
		if (this.logs.length > PiSession.MAX_LOG_LINES) {
			this.logs.splice(0, this.logs.length - PiSession.MAX_LOG_LINES);
		}
		console.error(`[Session ${this.sessionId}] ${formatted}`);
	}

	public async start(): Promise<void> {
		const piPath = this.config.providers.pi.path;

		this.log(
			`Spawning pi subprocess in: ${this.cwd} using executable: ${piPath}`,
		);

		// Check if directory exists
		if (!fs.existsSync(this.cwd)) {
			throw new Error(`Workspace directory does not exist: ${this.cwd}`);
		}

		// The gate is written fresh for this worker from a constant compiled into
		// the server. Without it pi must not start: tool calls would run ungated.
		if (!this.runtime) {
			throw new Error("Cannot start pi: no runtime directory was provided.");
		}
		const gate = writeGate(this.runtime);
		this.gate = gate;

		const args = ["--mode", "rpc", ...PI_HARDENING_FLAGS, "-e", gate.file];
		if (this.systemPrompt) {
			args.push("--system-prompt", this.systemPrompt);
		}

		let child: ManagedChild;
		try {
			assertGatePresent(gate);
			child = this.children.spawn({
				argv: [piPath, ...args],
				cwd: this.cwd,
				stdio: "jsonl",
				sandbox: "none",
			});
			this.child = child;
			// A missing or non-executable binary surfaces asynchronously: wait for
			// the outcome so a failed spawn is reported instead of looking healthy.
			await child.started;
		} catch (e) {
			this.status = "CRASHED";
			this.child = null;
			this.removeGateDir();
			this.log(
				`Failed to spawn process: ${e instanceof Error ? e.message : String(e)}`,
			);
			throw new Error(
				`Failed to start pi (${piPath}): ${e instanceof Error ? e.message : String(e)}`,
				{ cause: e },
			);
		}

		this.status = "IDLE";

		// Framing, line caps and EPIPE-safe writes live in the child handle.
		child.onLine((line) => this.handleStdoutLine(line.trim()));
		child.onStderr((line) => this.log(`[stderr] ${line}`));
		child.onProblem((p) => this.log(`pi ${p.kind}: ${p.detail}`));
		void child.exited.then((exit) => {
			if (exit.error) {
				this.status = "CRASHED";
				this.log(`Process error event: ${exit.error.message}`);
				this.dropPending();
				this.rejectCommand?.(exit.error);
				this.resolveCommand = null;
				this.rejectCommand = null;
				return;
			}
			// A replaced or terminated child's late exit must not touch its successor.
			if (this.child === child || this.terminating) this.handleClose(exit.code);
		});

		// Apply model override if specified
		if (this.model) {
			// Split into provider/modelId, default to ollama if not specified
			let provider = "ollama";
			let modelId = this.model;
			const slashIndex = this.model.indexOf("/");
			if (slashIndex !== -1) {
				provider = this.model.substring(0, slashIndex);
				modelId = this.model.substring(slashIndex + 1);
			}

			this.log(`Configuring model: ${provider}/${modelId}`);
			await this.writeRaw({
				type: "set_model",
				provider,
				modelId,
			});
		}
	}

	private handleClose(code: number | null) {
		if (this.terminating) {
			// pi exits non-zero when killed, which is not a crash.
			this.status = "FINISHED";
			this.log(`Process terminated on request (exit code: ${code}).`);
		} else if (code !== 0 && code !== null) {
			this.status = "CRASHED";
			this.log(`Process exited with non-zero code: ${code}`);
		} else {
			this.status = "FINISHED";
			this.log(`Process completed and exited successfully.`);
		}

		this.child = null;
		this.removeGateDir();
		this.dropPending();
		if (this.resolveCommand) {
			this.resolveCommand("Process terminated");
		}
		this.resolveCommand = null;
		this.rejectCommand = null;
	}

	private handleStdoutLine(line: string) {
		try {
			const obj = JSON.parse(line);
			// Each message_update carries a snapshot of the message so far, so it
			// grows across a turn — logging and storing every one costs O(n^2).
			this.log(
				obj.type === "message_update"
					? "[Event Received] message_update"
					: `[Event Received] ${JSON.stringify(obj)}`,
			);

			// Store trace in history. message_update is skipped: the history
			// resource serves message_end only, so those snapshots are never read.
			if (obj.type !== "message_update") {
				this.history.push(obj);
			}

			// 1. Handle command response resolutions
			if (obj.type === "response") {
				if (obj.success === false) {
					this.log(`Command failed: ${obj.error}`);
					if (this.rejectCommand) {
						this.rejectCommand(new Error(obj.error));
						this.rejectCommand = null;
						this.resolveCommand = null;
						this.status = "IDLE";
					}
				} else {
					// Acknowledgement only: pi echoes a `response` as soon as it accepts
					// the command, long before the agent has done any work. The run is
					// settled by `agent_end`, so nothing is resolved here.
					this.log(`Command acknowledged: ${obj.command}`);
				}
				return;
			}

			// 2. Handle interactive gating requests from Extensions (e.g. confirm UI dialogs)
			if (obj.type === "extension_ui_request") {
				if (obj.method === "confirm") {
					const toolCall = parseToolFromMessage(obj.title, obj.message);
					if (toolCall) {
						const decided = this.approvalGate.decide(
							{
								provider: "pi",
								toolName: toolCall.toolName,
								input: toolCall.input,
							},
							obj.id,
						);
						// Synchronous with the rules alone; a later classifier may not be.
						if (decided instanceof Promise) {
							decided.then((outcome) => this.applyOutcome(obj, outcome));
						} else {
							this.applyOutcome(obj, decided);
						}
					} else {
						// A request the gate cannot read always goes to the coordinator.
						this.escalate(obj, null);
					}
				}
				return;
			}

			// 3. Handle turn lifecycle events
			if (obj.type === "turn_start") {
				this.currentTurnOutput = "";
			}

			if (obj.type === "message_update") {
				let delta = "";
				if (
					obj.assistantMessageEvent &&
					typeof obj.assistantMessageEvent.delta === "string"
				) {
					delta = obj.assistantMessageEvent.delta;
				} else if (typeof obj.text === "string") {
					delta = obj.text;
				}

				if (delta) {
					this.currentTurnOutput += delta;
					if (this.detectLoop(this.currentTurnOutput)) {
						this.handleLoopDetected();
					}
				}
			}

			// pi signals completion of a whole run with `agent_end`. `turn_end` fires
			// once per tool-call round, so it cannot be used to settle a command.
			if (obj.type === "agent_end" || obj.type === "agent_settled") {
				this.log(`Agent settled.`);
				if (this.abortTimeout) {
					clearTimeout(this.abortTimeout);
					this.abortTimeout = null;
				}
				if (this.status === "RUNNING") {
					this.status = "IDLE";
					this.onStatusChange?.(this.sessionId, "IDLE", "Agent settled");
					this.activeTaskId = null;
					if (this.resolveCommand) {
						const resolve = this.resolveCommand;
						this.resolveCommand = null;
						this.rejectCommand = null;

						const runHistory = this.history.slice(this.historyStartIndex);
						const assistantTextParts: string[] = [];

						for (const event of runHistory) {
							if (
								event &&
								typeof event === "object" &&
								"type" in event &&
								(event as { type?: string }).type === "message_end" &&
								"message" in event
							) {
								const msg = (
									event as {
										message?: {
											role?: string;
											content?: Array<{ type?: string; text?: string }>;
										};
									}
								).message;
								if (
									msg &&
									msg.role === "assistant" &&
									Array.isArray(msg.content)
								) {
									const text = msg.content
										.filter((block): block is { type: string; text: string } =>
											Boolean(
												block &&
												block.type === "text" &&
												typeof block.text === "string",
											),
										)
										.map((block) => block.text)
										.join("\n");
									if (text) {
										assistantTextParts.push(text);
									}
								}
							}
						}

						const fullOutput = assistantTextParts.join("\n\n");
						const notes = this.takeAutoApprovedNotes();
						const fallbackResult = `${fullOutput || "Agent finished task run successfully."}${notes}`;

						resolve(`${fallbackResult}${this.takeSummarizeNote()}`);
					}
				}
			}
		} catch (e) {
			this.log(`Failed to parse stdout line: ${line} - Error: ${e}`);
		}
	}

	private writeRaw(obj: object): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = this.child;
			if (!child) return reject(new Error("Process not running"));
			child.send(obj, (err) => {
				if (err) {
					reject(err);
				} else {
					this.log(`[Command Sent] ${JSON.stringify(obj)}`);
					resolve();
				}
			});
		});
	}

	/** Act on the gate's decision for a confirmation request from pi. */
	private applyOutcome(
		obj: { id: string; message: string },
		outcome: GateOutcome,
	) {
		const label = RISK_LABELS[outcome.level];
		if (outcome.decision === "allow") {
			this.log(
				`[AUTO-APPROVED] [${label}] Action ${obj.id}: ${obj.message} (${outcome.reason})`,
			);
			this.autoApprovedTotal++;
			this.autoApprovedActions.push({
				actionId: obj.id,
				toolName: outcome.call.rawName,
				input: outcome.call.input,
				riskLevel: outcome.level,
				riskLabel: label,
				reason: outcome.reason,
				timestamp: new Date().toISOString(),
				matchedOverride: outcome.matchedOverride,
			});
			if (this.autoApprovedActions.length > PiSession.MAX_AUTO_APPROVED_LOG) {
				this.autoApprovedActions.splice(
					0,
					this.autoApprovedActions.length - PiSession.MAX_AUTO_APPROVED_LOG,
				);
			}
			this.writeRaw({
				type: "extension_ui_response",
				id: obj.id,
				confirmed: true,
			}).catch((err) => {
				this.log(`Failed to auto-approve action ${obj.id}: ${err.message}`);
			});
			return;
		}
		if (outcome.decision === "deny") {
			this.log(
				`[AUTO-DENIED] [${label}] Action ${obj.id}: ${obj.message} (${outcome.reason})`,
			);
			if (this.autoDenied.length < PiSession.MAX_AUTO_APPROVED_SHOWN) {
				this.autoDenied.push(`${outcome.call.rawName}: ${outcome.reason}`);
			}
			this.writeRaw({
				type: "extension_ui_response",
				id: obj.id,
				confirmed: false,
				value: outcome.reason,
			}).catch((err) => {
				this.log(`Failed to deny action ${obj.id}: ${err.message}`);
			});
			return;
		}
		this.escalate(obj, outcome);
	}

	/** Hold a tool call for the coordinator. `outcome` is null if unclassified. */
	private escalate(
		obj: { id: string; title?: string; message: string },
		outcome: GateOutcome | null,
	) {
		const label = outcome ? RISK_LABELS[outcome.level] : undefined;
		this.status = "AWAITING_APPROVAL";
		this.onStatusChange?.(
			this.sessionId,
			"AWAITING_APPROVAL",
			`Intercepted tool call: ${obj.message}`,
		);
		this.pendingAction = {
			actionId: obj.id,
			tool: "confirm",
			arguments: { title: obj.title, message: obj.message },
			context:
				"A tool execution or high-risk operation requires supervisor consent.",
			riskLevel: outcome?.level,
			riskLabel: label,
			reason: outcome?.reason,
			hardLimit: outcome ? !outcome.autoAllowable : undefined,
		};
		this.log(
			`[INTERCEPTED] [${label ?? "UNKNOWN"}] Action ${obj.id} awaiting coordinator approval: ${obj.message}`,
		);
		if (this.resolveCommand) {
			const hard =
				outcome && !outcome.autoAllowable
					? " Hard limit: only you can allow this."
					: "";
			this.resolveCommand(
				`AWAITING_APPROVAL: [${label ?? "UNKNOWN"} RISK] Intercepted tool call. Action ID: ${obj.id}. Message: ${obj.message}${hard}${this.takeAutoApprovedNotes()}`,
			);
			this.resolveCommand = null;
			this.rejectCommand = null;
		}
	}

	/** The pending action is gone without an answer: record it as cancelled. */
	private dropPending() {
		if (this.pendingAction) {
			this.approvalGate.recordResolution(
				this.pendingAction.actionId,
				"deny",
				"cancel",
				"the worker ended before the call was answered",
			);
		}
		this.pendingAction = null;
	}

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
		const shown = entries.slice(0, PiSession.MAX_AUTO_APPROVED_SHOWN);
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

	/** Remove this worker's private gate directory. Safe to call repeatedly. */
	private removeGateDir() {
		if (!this.gate) return;
		removeGate(this.gate);
		this.gate = null;
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

	/** Whether a pi subprocess is actually attached to this session. */
	public isAlive(): boolean {
		return this.child !== null;
	}

	public setActiveTaskId(taskId: string | null): void {
		this.activeTaskId = taskId;
	}

	public getActiveTaskId(): string | null {
		return this.activeTaskId;
	}

	/** Abort the currently running command without terminating the session. */
	public abortCommand(): void {
		// Idempotent: a second request while one is pending changes nothing.
		if (this.status !== "RUNNING" || this.abortTimeout) return;

		const cmdId = `abort_${Date.now()}`;
		this.writeRaw({ id: cmdId, type: "abort" }).catch((err) => {
			this.log(`Failed to send abort: ${err.message}`);
		});

		this.abortTimeout = setTimeout(() => {
			if (this.status === "RUNNING") {
				this.log("Abort timeout reached, force-terminating process");
				this.terminate();
			}
		}, 2000);

		this.log(`Command abort requested (task: ${this.activeTaskId})`);
	}

	public sendCommand(
		commandText: string,
		summarize?: boolean,
	): Promise<string> {
		// Reported before the status check so a session restored from the
		// registry says what to do instead of failing with "Process not running".
		if (!this.isAlive()) {
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
		this.historyStartIndex = this.history.length;
		const cmdId = `cmd_${Date.now()}`;

		return new Promise((resolve, reject) => {
			this.resolveCommand = resolve;
			this.rejectCommand = reject;

			this.writeRaw({
				id: cmdId,
				type: "prompt",
				message: commandText,
			}).catch((err) => {
				// Never claim IDLE for a session with no process behind it.
				this.status = this.isAlive() ? "IDLE" : "FINISHED";
				reject(err);
			});
		});
	}

	public approveAction(actionId: string, summarize?: boolean): Promise<string> {
		if (
			this.status !== "AWAITING_APPROVAL" ||
			!this.pendingAction ||
			this.pendingAction.actionId !== actionId
		) {
			throw new Error(
				`No pending action matching ID: ${actionId} currently awaiting approval`,
			);
		}

		this.log(`Approving action ${actionId}`);
		this.approvalGate.recordResolution(
			actionId,
			"allow",
			"coordinator",
			"approved by the coordinator",
		);
		this.status = "RUNNING";
		this.pendingAction = null;
		if (summarize === true) {
			this.summarizeIgnored = true;
		}

		return new Promise((resolve, reject) => {
			this.resolveCommand = resolve;
			this.rejectCommand = reject;

			this.writeRaw({
				type: "extension_ui_response",
				id: actionId,
				confirmed: true,
			}).catch((err) => {
				this.status = "IDLE";
				reject(err);
			});
		});
	}

	public rejectAction(
		actionId: string,
		reason?: string,
		summarize?: boolean,
	): Promise<string> {
		if (
			this.status !== "AWAITING_APPROVAL" ||
			!this.pendingAction ||
			this.pendingAction.actionId !== actionId
		) {
			throw new Error(
				`No pending action matching ID: ${actionId} currently awaiting approval`,
			);
		}

		this.log(`Rejecting action ${actionId} with reason: ${reason || "none"}`);
		this.approvalGate.recordResolution(
			actionId,
			"deny",
			"coordinator",
			"rejected by the coordinator",
		);
		this.status = "RUNNING";
		this.pendingAction = null;
		if (summarize === true) {
			this.summarizeIgnored = true;
		}

		return new Promise((resolve, reject) => {
			this.resolveCommand = resolve;
			this.rejectCommand = reject;

			this.writeRaw({
				type: "extension_ui_response",
				id: actionId,
				confirmed: false,
				value: reason,
			}).catch((err) => {
				this.status = "IDLE";
				reject(err);
			});
		});
	}

	/**
	 * Stop the worker: SIGTERM, then SIGKILL for it and everything it started
	 * once the grace period is over. Resolves when the process is gone.
	 * Idempotent.
	 */
	public terminate(): Promise<void> {
		this.log("Terminating subprocess...");
		this.terminating = true;
		if (this.abortTimeout) {
			clearTimeout(this.abortTimeout);
			this.abortTimeout = null;
		}
		const child = this.child;
		let gone: Promise<void> = Promise.resolve();
		if (child) {
			gone = child.terminate();
			this.status = "FINISHED";
			this.child = null;
		}
		this.removeGateDir();
		this.dropPending();
		this.onStatusChange?.(this.sessionId, "CRASHED", "Process terminated");
		this.activeTaskId = null;
		return gone;
	}

	private detectLoop(text: string): boolean {
		const len = text.length;
		const maxOutputLimit = this.config.limits.maxOutputChars;
		if (len > maxOutputLimit) return true; // Safeguard limit
		if (len < 5) return false;

		const maxPatternLen = Math.min(50, Math.floor(len / 2));
		for (let patternLen = 1; patternLen <= maxPatternLen; patternLen++) {
			let minRepetitions = 5;
			if (patternLen === 1) minRepetitions = 20;
			else if (patternLen === 2) minRepetitions = 10;
			else if (patternLen === 3) minRepetitions = 8;

			const requiredLen = patternLen * minRepetitions;
			if (len < requiredLen) continue;

			const pattern = text.slice(-patternLen);
			let isLoop = true;
			for (let i = 1; i < minRepetitions; i++) {
				const start = len - patternLen * (i + 1);
				const end = len - patternLen * i;
				const prevPattern = text.slice(start, end);
				if (prevPattern !== pattern) {
					isLoop = false;
					break;
				}
			}
			if (isLoop) return true;
		}
		return false;
	}

	private handleLoopDetected() {
		this.log("[WARNING] Endless output loop detected! Aborting turn...");
		this.abortCommand();
	}
}
