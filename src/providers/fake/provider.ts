import { z } from "zod";

import type { Config } from "../../config.js";
import type { ToolMap } from "../../gate/canonical.js";
import type {
	ApprovalDecision,
	ProviderCapabilities,
	ProviderCheck,
	ProviderHost,
	RunStart,
	WorkerHandle,
	WorkerProvider,
	WorkerSpec,
} from "../types.js";

/**
 * An in-process provider for core tests: no process, no network, fully
 * scripted by the prompt. It exercises every part of the interface a core
 * needs (events, approvals, abort, close) so core behaviour can be tested
 * without a real agent.
 *
 * Prompts:
 *   <text>                    reply `fake reply: <text>`
 *   tool:<name>:<json>        ask the gate for one call; report the outcome
 *   parallel:<name>:<json>    ask for two calls at once, then report both
 *   hang                      stay busy until aborted
 *   slow:<ms>                 reply after <ms>; an abort ends it early
 *   crash                     finish the run with an error
 *   stubborn                  ignore an abort until the worker is closed
 *   markdown-rules            stream horizontal rules and a table, then reply
 *   repeat:<n>                stream the same line <n> times
 *   flood:<chars>             stream one long message of <chars> characters
 *   big:<chars>               reply with <chars> characters
 */

export const FAKE_TOOL_MAP: ToolMap = {
	bash: { kind: "shell", command: "command" },
	write: { kind: "write", paths: ["path"] },
};

export const FAKE_CAPABILITIES: ProviderCapabilities = {
	approvals: "per-tool-call",
	mutateInput: true,
	persistentProcess: false,
	abort: "in-band",
	resume: false,
	parallelToolCalls: true,
	usage: true,
	models: "id",
};

export interface FakeProviderOptions {
	capabilities?: Partial<ProviderCapabilities>;
	/** `open()` rejects with this message. */
	failOpen?: string;
	/** `startRun` never resolves: a worker that does not acknowledge. */
	neverAccept?: boolean;
}

export class FakeProvider implements WorkerProvider {
	readonly id = "fake";
	readonly displayName = "Fake (tests)";
	readonly capabilities: ProviderCapabilities;
	readonly toolMap = FAKE_TOOL_MAP;
	readonly optionsSchema = z.strictObject({}) as unknown as z.ZodType<
		Record<string, unknown>
	>;
	/** Every handle opened, for assertions. */
	readonly opened: FakeHandle[] = [];

	constructor(private readonly opts: FakeProviderOptions = {}) {
		this.capabilities = { ...FAKE_CAPABILITIES, ...opts.capabilities };
	}

	async check(_config: Config): Promise<ProviderCheck> {
		return { available: true, version: "fake" };
	}

	async open(_spec: WorkerSpec, host: ProviderHost): Promise<WorkerHandle> {
		if (this.opts.failOpen) throw new Error(this.opts.failOpen);
		const handle = new FakeHandle(
			host,
			this.capabilities,
			this.opts.neverAccept,
		);
		this.opened.push(handle);
		return handle;
	}
}

export class FakeHandle implements WorkerHandle {
	private active: { runId: string; abort: AbortController } | null = null;
	private aborting: Promise<void> | null = null;
	private closed: Promise<void> | null = null;
	/** Inputs the worker "ran" tools with, in order. */
	readonly ran: Record<string, unknown>[] = [];

	constructor(
		private readonly host: ProviderHost,
		private readonly caps: ProviderCapabilities,
		private readonly neverAccept = false,
	) {}

	private release: (() => void) | null = null;

	async startRun(run: RunStart): Promise<void> {
		if (this.closed) throw new Error("worker is closed");
		if (this.active) throw new Error("a run is already active");
		if (this.neverAccept) await new Promise<never>(() => {});
		const abort = new AbortController();
		run.signal.addEventListener("abort", () => abort.abort(), { once: true });
		this.active = { runId: run.runId, abort };
		// The run proceeds on its own; startRun reports only acceptance.
		void this.execute(run, abort.signal);
	}

	private async execute(run: RunStart, signal: AbortSignal): Promise<void> {
		const { runId } = run;
		const emit = this.host.emit.bind(this.host);
		emit({ type: "run_started", runId });
		let finalText: string | undefined;
		let outcome: "completed" | "aborted" | "error" = "completed";
		let error: string | undefined;
		try {
			finalText = await this.script(run.prompt, runId, signal);
			if (signal.aborted) outcome = "aborted";
			else emit({ type: "assistant_message", runId, text: finalText });
		} catch (e) {
			outcome = signal.aborted ? "aborted" : "error";
			error = e instanceof Error ? e.message : String(e);
		}
		if (this.active?.runId === runId) this.active = null;
		emit({
			type: "run_finished",
			runId,
			outcome,
			finalText: outcome === "completed" ? finalText : undefined,
			error,
			usage: this.caps.usage ? { inputTokens: 1, outputTokens: 1 } : undefined,
		});
	}

