import assert from "node:assert";
import { describe, test } from "node:test";

import { noopLogger } from "../../core/log.js";
import { FakeHandle, FakeProvider } from "../fake/provider.js";
import {
	ProviderError,
	ProviderRegistry,
	assertOpenable,
} from "../registry.js";
import type {
	ApprovalDecision,
	ProviderHost,
	RawToolCall,
	WorkerEvent,
} from "../types.js";

/** A host with no processes: records events and answers approvals by script. */
function makeHost(
	approve: (
		call: RawToolCall,
		signal: AbortSignal,
	) => Promise<ApprovalDecision>,
) {
	const events: WorkerEvent[] = [];
	const calls: RawToolCall[] = [];
	const host: ProviderHost = {
		spawn() {
			throw new Error("the fake provider never spawns");
		},
		emit: (e) => events.push(e),
		requestApproval: async (call, signal) => {
			calls.push(call);
			return approve(call, signal);
		},
		privateDir: "/nonexistent",
		log: noopLogger,
	};
	return { host, events, calls };
}

const allow = async (): Promise<ApprovalDecision> => ({ kind: "allow" });
const SPEC = { workerId: "w_test0001", cwd: "/", options: {} };

async function runToEnd(
	handle: FakeHandle,
	events: WorkerEvent[],
	prompt: string,
	runId = "r1",
) {
	await handle.startRun({
		runId,
		prompt,
		signal: new AbortController().signal,
	});
	for (let i = 0; i < 200; i++) {
		const done = events.find(
			(e) => e.type === "run_finished" && e.runId === runId,
		);
		if (done) return done;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("run did not finish");
}

describe("FakeProvider: interface contract", () => {
	test("a run emits started, output, then exactly one run_finished", async () => {
		const { host, events } = makeHost(allow);
		const handle = (await new FakeProvider().open(SPEC, host)) as FakeHandle;
		const done = await runToEnd(handle, events, "hello");
		assert.deepStrictEqual(
			events.map((e) => e.type),
			["run_started", "text_delta", "assistant_message", "run_finished"],
		);
		assert.strictEqual(
			done.type === "run_finished" && done.finalText,
			"fake reply: hello",
		);
		assert.strictEqual(
			events.filter((e) => e.type === "run_finished").length,
			1,
		);
	});

	test("startRun resolves on acceptance, not when the run ends", async () => {
		const { host, events } = makeHost(allow);
		const handle = await new FakeProvider().open(SPEC, host);
		await handle.startRun({
			runId: "r1",
			prompt: "hang",
			signal: new AbortController().signal,
		});
		assert.ok(!events.some((e) => e.type === "run_finished"));
		await handle.abortRun("test");
	});

	test("a second run while one is active is refused", async () => {
		const { host } = makeHost(allow);
		const handle = await new FakeProvider().open(SPEC, host);
		const signal = new AbortController().signal;
		await handle.startRun({ runId: "r1", prompt: "hang", signal });
		await assert.rejects(handle.startRun({ runId: "r2", prompt: "x", signal }));
		await handle.abortRun("test");
	});

	test("an allowed call runs with its input; the approval carries the call", async () => {
		const { host, events, calls } = makeHost(allow);
		const handle = (await new FakeProvider().open(SPEC, host)) as FakeHandle;
		await runToEnd(handle, events, 'tool:bash:{"command":"ls"}');
		assert.deepStrictEqual(handle.ran, [{ command: "ls" }]);
		assert.strictEqual(calls[0].toolName, "bash");
		assert.deepStrictEqual(calls[0].input, { command: "ls" });
		assert.ok(events.some((e) => e.type === "tool_started"));
		assert.ok(events.some((e) => e.type === "tool_finished"));
	});

	test("a deny reaches the worker with its reason and the tool does not run", async () => {
		const { host, events } = makeHost(async () => ({
			kind: "deny",
			reason: "not on my watch",
		}));
		const handle = (await new FakeProvider().open(SPEC, host)) as FakeHandle;
		const done = await runToEnd(handle, events, 'tool:bash:{"command":"rm x"}');
		assert.deepStrictEqual(handle.ran, []);
		assert.match(
			(done.type === "run_finished" && done.finalText) || "",
			/blocked: not on my watch/,
		);
	});

	test("mutate replaces the input when the provider can mutate", async () => {
		const { host, events } = makeHost(async () => ({
			kind: "mutate",
			input: { command: "ls --safe" },
		}));
		const handle = (await new FakeProvider().open(SPEC, host)) as FakeHandle;
		await runToEnd(handle, events, 'tool:bash:{"command":"ls"}');
		assert.deepStrictEqual(handle.ran, [{ command: "ls --safe" }]);
	});

	test("mutate fails closed when the provider cannot mutate", async () => {
		const { host, events } = makeHost(async () => ({
			kind: "mutate",
			input: { command: "ls --safe" },
		}));
		const provider = new FakeProvider({ capabilities: { mutateInput: false } });
		const handle = (await provider.open(SPEC, host)) as FakeHandle;
		await runToEnd(handle, events, 'tool:bash:{"command":"ls"}');
		assert.deepStrictEqual(handle.ran, []);
	});

	test("parallel tool calls each get their own decision", async () => {
		const pending: ((d: ApprovalDecision) => void)[] = [];
		const { host, events, calls } = makeHost(
			() => new Promise((resolve) => pending.push(resolve)),
		);
		const handle = (await new FakeProvider().open(SPEC, host)) as FakeHandle;
		await handle.startRun({
			runId: "r1",
			prompt: 'parallel:bash:{"command":"ls"}',
			signal: new AbortController().signal,
		});
		for (let i = 0; i < 100 && pending.length < 2; i++) {
			await new Promise((r) => setTimeout(r, 5));
		}
		assert.strictEqual(pending.length, 2, "both approvals pending at once");
		assert.notStrictEqual(calls[0].callId, calls[1].callId);
		pending[1]({ kind: "deny", reason: "second no" });
		pending[0]({ kind: "allow" });
		for (
			let i = 0;
			i < 100 && !events.some((e) => e.type === "run_finished");
			i++
		) {
			await new Promise((r) => setTimeout(r, 5));
		}
		assert.strictEqual(handle.ran.length, 1);
	});

	test("abortRun while an approval is pending ends the run as aborted", async () => {
		const { host, events } = makeHost(
			(_call, signal) =>
				new Promise((resolve) =>
					signal.addEventListener(
						"abort",
						() => resolve({ kind: "deny", reason: "aborted" }),
						{ once: true },
					),
				),
		);
		const handle = (await new FakeProvider().open(SPEC, host)) as FakeHandle;
		await handle.startRun({
			runId: "r1",
			prompt: 'tool:bash:{"command":"ls"}',
			signal: new AbortController().signal,
		});
		await new Promise((r) => setTimeout(r, 20));
		await handle.abortRun("user");
		const done = events.find((e) => e.type === "run_finished");
		assert.strictEqual(
			done?.type === "run_finished" && done.outcome,
			"aborted",
		);
		assert.deepStrictEqual(handle.ran, []);
	});

	test("abortRun is idempotent: concurrent and late calls are safe", async () => {
		const { host, events } = makeHost(allow);
		const handle = await new FakeProvider().open(SPEC, host);
		await handle.abortRun("nothing running");
		await handle.startRun({
			runId: "r1",
			prompt: "hang",
			signal: new AbortController().signal,
		});
		const first = handle.abortRun("a");
		const second = handle.abortRun("b");
		assert.strictEqual(first, second, "one abort in flight");
		await Promise.all([first, second]);
		await handle.abortRun("after");
		assert.strictEqual(
			events.filter((e) => e.type === "run_finished").length,
			1,
		);
	});

	test("the run's own signal aborts it", async () => {
		const { host, events } = makeHost(allow);
		const handle = await new FakeProvider().open(SPEC, host);
		const abort = new AbortController();
		await handle.startRun({
			runId: "r1",
			prompt: "hang",
			signal: abort.signal,
		});
		abort.abort();
		for (
			let i = 0;
			i < 100 && !events.some((e) => e.type === "run_finished");
			i++
		) {
			await new Promise((r) => setTimeout(r, 5));
		}
		const done = events.find((e) => e.type === "run_finished");
		assert.strictEqual(
			done?.type === "run_finished" && done.outcome,
			"aborted",
		);
	});

	test("a worker that fails ends its run with an error, once", async () => {
		const { host, events } = makeHost(allow);
		const handle = (await new FakeProvider().open(SPEC, host)) as FakeHandle;
		const done = await runToEnd(handle, events, "crash");
		assert.strictEqual(done.type === "run_finished" && done.outcome, "error");
		assert.match((done.type === "run_finished" && done.error) || "", /crashed/);
	});

	test("close aborts the run, reports an expected exit and is idempotent", async () => {
		const { host, events } = makeHost(allow);
		const handle = await new FakeProvider().open(SPEC, host);
		await handle.startRun({
			runId: "r1",
			prompt: "hang",
			signal: new AbortController().signal,
		});
		const first = handle.close({ graceMs: 10, reason: "requested" });
		assert.strictEqual(
			first,
			handle.close({ graceMs: 10, reason: "shutdown" }),
		);
		await first;
		assert.deepStrictEqual(
			events.filter((e) => e.type === "exited"),
			[{ type: "exited", code: 0, signal: null, expected: true }],
		);
		await assert.rejects(
			handle.startRun({
				runId: "r2",
				prompt: "x",
				signal: new AbortController().signal,
			}),
		);
	});

	test("open() can fail", async () => {
		const { host } = makeHost(allow);
		await assert.rejects(
			new FakeProvider({ failOpen: "no gate" }).open(SPEC, host),
			/no gate/,
		);
	});
});

describe("provider registry", () => {
	const factories = { fake: async () => new FakeProvider() };

	test("returns the default provider and caches the load", async () => {
		const registry = new ProviderRegistry({ factories });
		assert.deepStrictEqual(registry.ids(), ["fake"]);
		const a = await registry.get();
		assert.strictEqual(a, await registry.get("fake"));
		assert.strictEqual(a.id, "fake");
	});

	test("refuses a provider that is not enabled or unknown", async () => {
		const registry = new ProviderRegistry({
			factories: { ...factories, other: async () => new FakeProvider() },
			enabled: ["fake"],
		});
		await assert.rejects(registry.get("other"), ProviderError);
		await assert.rejects(registry.get("../../evil"), /not available/);
		assert.throws(
			() => new ProviderRegistry({ factories, enabled: ["nope"] }),
			ProviderError,
		);
		assert.throws(
			() => new ProviderRegistry({ factories, defaultId: "nope" }),
			ProviderError,
		);
	});

	test("the built-in set is static: no id can come from outside", async () => {
		const registry = new ProviderRegistry();
		assert.deepStrictEqual(registry.ids(), []);
		await assert.rejects(registry.get("pi"), /not available|No provider/);
	});

	test("a provider that cannot gate is refused outside the sandbox", () => {
		const ungated = new FakeProvider({ capabilities: { approvals: "none" } });
		assert.throws(
			() =>
				assertOpenable(ungated, {
					sandbox: "none",
					allowUngatedInSandbox: true,
				}),
			/cannot gate/,
		);
		assert.throws(
			() =>
				assertOpenable(ungated, {
					sandbox: "workspace",
					allowUngatedInSandbox: false,
				}),
			/cannot gate/,
		);
		assertOpenable(ungated, {
			sandbox: "workspace",
			allowUngatedInSandbox: true,
		});
		assertOpenable(new FakeProvider(), {
			sandbox: "none",
			allowUngatedInSandbox: false,
		});
	});
});
