import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, describe, test } from "node:test";

import { defaultConfig } from "../../src/config.js";
import { ChildRegistry } from "../../src/core/child.js";
import { type OpenedWorker, openWorker } from "../../src/core/host.js";
import { createPiProvider } from "../../src/providers/pi/provider.js";
import type {
	ApprovalDecision,
	RawToolCall,
	WorkerEvent,
} from "../../src/providers/types.js";
import { RuntimeDir } from "../../src/session/runtime-dir.js";
import {
	createIsolation,
	FAKE_PI,
	type Isolation,
	pidGone,
	waitUntil,
} from "../helpers/isolation.js";

type Approver = (
	call: RawToolCall,
	signal: AbortSignal,
) => Promise<ApprovalDecision>;
const allow: Approver = async () => ({ kind: "allow" });

async function finished(events: WorkerEvent[], runId: string) {
	let done: Extract<WorkerEvent, { type: "run_finished" }> | undefined;
	await waitUntil(
		() => {
			done = events.find(
				(e): e is Extract<WorkerEvent, { type: "run_finished" }> =>
					e.type === "run_finished" && e.runId === runId,
			);
			return done !== undefined;
		},
		5000,
		"the run to finish",
	);
	return done!;
}

describe("pi provider against fake-pi", () => {
	let iso: Isolation;
	let runtime: RuntimeDir;
	const opened: OpenedWorker[] = [];

	before(() => {
		iso = createIsolation();
		runtime = new RuntimeDir(path.join(iso.root, "runtime"));
	});
	afterEach(async () => {
		for (const w of opened.splice(0)) {
			await w.close({ graceMs: 200, reason: "shutdown" });
		}
	});
	after(async () => {
		runtime.dispose();
		await iso.cleanup();
	});

	async function open(
		opts: {
			approve?: Approver;
			scenario?: string;
			startupTimeoutMs?: number;
			abortGraceMs?: number;
			piPath?: string;
			model?: string;
		} = {},
	) {
		const config = defaultConfig();
		config.providers.pi.path = opts.piPath ?? FAKE_PI;
		if (opts.startupTimeoutMs !== undefined) {
			config.providers.pi.startupTimeoutMs = opts.startupTimeoutMs;
		}
		const children = new ChildRegistry({
			env: {
				...iso.env,
				...(opts.scenario ? { FAKE_PI_SCENARIO: opts.scenario } : {}),
			},
			envConfig: { allow: ["FAKE_PI_*"], forceDropExempt: [] },
		});
		const events: WorkerEvent[] = [];
		const calls: RawToolCall[] = [];
		const approve = opts.approve ?? allow;
		const provider = createPiProvider(config, {
			abortGraceMs: opts.abortGraceMs,
		});
		const worker = await openWorker({
			provider,
			spec: {
				workerId: "w_test0001",
				cwd: iso.cwd,
				model: opts.model,
				options: {},
			},
			children,
			runtime,
			policy: { sandbox: "none", allowUngatedInSandbox: false },
			emit: (e) => events.push(e),
			approve: (call, signal) => {
				calls.push(call);
				return approve(call, signal);
			},
		});
		opened.push(worker);
		return { worker, events, calls, children };
	}

	let counter = 0;
	async function run(
		w: { worker: OpenedWorker; events: WorkerEvent[] },
		prompt: string,
	) {
		const runId = `r${++counter}`;
		await w.worker.handle.startRun({
			runId,
			prompt,
			signal: new AbortController().signal,
		});
		return await finished(w.events, runId);
	}
	describe("opening", () => {
		test("starts pi with the hardening flags, the per-spawn gate and a nonce", async () => {
			const known = iso.starts().length;
			const w = await open();
			const start = await iso.workerAfter(known);
			for (const flag of ["--no-extensions", "--no-mcp", "--no-approve"]) {
				assert.ok(start.argv.includes(flag), flag);
			}
			assert.strictEqual(start.argv[start.argv.indexOf("--mode") + 1], "rpc");
			const gate = start.argv[start.argv.indexOf("-e") + 1];
			assert.strictEqual(path.basename(gate), "gate.ts");
			assert.strictEqual(gate, path.join(w.worker.host.privateDir, "gate.ts"));
			assert.strictEqual(fs.statSync(gate).mode & 0o777, 0o600);
			assert.match(start.env.WORKER_MCP_GATE_NONCE, /^[0-9a-f]{32}$/);
		});

		test("each worker gets its own gate file and nonce", async () => {
			const known = iso.starts().length;
			const a = await open();
			const b = await open();
			const starts = iso.starts().slice(known);
			assert.notStrictEqual(a.worker.host.privateDir, b.worker.host.privateDir);
			assert.notStrictEqual(
				starts[0].env.WORKER_MCP_GATE_NONCE,
				starts[1].env.WORKER_MCP_GATE_NONCE,
			);
		});

		test("without the gate's ready status open() rejects and pi is killed", async () => {
			const known = iso.starts().length;
			const began = Date.now();
			await assert.rejects(
				open({ scenario: "no-gate-handshake", startupTimeoutMs: 400 }),
				/did not confirm the approval gate within 400 ms.*providers\.pi\.startupTimeoutMs/,
			);
			const waited = Date.now() - began;
			assert.ok(waited >= 350 && waited < 3000, `waited ${waited} ms`);
			const pid = (await iso.workerAfter(known)).pid;
			await waitUntil(() => pidGone(pid), 3000, "the half-open pi to die");
		});

		test("an extension error naming the gate rejects open()", async () => {
			await assert.rejects(
				open({ scenario: "gate-error" }),
				/approval gate failed: gate crashed/,
			);
		});

		test("pi exiting at startup rejects open() with what it said", async () => {
			await assert.rejects(
				open({ scenario: "exit-at-start" }),
				/exited before the approval gate was ready \(code 1\).*Failed to load extension/,
			);
		});

		test("a binary that cannot start is named in the error", async () => {
			await assert.rejects(
				open({ piPath: "worker-mcp-nonexistent-binary-xyz" }),
				/Failed to start pi \(worker-mcp-nonexistent-binary-xyz\)/,
			);
		});

		test("a workspace that does not exist is refused", async () => {
			const config = defaultConfig();
			config.providers.pi.path = FAKE_PI;
			const provider = createPiProvider(config);
			await assert.rejects(
				openWorker({
					provider,
					spec: {
						workerId: "w_test0002",
						cwd: path.join(iso.root, "missing"),
						options: {},
					},
					children: new ChildRegistry({
						env: iso.env,
						envConfig: { allow: [], forceDropExempt: [] },
					}),
					runtime,
					policy: { sandbox: "none", allowUngatedInSandbox: false },
					emit: () => {},
					approve: allow,
				}),
				/Workspace directory does not exist/,
			);
		});

		test("a model is set through set_model, defaulting the provider to ollama", async () => {
			const known = iso.received().length;
			await open({ model: "llama3" });
			await waitUntil(
				() => iso.received().slice(known).includes("set_model"),
				3000,
				"set_model",
			);
		});
	});

	describe("running", () => {
		test("a run maps pi's events and finishes once, on agent_settled", async () => {
			const w = await open();
			const done = await run(w, "hello");
			assert.strictEqual(done.outcome, "completed");
			assert.strictEqual(done.finalText, "fake-pi reply: hello");
			const types = w.events.map((e) => e.type);
			assert.ok(types.includes("run_started"));
			assert.ok(types.includes("assistant_message"));
			assert.strictEqual(types.filter((t) => t === "run_finished").length, 1);
		});

		test("a second run while one is active is refused", async () => {
			const w = await open();
			await w.worker.handle.startRun({
				runId: "a",
				prompt: "scenario:slow:5000",
				signal: new AbortController().signal,
			});
			await assert.rejects(
				w.worker.handle.startRun({
					runId: "b",
					prompt: "x",
					signal: new AbortController().signal,
				}),
				/already active/,
			);
			await w.worker.handle.abortRun("test");
		});

		test("an allowed call runs and is reported as a tool call", async () => {
			const w = await open();
			const done = await run(w, 'scenario:tool:bash:{"command":"ls"}');
			assert.strictEqual(done.finalText, 'tool bash ran with {"command":"ls"}');
			assert.deepStrictEqual(w.calls[0].input, { command: "ls" });
			assert.strictEqual(w.calls[0].toolName, "bash");
			assert.ok(w.events.some((e) => e.type === "tool_started"));
			assert.ok(w.events.some((e) => e.type === "tool_finished" && e.ok));
		});

		test("a deny carries its reason to the worker", async () => {
			const w = await open({
				approve: async () => ({ kind: "deny", reason: "not on my watch" }),
			});
			const done = await run(w, 'scenario:tool:bash:{"command":"rm x"}');
			assert.strictEqual(done.finalText, "tool bash blocked: not on my watch");
			assert.ok(!w.events.some((e) => e.type === "tool_started"));
		});

		test("a mutate rewrites the input the tool runs with", async () => {
			const w = await open({
				approve: async () => ({
					kind: "mutate",
					input: { command: "ls --color=never" },
				}),
			});
			const done = await run(w, 'scenario:mutate:bash:{"command":"ls"}');
			assert.strictEqual(
				done.finalText,
				'tool bash ran with {"command":"ls --color=never"}',
			);
		});

		test("two calls at once each get their own answer", async () => {
			const waiting: {
				call: RawToolCall;
				answer: (d: ApprovalDecision) => void;
			}[] = [];
			const w = await open({
				approve: (call) =>
					new Promise((resolve) => waiting.push({ call, answer: resolve })),
			});
			const runId = `r${++counter}`;
			await w.worker.handle.startRun({
				runId,
				prompt: 'scenario:parallel-tools:bash:{"command":"ls"}',
				signal: new AbortController().signal,
			});
			await waitUntil(() => waiting.length === 2, 3000, "both approvals");
			assert.notStrictEqual(waiting[0].call.callId, waiting[1].call.callId);
			// Answer out of order: the second call is denied, the first allowed.
			const byN = (n: number) =>
				waiting.find((x) => x.call.input.n === n) as (typeof waiting)[number];
			byN(2).answer({ kind: "deny", reason: "second no" });
			byN(1).answer({ kind: "allow" });
			const done = await finished(w.events, runId);
			assert.match(done.finalText ?? "", /1: ran with .*"n":1/);
			assert.match(done.finalText ?? "", /2: blocked: second no/);
		});

		for (const method of ["select", "input", "editor", "confirm"]) {
			test(`a ${method} dialog that is not the gate is answered with cancel`, async () => {
				const w = await open();
				const done = await run(w, `scenario:dialog:${method}`);
				assert.strictEqual(done.finalText, `dialog ${method} cancelled`);
				assert.ok(
					w.events.some(
						(e) =>
							e.type === "notice" &&
							e.level === "warn" &&
							e.text.includes(method),
					),
				);
				assert.strictEqual(w.calls.length, 0, "the gate was not asked");
			});
		}

		test("an unexpected exit ends the run with an error and is reported", async () => {
			const w = await open();
			const done = await run(w, "scenario:crash-mid-run");
			assert.strictEqual(done.outcome, "error");
			assert.match(done.error ?? "", /worker exited unexpectedly \(code 1/);
			await waitUntil(
				() => w.events.some((e) => e.type === "exited"),
				3000,
				"the exit",
			);
			const exit = w.events.find((e) => e.type === "exited");
			assert.strictEqual(exit?.type === "exited" && exit.expected, false);
			// A run asked for after the exit fails at once.
			await assert.rejects(
				w.worker.handle.startRun({
					runId: "late",
					prompt: "x",
					signal: new AbortController().signal,
				}),
				/not running/,
			);
		});
	});

	describe("abort and close", () => {
		test("abort while an approval is pending denies it and ends the run as aborted", async () => {
			let aborted = false;
			const w = await open({
				approve: (_call, signal) =>
					new Promise((resolve) => {
						signal.addEventListener("abort", () => {
							aborted = true;
							resolve({ kind: "deny", reason: "aborted" });
						});
					}),
			});
			const runId = `r${++counter}`;
			await w.worker.handle.startRun({
				runId,
				prompt: 'scenario:tool:bash:{"command":"ls"}',
				signal: new AbortController().signal,
			});
			await waitUntil(() => w.calls.length === 1, 3000, "the approval");
			const first = w.worker.handle.abortRun("test");
			assert.strictEqual(first, w.worker.handle.abortRun("again"));
			await first;
			const done = await finished(w.events, runId);
			assert.strictEqual(done.outcome, "aborted");
			assert.ok(aborted);
			await w.worker.handle.abortRun("late"); // nothing running: fine
		});

		test("a worker that ignores the abort is stopped after the grace period", async () => {
			const known = iso.starts().length;
			const w = await open({ abortGraceMs: 300 });
			const pid = (await iso.workerAfter(known)).pid;
			const runId = `r${++counter}`;
			await w.worker.handle.startRun({
				runId,
				prompt: "scenario:ignore-abort",
				signal: new AbortController().signal,
			});
			const began = Date.now();
			await w.worker.handle.abortRun("test");
			assert.ok(Date.now() - began >= 250, "waited for pi to settle first");
			const done = await finished(w.events, runId);
			assert.strictEqual(done.outcome, "aborted");
			await waitUntil(() => pidGone(pid), 3000, "the stuck worker to die");
			const exit = w.events.find((e) => e.type === "exited");
			assert.strictEqual(exit?.type === "exited" && exit.expected, true);
		});

		test("close stops the process, reports an expected exit and is idempotent", async () => {
			const known = iso.starts().length;
			const w = await open();
			const pid = (await iso.workerAfter(known)).pid;
			const first = w.worker.close({ graceMs: 200, reason: "requested" });
			assert.strictEqual(
				first,
				w.worker.close({ graceMs: 200, reason: "shutdown" }),
			);
			await first;
			assert.ok(pidGone(pid));
			const exit = w.events.find((e) => e.type === "exited");
			assert.strictEqual(exit?.type === "exited" && exit.expected, true);
		});

		test("close while a run is active ends it as aborted, not as an error", async () => {
			const w = await open();
			const runId = `r${++counter}`;
			await w.worker.handle.startRun({
				runId,
				prompt: "scenario:slow:600000",
				signal: new AbortController().signal,
			});
			await w.worker.close({ graceMs: 200, reason: "requested" });
			const finish = w.events.filter(
				(e) => e.type === "run_finished" && e.runId === runId,
			);
			assert.strictEqual(finish.length, 1);
			assert.strictEqual(
				finish[0].type === "run_finished" && finish[0].outcome,
				"aborted",
			);
		});
	});
});