	private async script(
		prompt: string,
		runId: string,
		signal: AbortSignal,
	): Promise<string> {
		let m: RegExpMatchArray | null;
		if (prompt === "hang") {
			await new Promise<void>((resolve) => {
				if (signal.aborted) resolve();
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return "unreachable";
		}
		if (prompt === "crash") throw new Error("fake worker crashed");
		if (prompt === "stubborn") {
			await new Promise<void>((resolve) => {
				this.release = resolve;
			});
			return "released";
		}
		if ((m = prompt.match(/^slow:(\d+)$/))) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, Number(m![1]));
				signal.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						resolve();
					},
					{ once: true },
				);
			});
			return "slow done";
		}
		if (prompt === "markdown-rules") {
			const text = "Title\n----\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n----\n";
			for (const line of text.split("\n")) {
				this.host.emit({ type: "text_delta", runId, text: `${line}\n` });
			}
			return text;
		}
		if ((m = prompt.match(/^repeat:(\d+)$/))) {
			for (let i = 0; i < Number(m[1]) && !signal.aborted; i++) {
				this.host.emit({ type: "text_delta", runId, text: "same line\n" });
				if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
			}
			return signal.aborted ? "stopped" : "repeated";
		}
		if ((m = prompt.match(/^flood:(\d+)$/))) {
			this.host.emit({
				type: "text_delta",
				runId,
				text: "x".repeat(Number(m[1])),
			});
			await new Promise((r) => setTimeout(r, 20));
			return signal.aborted ? "stopped" : "flooded";
		}
		if ((m = prompt.match(/^big:(\d+)$/))) return "y".repeat(Number(m[1]));
		if ((m = prompt.match(/^tool:([^:]+):([\s\S]*)$/))) {
			return await this.callTool(runId, m[1], JSON.parse(m[2]), signal);
		}
		if ((m = prompt.match(/^parallel:([^:]+):([\s\S]*)$/))) {
			const input = JSON.parse(m[2]) as Record<string, unknown>;
			const results = await Promise.all([
				this.callTool(runId, m[1], { ...input, n: 1 }, signal),
				this.callTool(runId, m[1], { ...input, n: 2 }, signal),
			]);
			return results.join(" | ");
		}
		this.host.emit({ type: "text_delta", runId, text: "fake " });
		return `fake reply: ${prompt}`;
	}

	private async callTool(
		runId: string,
		toolName: string,
		input: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<string> {
		const callId = `call_${this.ran.length}_${Math.random().toString(36).slice(2, 8)}`;
		const decision: ApprovalDecision = await this.host.requestApproval(
			{ callId, toolName, input },
			signal,
		);
		if (decision.kind === "deny") {
			return `${toolName} blocked: ${decision.reason}`;
		}
		// A provider that cannot mutate treats mutate as a deny: fail closed.
		if (decision.kind === "mutate" && !this.caps.mutateInput) {
			return `${toolName} blocked: mutate is not supported`;
		}
		const actual = decision.kind === "mutate" ? decision.input : input;
		this.ran.push(actual);
		this.host.emit({
			type: "tool_started",
			runId,
			toolName,
			input: actual,
			toolCallId: callId,
		});
		this.host.emit({
			type: "tool_finished",
			runId,
			toolCallId: callId,
			ok: true,
			preview: "ok",
		});
		return `${toolName} ran with ${JSON.stringify(actual)}`;
	}

	/** Simulate the worker dying by itself (not through `close`). */
	crash(code: number | null = 1, signal: string | null = null): void {
		this.host.emit({ type: "exited", code, signal, expected: false });
	}

	abortRun(_reason: string): Promise<void> {
		const active = this.active;
		if (!active) return Promise.resolve();
		// A second call while one is in flight returns the same promise.
		this.aborting ??= (async () => {
			// Pending approvals are cancelled through the signal first, so the
			// worker is never left blocked inside a tool call.
			active.abort.abort();
			while (this.active?.runId === active.runId) {
				await new Promise((r) => setTimeout(r, 1));
			}
			this.aborting = null;
		})();
		return this.aborting;
	}

	close(_opts: { graceMs: number; reason: string }): Promise<void> {
		this.closed ??= (async () => {
			this.release?.();
			await this.abortRun("closing");
			this.host.emit({
				type: "exited",
				code: 0,
				signal: null,
				expected: true,
			});
		})();
		return this.closed;
	}
}
