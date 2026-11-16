import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";

import { z } from "zod";

import type { Config } from "../../config.js";
import type { ManagedChild } from "../../core/child.js";
import type { SandboxProfile } from "../../core/sandbox.js";
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
import { buildPiArgs } from "./argv.js";
import {
	GATE_DIALOG_TITLE,
	GATE_NONCE_ENV,
	GATE_STATUS_KEY,
	encodeDecision,
	parseGateRequest,
	writeGateFile,
} from "./gate-extension.js";
import {
	asUiRequest,
	assistantText,
	isRecord,
	messageUsage,
	resultPreview,
} from "./rpc.js";
import { piToolMap } from "./tool-map.js";

export interface PiProviderOptions {
	/** Overrides `providers.pi.startupTimeoutMs` (tests). */
	startupTimeoutMs?: number;
	/** How long an abort may take before the worker is stopped. */
	abortGraceMs?: number;
}

/**
 * pi reads its auth, models and settings from `~/.pi` and writes nothing there
 * that matters in a run. But even to read `settings.json` it takes a lock by
 * creating `settings.json.lock` next to it: on a read-only directory that
 * fails, pi reports an invalid settings file and ignores all of it (its
 * default model, for one). A writable `~/.pi/agent` would let a worker rewrite
 * `auth.json` and `settings.json`, which the user's own pi loads later, so the
 * directory is a throwaway overlay instead: writable, with every existing file
 * read-only, and discarded with the worker.
 */
export const PI_SANDBOX_PROFILE: SandboxProfile = {
	roHome: [".pi"],
	rwHome: [],
	overlayHome: [".pi/agent"],
	// pi itself needs `auth.json` (and `models.json`), the commands it runs do
	// not: they get an empty directory there, in their own sandbox.
	toolHideHome: [".pi/agent"],
	shellTool: { name: "bash", command: "command" },
};

export const PI_CAPABILITIES: ProviderCapabilities = {
	approvals: "per-tool-call",
	mutateInput: true,
	persistentProcess: true,
	abort: "in-band",
	resume: false,
	parallelToolCalls: true,
	usage: true,
	models: "provider/id",
};

const PREVIEW_CHARS = 2048;
const STDERR_TAIL = 40;
const QUOTE_CHARS = 160;

