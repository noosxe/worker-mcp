import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import { type Config, defaultConfig } from "../config.js";
import { FakeProvider } from "../providers/fake/provider.js";
import { RuntimeDir } from "../session/runtime-dir.js";
import { RunError, Session } from "../session/session.js";

const bash = (command: string) => `tool:bash:${JSON.stringify({ command })}`;

function config(
	limits: Partial<Config["limits"]> = {},
	gate: Partial<Config["gate"]> = {},
): Config {
	const base = defaultConfig();
	return {
		...base,
		limits: { ...base.limits, ...limits },
		gate: { ...base.gate, ...gate },
	};
}

describe("Runs on a Session over the fake provider", () => {
	let root: string;
	let runtime: RuntimeDir;
	let counter = 0;

	before(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-mcp-runs-"));
		fs.mkdirSync(path.join(root, "home"));
		fs.mkdirSync(path.join(root, "ws"));
		runtime = new RuntimeDir(path.join(root, "runtime"));
	});
	after(() => {
		runtime.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	});

	async function start(
		cfg: Config = config(),
		provider = new FakeProvider(),
		abortGraceMs = 3000,
	) {
		const session = new Session(
			`s${++counter}`,
			path.join(root, "ws"),
			undefined,
			undefined,
			undefined,
			{
				config: cfg,
				env: { HOME: path.join(root, "home") },
				runtime,
				provider,
				abortGraceMs,
			},
		);
		await session.start();
		return session;
	}

	test("a run goes starting, running, completed and keeps its result", async () => {
		const s = await start();
		const run = await s.startRun("hello", "say hello");
		assert.strictEqual(run.intent, "say hello");
		assert.notStrictEqual(run.state, "starting");
		assert.strictEqual(
			await s.runs.waitForChange(run, { maxWaitMs: 5000 }),
			"terminal",
		);
		assert.strictEqual(run.state, "completed");
		assert.strictEqual(run.output.all, "fake reply: hello");
		assert.deepStrictEqual(run.usage, { inputTokens: 1, outputTokens: 1 });
		assert.strictEqual(s.runs.get(run.id), run);
		assert.strictEqual(s.activeRun, null);
		await s.terminate();
	});

	test("only one run at a time; the error names the run in flight", async () => {
		const s = await start();
		const first = await s.startRun("hang");
		await assert.rejects(
			s.startRun("again"),
			(e: unknown) =>
				e instanceof RunError &&
				e.code === "WORKER_BUSY" &&
				e.runId === first.id,
		);
		s.cancelRun();
		await s.runs.waitForChange(first, { maxWaitMs: 5000 });
		assert.strictEqual(first.state, "cancelled");
		// The worker takes the next run.
		const next = await s.startRun("after");
		await s.runs.waitForChange(next, { maxWaitMs: 5000 });
		assert.strictEqual(next.state, "completed");
		await s.terminate();
	});

	test("a run settles once, whatever happens after", async () => {
		const s = await start();
		const run = await s.startRun("hang");
		s.cancelRun();
		await s.runs.waitForChange(run, { maxWaitMs: 5000 });
		assert.strictEqual(run.state, "cancelled");
		const endedAt = run.endedAt;
		// A crash and a terminate after the run ended change nothing.
		(s as unknown as { onEvent(e: unknown): void }).onEvent({
			type: "exited",
			code: 1,
			signal: null,
			expected: false,
		});
		await s.terminate();
		assert.strictEqual(run.state, "cancelled");
		assert.strictEqual(run.error, undefined);
		assert.strictEqual(run.endedAt, endedAt);
	});

	test("a failing run records the error", async () => {
		const s = await start();
		const run = await s.startRun("crash");
		await s.runs.waitForChange(run, { maxWaitMs: 5000 });
		assert.strictEqual(run.state, "failed");
		assert.match(run.error ?? "", /fake worker crashed/);
		await s.terminate();
	});

	test("a worker that dies mid-run fails the run", async () => {
		const provider = new FakeProvider();
		const s = await start(config(), provider);
		const run = await s.startRun("hang");
		provider.opened[0].crash(1);
		assert.strictEqual(run.state, "failed");
		assert.match(run.error ?? "", /exited unexpectedly \(code 1\)/);
	});

	describe("approvals", () => {
		test("an approval wakes a wait; approve then lets the run finish", async () => {
			const s = await start();
			const run = await s.startRun(bash("rm f"));
			const started = Date.now();
			const reason = await s.runs.waitForChange(run, { maxWaitMs: 5000 });
			assert.strictEqual(reason, "approval");
			assert.ok(Date.now() - started < 2000);
			assert.strictEqual(run.state, "awaiting_approval");
			assert.strictEqual(run.approvals.size, 1);
			const [info] = [...run.approvals.values()];
			assert.strictEqual(info.tool, "bash");
			assert.strictEqual(info.summary, "rm f");

			// Answering returns at once and does not wait for the worker.
			const answered = s.approveAction(info.actionId);
			assert.strictEqual(answered, run);
			assert.strictEqual(
				await s.runs.waitForChange(run, { maxWaitMs: 5000 }),
				"terminal",
			);
			assert.match(run.output.all, /^bash ran with /);
			assert.strictEqual(run.gate.escalated, 1);
			await s.terminate();
		});

		test("an approval nobody answers is denied with a reason the worker sees", async () => {
			const s = await start(config({}, { approvalTimeoutMs: 80 }));
			const run = await s.startRun(bash("rm f"));
			assert.strictEqual(
				await s.runs.waitForChange(run, { maxWaitMs: 5000 }),
				"approval",
			);
			const seen = run.seq;
			// The expiry itself wakes a caller that already saw the approval.
			assert.strictEqual(
				await s.runs.waitForChange(run, { sinceSeq: seen, maxWaitMs: 5000 }),
				"approval",
			);
			assert.strictEqual(run.approvals.size, 0);
			assert.strictEqual(
				await s.runs.waitForChange(run, { sinceSeq: run.seq, maxWaitMs: 5000 }),
				"terminal",
			);
			assert.match(run.output.all, /^bash blocked: approval timed out/);
			assert.match(run.output.all, /did not answer within/);
			const last = s.getGateLog().at(-1);
			assert.strictEqual(last?.decidedBy, "timeout");
			assert.strictEqual(last?.decision, "deny");
			await s.terminate();
		});

		test("an answered approval is not denied later by its timer", async () => {
			const s = await start(config({}, { approvalTimeoutMs: 60 }));
			const run = await s.startRun(bash("rm f"));
			await s.runs.waitForChange(run, { maxWaitMs: 5000 });
			s.approveAction([...run.approvals.keys()][0]);
			await s.runs.waitForChange(run, { maxWaitMs: 5000 });
			await new Promise((r) => setTimeout(r, 120));
			assert.match(run.output.all, /^bash ran with /);
			assert.deepStrictEqual(
				s.getGateLog().map((e) => e.decidedBy),
				["rules", "coordinator"],
			);
			await s.terminate();
		});

		test("cancelling a run with an approval pending denies the call", async () => {
			const s = await start();
			const run = await s.startRun(bash("rm f"));
			await s.runs.waitForChange(run, { maxWaitMs: 5000 });
			s.cancelRun();
			await s.runs.waitForChange(run, { sinceSeq: run.seq, maxWaitMs: 5000 });
			assert.strictEqual(run.state, "cancelled");
			assert.strictEqual(run.approvals.size, 0);
			assert.strictEqual(s.pendingAction, null);
			assert.strictEqual(s.getGateLog().at(-1)?.decidedBy, "cancel");
			await s.terminate();
		});
	});

	describe("limits", () => {
		test("maxRunMs aborts the run and it ends timed_out", async () => {
			const s = await start(config({ maxRunMs: 80 }));
			const run = await s.startRun("hang");
			await s.runs.waitForChange(run, { maxWaitMs: 5000 });
			assert.strictEqual(run.state, "timed_out");
			assert.match(run.error ?? "", /exceeded the 80 ms limit/);
			// The worker was aborted, not killed: it takes the next run.
			assert.strictEqual(s.isAlive(), true);
			const next = await s.startRun("again");
			await s.runs.waitForChange(next, { maxWaitMs: 5000 });
			assert.strictEqual(next.state, "completed");
			await s.terminate();
		});

		test("a worker that ignores the abort is forced: the run ends and the worker closes", async () => {
			const s = await start(config({ maxRunMs: 50 }), new FakeProvider(), 50);
			const run = await s.startRun("stubborn");
			await s.runs.waitForChange(run, { maxWaitMs: 5000 });
			assert.strictEqual(run.state, "timed_out");
			await new Promise((r) => setTimeout(r, 100));
			assert.strictEqual(s.isAlive(), false);
			assert.strictEqual(s.status, "CRASHED");
		});

		test("a worker that never accepts the prompt fails the run promptly", async () => {
			const s = await start(
				config({ runStartTimeoutMs: 60 }),
				new FakeProvider({ neverAccept: true }),
			);
			await assert.rejects(
				s.startRun("hello"),
				(e: unknown) =>
					e instanceof RunError &&
					e.code === "RUN_START_FAILED" &&
					/did not accept the prompt within 60 ms/.test(e.message),
			);
			const [run] = s.runs.runsOf(s.sessionId);
			assert.strictEqual(run.state, "failed");
			await s.terminate();
		});

		test("a message past the output budget fails the run", async () => {
			const s = await start(config({ maxOutputChars: 1000 }));
			const run = await s.startRun("flood:5000");
			await s.runs.waitForChange(run, { maxWaitMs: 5000 });
			assert.strictEqual(run.state, "failed");
			assert.match(run.error ?? "", /output limit exceeded/);
			await s.terminate();
		});

		test("output past the buffer drops the oldest and says so", async () => {
			const s = await start(config({ outputBufferChars: 100 }));
			const run = await s.startRun("big:500");
			await s.runs.waitForChange(run, { maxWaitMs: 5000 });
			assert.strictEqual(run.state, "completed");
			assert.strictEqual(run.output.total, 500);
			assert.strictEqual(run.output.all.length, 100);
			assert.strictEqual(run.output.truncated, true);
			await s.terminate();
		});

		test("a worker repeating one line is stopped", async () => {
			const s = await start();
			const run = await s.startRun("repeat:1000");
			await s.runs.waitForChange(run, { maxWaitMs: 5000 });
			assert.strictEqual(run.state, "failed");
			assert.match(run.error ?? "", /repeated output/);
			await s.terminate();
		});

		test("Markdown rules and tables do not trip the repeat check", async () => {
			const s = await start();
			const run = await s.startRun("markdown-rules");
			await s.runs.waitForChange(run, { maxWaitMs: 5000 });
			assert.strictEqual(run.state, "completed");
			assert.strictEqual(
				run.output.all,
				"Title\n----\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n----\n",
			);
			await s.terminate();
		});
	});

	describe("waiting from a caller", () => {
		test("a client that gives up detaches; the run carries on", async () => {
			const s = await start();
			const run = await s.startRun("slow:1000");
			const controller = new AbortController();
			const waiting = s.waitText(run, { signal: controller.signal });
			setTimeout(() => controller.abort(), 20);
			assert.strictEqual(await waiting, null);
			assert.strictEqual(run.state, "running", "the run was not cancelled");
			await s.runs.waitForChange(run, { maxWaitMs: 5000 });
			assert.strictEqual(run.state, "completed");
			assert.strictEqual(run.output.all, "slow done");
			await s.terminate();
		});

		test("a blocking wait with a timeout returns null and the run goes on", async () => {
			const s = await start();
			const run = await s.startRun("slow:1000");
			assert.strictEqual(await s.waitText(run, { timeoutMs: 30 }), null);
			assert.strictEqual(run.state, "running");
			assert.strictEqual(await s.waitText(run), "slow done");
			await s.terminate();
		});
	});

	describe("retention", () => {
		test("the conversation history is bounded", async () => {
			const s = await start();
			for (let i = 0; i < 260; i++) {
				const run = await s.startRun(`n${i}`);
				await s.runs.waitForChange(run, { maxWaitMs: 5000 });
			}
			// Two entries per run, capped.
			assert.strictEqual(s.history.length, 500);
			await s.terminate();
		});

		test("a result is readable after the worker is terminated", async () => {
			const s = await start();
			const run = await s.startRun("hello");
			await s.runs.waitForChange(run, { maxWaitMs: 5000 });
			await s.terminate();
			const kept = s.runs.get(run.id);
			assert.strictEqual(kept?.state, "completed");
			assert.strictEqual(kept?.output.all, "fake reply: hello");
		});

		test("terminating mid-run ends the run and keeps it", async () => {
			const s = await start();
			const run = await s.startRun("hang");
			await s.terminate();
			assert.strictEqual(run.state, "cancelled");
			assert.match(run.error ?? "", /worker terminated/);
			assert.strictEqual(s.runs.get(run.id), run);
		});

		test("shutting down fails the run with that reason", async () => {
			const s = await start();
			const run = await s.startRun("hang");
			await s.terminate("shutdown");
			assert.strictEqual(run.state, "failed");
			assert.strictEqual(run.error, "server shutting down");
		});

		test("the number of kept runs is capped", async () => {
			const s = await start(config({ maxRetainedRuns: 3 }));
			const ids: string[] = [];
			for (let i = 0; i < 5; i++) {
				const run = await s.startRun(`n${i}`);
				await s.runs.waitForChange(run, { maxWaitMs: 5000 });
				ids.push(run.id);
			}
			assert.strictEqual(s.runs.get(ids[0]), undefined);
			assert.strictEqual(s.runs.get(ids[1]), undefined);
			assert.ok(s.runs.get(ids[4]));
			assert.strictEqual(s.runs.size, 3);
			await s.terminate();
		});

		test("results expire some time after the worker is gone", async () => {
			const s = await start(config({ resultRetentionMs: 60 }));
			const run = await s.startRun("hello");
			await s.runs.waitForChange(run, { maxWaitMs: 5000 });
			await s.terminate();
			assert.ok(s.runs.get(run.id));
			await new Promise((r) => setTimeout(r, 100));
			assert.strictEqual(s.runs.get(run.id), undefined);
		});
	});
});
