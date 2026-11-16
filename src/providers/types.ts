import type { z } from "zod";

import type { Config } from "../config.js";
import type { ManagedChild, ProviderChildSpec } from "../core/child.js";
import type { Logger } from "../core/log.js";
import type { SandboxProfile } from "../core/sandbox.js";
import type { ToolMap } from "../gate/canonical.js";

/**
 * The internal interface between the core and the agents it runs. The core
 * owns runs, gating, process control and limits; a provider only translates
 * one agent's protocol. Not exposed to MCP clients and not a plugin API: the
 * registry is static.
 */

export interface ProviderCapabilities {
	approvals: "per-tool-call" | "none";
	/** Can apply `ApprovalDecision.mutate`. */
	mutateInput: boolean;
	/** One long-lived process (true) or one process per run (false). */
	persistentProcess: boolean;
	/** How `abortRun` stops a run: a message to the agent, or killing it. */
	abort: "in-band" | "kill";
	/** Can continue a conversation from `resumeToken`. */
	resume: boolean;
	/** Several approvals may be pending at once. */
	parallelToolCalls: boolean;
	/** Reports tokens or cost. */
	usage: boolean;
	models: "provider/id" | "id" | "none";
}

export interface ProviderCheck {
	available: boolean;
	version?: string;
	/** Why it is unavailable. */
	reason?: string;
}

export interface WorkerProvider {
	readonly id: string;
	readonly displayName: string;
	readonly capabilities: ProviderCapabilities;
	readonly toolMap: ToolMap;
	/**
	 * What the agent needs from `$HOME` inside the `workspace` sandbox. The
	 * core mounts it; the provider only declares it. Default: nothing.
	 */
	readonly sandboxProfile?: SandboxProfile;
	/** Can keep its conversation in a directory the core gives it (`WorkerSpec.session`). */
	readonly sessionProfile?: { needsDir: boolean };
	/**
	 * A read-only look at a kept session: no process, no model. Used before a
	 * resume. Every string it returns that came from the file is worker output.
	 */
	inspectSession?(
		dir: string,
		id: string,
		opts?: { sinceBytes?: number },
	): Promise<SessionInspection>;
	/** Cheap availability probe: binary found, version. No model calls. */
	check(config: Config): Promise<ProviderCheck>;
	/** Validates provider-specific spawn options; unknown keys are rejected. */
	readonly optionsSchema: z.ZodType<Record<string, unknown>>;
	/**
	 * Create a worker. Resolves when it is ready and its gate is active. A
	 * provider that starts one process per run has none yet: it proves gate
	 * readiness in `startRun` instead, and rejects there (killing its child)
	 * when it cannot.
	 */
	open(spec: WorkerSpec, host: ProviderHost): Promise<WorkerHandle>;
}

export interface WorkerSpec {
	/** Server-generated. */
	workerId: string;
	/** Absolute and validated by the core. */
	cwd: string;
	model?: string;
	systemPrompt?: string;
	/** Already validated by the provider's `optionsSchema`. */
	options: Record<string, unknown>;
	/** For resume-capable providers. */
	resumeToken?: string;
	/**
	 * Present when the conversation is kept. The core owns the directory: it
	 * exists (0700), is bound read-write into the sandbox and hidden from the
	 * agent's shell commands. Absent: the provider keeps nothing.
	 */
	session?: { dir: string; id: string; mode?: "new" | "resume" };
}

/** What a provider found in a kept session (see `WorkerProvider.inspectSession`). */
export interface SessionInspection {
	/** A session file for the id exists in the directory. */
	exists: boolean;
	/** Its path. */
	file?: string;
	bytes: number;
	/** The provider's own format name or number, as text. */
	format?: string;
	/** Whether this server's provider module understands the format. */
	formatSupported: boolean;
	/** The working directory the session was started in. */
	cwd?: string;
	/** Messages on the active branch. */
	messageCount: number;
	/** Reasons the session must not be resumed (damage that would silently lose history). */
	fatal: string[];
	/** Damage that can be accepted, for the caller to report. */
	warnings: string[];
	/**
	 * Tool calls with no result, oldest first, written at or after `sinceBytes`
	 * (the start of the file when it is not given). Worker trust.
	 */
	danglingCalls: {
		name: string;
		callId: string;
		/** The gate's `argsDigest` for the call's arguments. */
		inputDigest: string;
		/** The arguments as short one-line JSON. Untrusted. */
		untrustedPreview: string;
	}[];
}

export interface ProviderHost {
	/**
	 * Start a process under core policy: env allowlist, process group, bounded
	 * framing, tree kill. A provider never spawns on its own.
	 */
	spawn(spec: ProviderChildSpec): ManagedChild;
	/** A normalised event into the core run. */
	emit(event: WorkerEvent): void;
	/** Ask the gate. Never rejects: any failure is a deny. */
	requestApproval(
		call: RawToolCall,
		signal: AbortSignal,
	): Promise<ApprovalDecision>;
	/** Private 0700 directory for this worker. Removed when it closes. */
	readonly privateDir: string;
	readonly log: Logger;
}

export type CloseReason = "requested" | "idle" | "shutdown";

export interface WorkerHandle {
	/** Start a run. Resolves when the provider accepted it, not when it ends. */
	startRun(run: RunStart): Promise<void>;
	/** Idempotent; safe in any state, including while awaiting approval. */
	abortRun(reason: string): Promise<void>;
	/** Graceful stop; the core's child handling escalates. Idempotent. */
	close(opts: { graceMs: number; reason: CloseReason }): Promise<void>;
	resumeToken?(): string | undefined;
}

export interface RunStart {
	runId: string;
	prompt: string;
	signal: AbortSignal;
}

export type ApprovalDecision =
	| { kind: "allow" }
	/** The reason reaches the worker. */
	| { kind: "deny"; reason: string }
	/** Only honoured when `capabilities.mutateInput`. */
	| { kind: "mutate"; input: Record<string, unknown> };

/** A tool call as the worker made it, before the gate has looked at it. */
export interface RawToolCall {
	/** The provider's own id, for correlation inside the provider. */
	callId: string;
	toolName: string;
	input: Record<string, unknown>;
	/** Nested agent calls (subagents); depth 0 when absent. */
	origin?: { depth: number; parentCallId?: string; agentId?: string };
}

export interface Usage {
	inputTokens?: number;
	outputTokens?: number;
	costUsd?: number;
}

export type WorkerEvent =
	| { type: "run_started"; runId: string }
	| { type: "text_delta"; runId: string; text: string }
	| { type: "assistant_message"; runId: string; text: string; usage?: Usage }
	| {
			type: "tool_started";
			runId: string;
			toolName: string;
			input: unknown;
			toolCallId: string;
	  }
	| {
			type: "tool_finished";
			runId: string;
			toolCallId: string;
			ok: boolean;
			preview: string;
	  }
	| {
			type: "notice";
			runId?: string;
			level: "info" | "warn";
			text: string;
			/**
			 * A fixed string written by the server. Without it the text is taken
			 * to carry the worker's own words and is logged only at `debug`.
			 */
			trusted?: boolean;
	  }
	| {
			type: "run_finished";
			runId: string;
			outcome: "completed" | "aborted" | "error";
			finalText?: string;
			usage?: Usage;
			error?: string;
	  }
	| {
			type: "exited";
			code: number | null;
			signal: string | null;
			expected: boolean;
	  };