/** Lines pi's launcher and the runtime print that say nothing about why it died. */
const NOISE = [
	/^npm (warn|notice|info|http|verbose|timing)\b/i,
	/deprecat/i,
	/^\(node:\d+\)/,
	/^\(Use `node --/,
	/ExperimentalWarning/,
	/^\s*at\s/,
	/^\s*$/,
];

/**
 * The last stderr line that is not launcher or runtime noise, shortened, as
 * a quotation. It is the worker's own text and stays untrusted: the caller
 * is told so and it is never longer than one short line.
 */
export function stderrQuote(lines: readonly string[]): string {
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].replace(/\s+/g, " ").trim();
		if (NOISE.some((re) => re.test(line))) continue;
		const cut =
			line.length > QUOTE_CHARS ? `${line.slice(0, QUOTE_CHARS)}…` : line;
		return ` Last stderr line (untrusted text from the worker): "${cut}"`;
	}
	return "";
}

/** How a process ended, leading with the signal or the exit code. */
export function describeExit(exit: {
	code: number | null;
	signal: string | null;
}): string {
	if (exit.signal) return `killed by signal ${exit.signal}`;
	return `code ${exit.code}`;
}

export function createPiProvider(
	config: Config,
	opts: PiProviderOptions = {},
): WorkerProvider {
	const startupTimeoutMs =
		opts.startupTimeoutMs ?? config.providers.pi.startupTimeoutMs;
	const abortGraceMs = opts.abortGraceMs ?? 2000;
	const piPath = config.providers.pi.path;
	return {
		id: "pi",
		displayName: "pi",
		capabilities: PI_CAPABILITIES,
		sandboxProfile: PI_SANDBOX_PROFILE,
		sessionProfile: { needsDir: true },
		toolMap: piToolMap,
		optionsSchema: z.strictObject({}) as unknown as z.ZodType<
			Record<string, unknown>
		>,
		async check(): Promise<ProviderCheck> {
			return await new Promise((resolve) => {
				execFile(
					piPath,
					["--version"],
					{ timeout: 10_000, env: { PATH: process.env.PATH ?? "" } },
					(err, stdout) => {
						if (err) {
							resolve({ available: false, reason: err.message });
						} else {
							resolve({ available: true, version: String(stdout).trim() });
						}
					},
				);
			});
		},
		async open(spec: WorkerSpec, host: ProviderHost): Promise<WorkerHandle> {
			if (!fs.existsSync(spec.cwd)) {
				throw new Error(`Workspace directory does not exist: ${spec.cwd}`);
			}
			// The gate comes from a constant compiled into the server. Without it
			// pi must not start: tool calls would run ungated.
			const gateFile = writeGateFile(host.privateDir);
			const nonce = randomBytes(16).toString("hex");
			host.log.info(`starting pi in ${spec.cwd} using ${piPath}`);
			const child = host.spawn({
				argv: [
					piPath,
					...buildPiArgs({
						gateFile,
						systemPrompt: spec.systemPrompt,
						session: spec.session,
					}),
				],
				cwd: spec.cwd,
				env: { [GATE_NONCE_ENV]: nonce },
				stdio: "jsonl",
			});
			try {
				// A missing binary surfaces asynchronously: wait for the outcome.
				await child.started;
			} catch (e) {
				throw new Error(
					`Failed to start pi (${piPath}): ${e instanceof Error ? e.message : String(e)}`,
					{ cause: e },
				);
			}
			const worker = new PiWorker(host, child, nonce, gateFile, abortGraceMs);
			try {
				await worker.waitReady(startupTimeoutMs);
			} catch (e) {
				await child.terminate(0);
				throw e;
			}
			if (spec.model) worker.setModel(spec.model);
			return worker;
		},
	};
}

interface ActiveRun {
	runId: string;
	abort: AbortController;
	abortRequested: boolean;
	lastText?: string;
	usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
	done: Promise<void>;
	finish: () => void;
}

/** One pi process speaking `--mode rpc`, behind the provider interface. */
class PiWorker implements WorkerHandle {
	private run: ActiveRun | null = null;
	private ready = false;
	private readonly readyWaiters: {
		resolve: () => void;
		reject: (e: Error) => void;
	}[] = [];
	private gateFailure: string | null = null;
	private promptWaiter: {
		id: string;
		resolve: () => void;
		reject: (e: Error) => void;
	} | null = null;
	/** Gate dialogs still being decided, by dialog id. */
	private readonly dialogs = new Map<string, Promise<void>>();
	/** Aborted when the worker goes away: covers calls outside any run. */
	private readonly lifetime = new AbortController();
	private aborting: Promise<void> | null = null;
	private closing = false;
	private exited = false;
	private seq = 0;
	private readonly stderrTail: string[] = [];

	constructor(
		private readonly host: ProviderHost,
		private readonly child: ManagedChild,
		private readonly nonce: string,
		private readonly gateFile: string,
		private readonly abortGraceMs: number,
	) {
		child.onMessage((msg) => this.dispatch(msg));
		child.onStderr((line) => {
			this.stderrTail.push(line);
			if (this.stderrTail.length > STDERR_TAIL) this.stderrTail.shift();
			host.log.debug(`[stderr] ${line}`);
		});
		child.onProblem((p) => host.log.warn(`pi ${p.kind}: ${p.detail}`));
		void child.exited.then((exit) => this.onExit(exit));
	}

	// ---- startup -------------------------------------------------------------

	waitReady(timeoutMs: number): Promise<void> {
		if (this.ready) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() =>
					reject(
						new Error(
							`pi did not confirm the approval gate within ${timeoutMs} ms; refusing to use it. A slow start (for example an npx-based install on a cold cache) can need more: raise providers.pi.startupTimeoutMs (WORKER_MCP_PI_STARTUP_TIMEOUT_MS).`,
						),
					),
				timeoutMs,
			);
			this.readyWaiters.push({
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
		});
	}

	setModel(model: string): void {
		// Split into provider/modelId; default to ollama when there is no slash.
		let provider = "ollama";
		let modelId = model;
		const slash = model.indexOf("/");
		if (slash !== -1) {
			provider = model.slice(0, slash);
			modelId = model.slice(slash + 1);
		}
		this.host.log.info(`configuring model ${provider}/${modelId}`);
		this.child.send({
			id: this.nextId("model"),
			type: "set_model",
			provider,
			modelId,
		});
	}

	private nextId(kind: string): string {
		return `${kind}_${++this.seq}`;
	}

	// ---- WorkerHandle --------------------------------------------------------

	async startRun(start: RunStart): Promise<void> {
		if (this.closing || this.exited) throw new Error("Process not running");
		if (this.run) throw new Error("a run is already active");
		let finish!: () => void;
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const run: ActiveRun = {
			runId: start.runId,
			abort: new AbortController(),
			abortRequested: false,
			done,
			finish,
		};
		this.run = run;
		start.signal.addEventListener("abort", () => void this.abortRun("signal"), {
			once: true,
		});
		const id = this.nextId("cmd");
		const accepted = new Promise<void>((resolve, reject) => {
			this.promptWaiter = { id, resolve, reject };
		});
		accepted.catch(() => {});
		const sent = this.child.send(
			{ id, type: "prompt", message: start.prompt },
			(err) => {
				if (err) this.promptWaiter?.reject(err);
			},
		);
		if (!sent) {
			this.promptWaiter = null;
			this.run = null;
			throw new Error("Process not running");
		}
		try {
			await accepted;
		} catch (e) {
			if (this.run === run) this.run = null;
			throw e;
		} finally {
			this.promptWaiter = null;
		}
	}

	abortRun(reason: string): Promise<void> {
		const run = this.run;
		if (!run) return Promise.resolve();
		// Idempotent: a second call while one is in flight shares it.
		this.aborting ??= this.doAbort(run, reason).finally(() => {
			this.aborting = null;
		});
		return this.aborting;
	}

	private async doAbort(run: ActiveRun, reason: string): Promise<void> {
		this.host.log.info(`abort requested: ${reason}`);
		run.abortRequested = true;
		// Pending approvals are denied before pi is told to abort, so it is
		// never left blocked inside a tool call.
		run.abort.abort();
		await Promise.allSettled(this.dialogs.values());
		if (this.run !== run) return;
		this.child.send({ id: this.nextId("abort"), type: "abort" });
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = await Promise.race([
			run.done.then(() => false),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(true), this.abortGraceMs);
			}),
		]);
		clearTimeout(timer);
		if (timedOut && this.run === run) {
			this.host.log.warn("abort did not settle; stopping the worker");
			this.closing = true;
			this.finishRun(run, "aborted");
			await this.child.terminate();
		}
	}

	async close(opts: { graceMs: number; reason: string }): Promise<void> {
		this.closing = true;
		const run = this.run;
		if (run) {
			run.abortRequested = true;
			run.abort.abort();
			this.finishRun(run, "aborted");
		}
		this.lifetime.abort();
		await Promise.allSettled(this.dialogs.values());
		await this.child.terminate(opts.graceMs);
		await this.child.exited;
	}

	// ---- events from pi ------------------------------------------------------

	private dispatch(msg: unknown): void {
		if (!isRecord(msg)) return;
		const run = this.run;
		switch (msg.type) {
			case "response":
				this.onResponse(msg);
				return;
			case "agent_start":
				if (run) this.host.emit({ type: "run_started", runId: run.runId });
				return;
			case "message_update": {
				const ev = msg.assistantMessageEvent;
				const delta =
					isRecord(ev) && typeof ev.delta === "string"
						? ev.delta
						: typeof msg.text === "string"
							? msg.text
							: "";
				if (run && delta) {
					this.host.emit({ type: "text_delta", runId: run.runId, text: delta });
				}
				return;
			}
			case "message_end": {
				const text = assistantText(msg);
				if (run && text !== null) {
					run.lastText = text;
					const usage = messageUsage(msg);
					if (usage) run.usage = usage;
					this.host.emit({
						type: "assistant_message",
						runId: run.runId,
						text,
						usage,
					});
				}
				return;
			}
			case "tool_execution_start":
				if (run && typeof msg.toolCallId === "string") {
					this.host.emit({
						type: "tool_started",
						runId: run.runId,
						toolName: String(msg.toolName ?? ""),
						input: msg.args,
						toolCallId: msg.toolCallId,
					});
				}
				return;
			case "tool_execution_end":
				if (run && typeof msg.toolCallId === "string") {
					this.host.emit({
						type: "tool_finished",
						runId: run.runId,
						toolCallId: msg.toolCallId,
						ok: msg.isError !== true,
						preview: resultPreview(msg.result, PREVIEW_CHARS),
					});
				}
				return;
			case "agent_settled":
				// `agent_end` can be followed by retries or queued work: the run is
				// over only when pi says it has settled.
				if (run)
					this.finishRun(run, run.abortRequested ? "aborted" : "completed");
				return;
			case "extension_ui_request":
				this.onUiRequest(msg);
				return;
			case "extension_error":
				this.onExtensionError(msg);
				return;
		}
	}

	private onResponse(msg: Record<string, unknown>): void {
		const waiter = this.promptWaiter;
		if (waiter && msg.id === waiter.id) {
			if (msg.success === false) {
				waiter.reject(new Error(String(msg.error ?? "pi rejected the prompt")));
			} else {
				waiter.resolve();
			}
			return;
		}
		if (msg.success === false) {
			this.host.emit({
				type: "notice",
				level: "warn",
				text: `pi rejected ${String(msg.command)}: ${String(msg.error ?? "")}`,
			});
		}
	}

	private onUiRequest(raw: Record<string, unknown>): void {
		const req = asUiRequest(raw);
		if (!req) return;
		switch (req.method) {
			case "setStatus":
				if (req.statusKey === GATE_STATUS_KEY) {
					if (req.statusText === `ready:${this.nonce}`) this.markReady();
					else {
						this.host.emit({
							type: "notice",
							level: "warn",
							text: "ignored a gate status with the wrong nonce",
							trusted: true,
						});
					}
				}
				return;
			case "notify":
				this.host.emit({
					type: "notice",
					runId: this.run?.runId,
					level: req.notifyType === "info" || !req.notifyType ? "info" : "warn",
					text: req.message ?? "",
				});
				return;
			case "input":
				if (req.title === GATE_DIALOG_TITLE) {
					this.onGateDialog(req.id, req.placeholder);
					return;
				}
			// falls through: any other input is a dialog the worker may not open
			case "select":
			case "confirm":
			case "editor":
				this.reply(req.id, { cancelled: true });
				this.host.emit({
					type: "notice",
					runId: this.run?.runId,
					level: "warn",
					text: `a "${req.method}" dialog from pi was answered with cancel`,
					trusted: true,
				});
				return;
			default:
			// setWidget, setTitle and the like need no answer
		}
	}

	private onGateDialog(id: string, placeholder: string | undefined): void {
		const request = parseGateRequest(placeholder, this.nonce);
		if (!request) {
			// Cancel makes the gate block the call.
			this.reply(id, { cancelled: true });
			this.host.emit({
				type: "notice",
				runId: this.run?.runId,
				level: "warn",
				text: "a gate request without a valid nonce was refused",
				trusted: true,
			});
			return;
		}
		const signal = (this.run?.abort ?? this.lifetime).signal;
		const decide = async (): Promise<ApprovalDecision> => {
			const aborted = new Promise<ApprovalDecision>((resolve) => {
				const deny = () =>
					resolve({ kind: "deny", reason: "the run was aborted" });
				if (signal.aborted) deny();
				else signal.addEventListener("abort", deny, { once: true });
			});
			return await Promise.race([
				this.host.requestApproval(
					{ callId: id, toolName: request.toolName, input: request.input },
					signal,
				),
				aborted,
			]);
		};
		const task = decide()
			.then((decision) =>
				this.reply(id, { value: encodeDecision(this.nonce, decision) }),
			)
			.catch(() =>
				// Fail closed.
				this.reply(id, { cancelled: true }),
			)
			.finally(() => this.dialogs.delete(id));
		this.dialogs.set(id, task);
	}

	private reply(
		id: string,
		body: { value: string } | { cancelled: true },
	): void {
		this.child.send({ type: "extension_ui_response", id, ...body });
	}

	private onExtensionError(msg: Record<string, unknown>): void {
		const text = `${String(msg.extensionPath ?? "")} ${String(msg.error ?? "")}`;
		this.host.emit({
			type: "notice",
			runId: this.run?.runId,
			level: "warn",
			text: `pi extension error: ${String(msg.error ?? "")}`,
		});
		if (!text.includes(this.gateFile)) return;
		// The gate itself is broken: nothing may run ungated.
		this.gateFailure = `the approval gate failed: ${String(msg.error ?? "unknown error")}`;
		if (!this.ready) {
			this.failReady(new Error(this.gateFailure));
			return;
		}
		const run = this.run;
		if (run) this.finishRun(run, "error", this.gateFailure);
		void this.child.terminate();
	}

	private markReady(): void {
		if (this.ready) return;
		this.ready = true;
		for (const w of this.readyWaiters.splice(0)) w.resolve();
	}

	private failReady(e: Error): void {
		for (const w of this.readyWaiters.splice(0)) w.reject(e);
	}

	private finishRun(
		run: ActiveRun,
		outcome: "completed" | "aborted" | "error",
		error?: string,
	): void {
		if (this.run !== run) return;
		this.run = null;
		this.host.emit({
			type: "run_finished",
			runId: run.runId,
			outcome,
			finalText: outcome === "error" ? undefined : run.lastText,
			usage: run.usage,
			error,
		});
		run.finish();
	}

	private onExit(exit: { code: number | null; signal: string | null }): void {
		this.exited = true;
		this.lifetime.abort();
		const how = describeExit(exit);
		const tail = stderrQuote(this.stderrTail);
		if (!this.ready) {
			this.failReady(
				new Error(
					`pi exited before the approval gate was ready (${how}).${tail}`,
				),
			);
		}
		const waiter = this.promptWaiter;
		if (waiter) waiter.reject(new Error(`pi exited (${how})`));
		const run = this.run;
		if (run) {
			if (this.closing) this.finishRun(run, "aborted");
			else
				this.finishRun(
					run,
					"error",
					`worker exited unexpectedly (${how}).${tail}`,
				);
		}
		this.host.emit({
			type: "exited",
			code: exit.code,
			signal: exit.signal,
			expected: this.closing && this.gateFailure === null,
		});
	}
}
