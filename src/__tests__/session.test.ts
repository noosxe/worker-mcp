import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, test } from "node:test";

import { defaultConfig } from "../config.js";
import { RiskLevel } from "../gate/risk.js";
import { FakeProvider } from "../providers/fake/provider.js";
import { BoundedLog } from "../session/bounded-log.js";
import { detectLoop } from "../session/loop-detector.js";
import { RuntimeDir } from "../session/runtime-dir.js";
import { Session } from "../session/session.js";

describe("detectLoop", () => {
	const LIMIT = defaultConfig().limits.maxOutputChars;

	test("normal text is not a loop", () => {
		assert.strictEqual(
			detectLoop("Hello world! How are you today?", LIMIT),
			false,
		);
		assert.strictEqual(
			detectLoop(
				"This is a long line of code that explains the requirements and has no repetitive sequences.",
				LIMIT,
			),
			false,
		);
	});

	test("repeated short patterns are a loop", () => {
		assert.strictEqual(detectLoop("a".repeat(25), LIMIT), true);
		assert.strictEqual(detectLoop("ab".repeat(12), LIMIT), true);
		assert.strictEqual(detectLoop("abc".repeat(9), LIMIT), true);
		assert.strictEqual(detectLoop("a".repeat(10), LIMIT), false);
	});

	test("output past the size cap is a loop", () => {
		assert.strictEqual(detectLoop("x".repeat(101), 100), true);
	});
});

describe("BoundedLog", () => {
	test("keeps the most recent lines", () => {
		const log = new BoundedLog(100);
		for (let i = 0; i < 500; i++) log.push(`line ${i}`);
		assert.strictEqual(log.lines.length, 100);
		assert.strictEqual(log.lines.at(-1), "line 499");
		assert.strictEqual(log.lines[0], "line 400");
	});
});

const tool = (name: string, input: unknown) =>
	`tool:${name}:${JSON.stringify(input)}`;

describe("Session over the fake provider", () => {
	let root: string;
	let runtime: RuntimeDir;
	let provider: FakeProvider;
	let counter = 0;

	before(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-mcp-session-"));
		fs.mkdirSync(path.join(root, "home"));
		fs.mkdirSync(path.join(root, "ws"));
		runtime = new RuntimeDir(path.join(root, "runtime"));
	});
	afterEach(() => {
		provider = undefined as never;
	});
	after(() => {
		runtime.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	});

	async function start(policy?: unknown, p = new FakeProvider()) {
		provider = p;
		const session = new Session(
			`s${++counter}`,
			path.join(root, "ws"),
			undefined,
			undefined,
			policy,
			{
				env: { HOME: path.join(root, "home") },
				runtime,
				provider: p,
			},
		);
		await session.start();
		return session;
	}
	const confirmBash = tool("bash", { command: "rm f" });

	test("a plain command returns the assistant's text and the session is idle again", async () => {
		const s = await start();
		assert.strictEqual(s.status, "IDLE");
		assert.strictEqual(await s.sendCommand("hi"), "fake reply: hi");
		assert.strictEqual(s.status, "IDLE");
		assert.strictEqual(s.isAlive(), true);
		await s.terminate();
	});

	test("summarize is ignored and noted", async () => {
		const s = await start();
		const out = await s.sendCommand("hi", true);
		assert.match(out, /^fake reply: hi\n\nNote: `summarize` is deprecated/);
		await s.terminate();
	});

	test("start() failing leaves a crashed session that says why", async () => {
		const s = new Session(
			"bad",
			path.join(root, "ws"),
			undefined,
			undefined,
			undefined,
			{
				runtime,
				provider: new FakeProvider({ failOpen: "no gate" }),
			},
		);
		await assert.rejects(s.start(), /no gate/);
		assert.strictEqual(s.status, "CRASHED");
		assert.strictEqual(s.isAlive(), false);
	});

	test("a session with no worker says how to recover and stays honest", async () => {
		const s = await start();
		await s.terminate();
		assert.strictEqual(s.isAlive(), false);
		assert.throws(
			() => s.sendCommand("hi"),
			/no running pi process.*Respawn it with spawn_pi_session/s,
		);
		assert.notStrictEqual(s.status, "IDLE");
	});

	test("history holds the prompt and the reply", async () => {
		const s = await start();
		await s.sendCommand("hi");
		const roles = s.history.map(
			(e) => (e as { message: { role: string } }).message.role,
		);
		assert.deepStrictEqual(roles, ["user", "assistant"]);
		await s.terminate();
	});

	test("a command while another runs is refused", async () => {
		const s = await start();
		const first = s.sendCommand("hang");
		assert.throws(
			() => s.sendCommand("x"),
			/Cannot send command when session status is RUNNING/,
		);
		s.abortCommand();
		await first;
		await s.terminate();
	});

	test("abort ends a running command and returns to idle; a second abort is harmless", async () => {
		const s = await start();
		const running = s.sendCommand("hang");
		s.abortCommand();
		s.abortCommand();
		await running;
		assert.strictEqual(s.status, "IDLE");
		await s.terminate();
	});

	test("a run that fails rejects, and the session is idle again", async () => {
		const s = await start();
		await assert.rejects(s.sendCommand("crash"), /fake worker crashed/);
		assert.strictEqual(s.status, "IDLE");
		await s.terminate();
	});

	test("a worker that exits by itself rejects the command and is crashed", async () => {
		const s = await start();
		const running = s.sendCommand("hang");
		provider.opened[0].crash(1);
		await assert.rejects(running, /exited unexpectedly \(code 1\)/);
		assert.strictEqual(s.status, "CRASHED");
		assert.strictEqual(s.isAlive(), false);
	});

	test("a requested termination is not a crash", async () => {
		const s = await start();
		await s.terminate();
		assert.strictEqual(s.status, "FINISHED");
		await s.terminate(); // idempotent
	});

	describe("the approval gate", () => {
		test("LOW risk is approved without asking and listed once", async () => {
			const s = await start();
			const out = await s.sendCommand(tool("bash", { command: "ls" }));
			assert.match(out, /^bash ran with /);
			assert.match(
				out,
				/Auto-approved without asking \(1\):\n- bash \[LOW\] ls/,
			);
			assert.strictEqual(s.getAutoApprovedLog().length, 1);
			const again = await s.sendCommand("hi");
			assert.ok(!again.includes("Auto-approved"), "reported only once");
			await s.terminate();
		});

		test("MEDIUM waits by default and runs when the policy allows it", async () => {
			const strict = await start();
			const waiting = await strict.sendCommand(
				tool("write", { path: "notes.txt", content: "x" }),
			);
			assert.match(waiting, /^AWAITING_APPROVAL: \[MEDIUM RISK\]/);
			await strict.terminate();

			const lenient = await start({
				autoApproveUpTo: RiskLevel.MEDIUM,
				overrides: [],
			});
			const out = await lenient.sendCommand(
				tool("write", { path: "notes.txt", content: "x" }),
			);
			assert.match(out, /^write ran with /);
			assert.match(out, /Auto-approved without asking/);
			await lenient.terminate();
		});

		test("HIGH waits; approve lets it run", async () => {
			const s = await start();
			const waiting = await s.sendCommand(confirmBash);
			const id = waiting.match(/Action ID: (\S+)\./)?.[1] as string;
			assert.strictEqual(s.status, "AWAITING_APPROVAL");
			assert.strictEqual(s.pendingAction?.actionId, id);
			assert.strictEqual(s.pendingAction?.riskLevel, RiskLevel.HIGH);
			const out = await s.approveAction(id);
			assert.match(out, /^bash ran with /);
			assert.strictEqual(s.status, "IDLE");
			assert.strictEqual(s.pendingAction, null);
			await s.terminate();
		});

		test("reject sends the reason to the worker", async () => {
			const s = await start();
			const waiting = await s.sendCommand(confirmBash);
			const id = waiting.match(/Action ID: (\S+)\./)?.[1] as string;
			assert.strictEqual(
				await s.rejectAction(id, "too risky"),
				"bash blocked: too risky",
			);
			await s.terminate();
		});

		test("approving an unknown or stale action is refused", async () => {
			const s = await start();
			assert.throws(
				() => s.approveAction("nope"),
				/No pending action matching ID: nope/,
			);
			const waiting = await s.sendCommand(confirmBash);
			const id = waiting.match(/Action ID: (\S+)\./)?.[1] as string;
			assert.throws(
				() => s.rejectAction("other"),
				/No pending action matching ID/,
			);
			await s.rejectAction(id);
			assert.throws(() => s.approveAction(id), /No pending action matching ID/);
			await s.terminate();
		});

		test("a protected path waits under any policy", async () => {
			const s = await start({
				autoApproveUpTo: RiskLevel.CRITICAL,
				overrides: [
					{
						match: { tool: "*" },
						action: "allow",
						maxRiskLevel: RiskLevel.CRITICAL,
					},
				],
			});
			const waiting = await s.sendCommand(
				tool("write", { path: ".mcp.json", content: "{}" }),
			);
			assert.match(waiting, /^AWAITING_APPROVAL/);
			assert.strictEqual(s.pendingAction?.hardLimit, true);
			assert.match(s.pendingAction?.reason ?? "", /protected/i);
			await s.terminate();
		});

		test("the ceiling holds even when a policy is passed straight to the session", async () => {
			const s = await start({ autoApproveUpTo: RiskLevel.HIGH, overrides: [] });
			assert.strictEqual(s.riskPolicy.autoApproveUpTo, RiskLevel.MEDIUM);
			assert.ok(s.policyReport?.clamped.length);
			const waiting = await s.sendCommand(confirmBash);
			assert.match(waiting, /^AWAITING_APPROVAL/);
			await s.terminate();
		});

		test("a deny override answers the worker without asking, and is reported once", async () => {
			const s = await start({
				autoApproveUpTo: RiskLevel.LOW,
				overrides: [{ match: { command: "rm *" }, action: "deny" }],
			});
			const out = await s.sendCommand(confirmBash);
			assert.match(out, /^bash blocked: Denied by override/);
			assert.match(out, /Denied by the risk policy without asking \(1\)/);
			assert.strictEqual(s.pendingAction, null);
			assert.ok(
				!(await s.sendCommand("hi")).includes("Denied by the risk policy"),
			);
			await s.terminate();
		});

		test("the earlier policy shape still works", async () => {
			const s = await start({
				autoApproveUpTo: RiskLevel.LOW,
				notifyUpTo: RiskLevel.MEDIUM,
				overrides: [],
			});
			assert.strictEqual(s.policyReport?.converted, true);
			const out = await s.sendCommand(tool("bash", { command: "mkdir b" }));
			assert.match(out, /^bash ran with /);
			await s.terminate();
		});

		test("an invalid policy is rejected when the session is built", () => {
			assert.throws(
				() =>
					new Session("bad", "/work", undefined, undefined, {
						autoApproveUpTo: 9,
					}),
				/Invalid riskPolicy/,
			);
		});

		test("every decision lands in the gate log, including the coordinator's", async () => {
			const s = await start();
			await s.sendCommand(tool("bash", { command: "ls" }));
			const waiting = await s.sendCommand(confirmBash);
			const id = waiting.match(/Action ID: (\S+)\./)?.[1] as string;
			await s.approveAction(id);
			const log = s.getGateLog();
			assert.deepStrictEqual(
				log.map((e) => [e.decision, e.decidedBy]),
				[
					["allow", "rules"],
					["escalate", "rules"],
					["allow", "coordinator"],
				],
			);
			await s.terminate();
		});

		test("a worker that ends with a call pending is logged as cancelled", async () => {
			const s = await start();
			await s.sendCommand(confirmBash);
			await s.terminate();
			const last = s.getGateLog().at(-1);
			assert.strictEqual(last?.decidedBy, "cancel");
			assert.strictEqual(last?.decision, "deny");
			assert.strictEqual(s.pendingAction, null);
		});

		test("an abort while a call is pending cancels it", async () => {
			const s = await start();
			const first = await s.sendCommand(confirmBash);
			assert.match(first, /^AWAITING_APPROVAL/);
			// The session is waiting on the coordinator, not running.
			assert.strictEqual(s.status, "AWAITING_APPROVAL");
			await s.terminate();
			assert.strictEqual(s.getGateLog().at(-1)?.decidedBy, "cancel");
		});

		test("two calls at once are answered one after the other", async () => {
			const s = await start();
			const first = await s.sendCommand(
				`parallel:bash:${JSON.stringify({ command: "rm f" })}`,
			);
			const id1 = first.match(/Action ID: (\S+)\./)?.[1] as string;
			// Both calls are pending; the coordinator sees them in order.
			await new Promise((r) => setTimeout(r, 20));
			const second = await s.approveAction(id1);
			assert.match(second, /^AWAITING_APPROVAL/);
			const id2 = second.match(/Action ID: (\S+)\./)?.[1] as string;
			assert.notStrictEqual(
				id1,
				id2,
				"the second call did not overwrite the first",
			);
			const done = await s.rejectAction(id2, "second no");
			assert.match(done, /1: ran with|ran with/);
			assert.match(done, /second no/);
			assert.strictEqual(s.status, "IDLE");
			await s.terminate();
		});
	});
});
