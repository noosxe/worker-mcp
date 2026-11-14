import assert from "node:assert";
import test, { afterEach, beforeEach, describe } from "node:test";

import {
	AuditRing,
	canonicalJson,
	digest,
	type GateLogEntry,
} from "../audit.js";
import type { Classifier, ClassifierResult } from "../classifier.js";
import { RiskLevel } from "../risk.js";
import { decide, fixture, permissive, type Fixture } from "./helpers.js";

let fx: Fixture;
beforeEach(() => {
	fx = fixture();
});
afterEach(() => fx.cleanup());

const classifier = (
	id: string,
	result:
		| ClassifierResult
		| (() => ClassifierResult | Promise<ClassifierResult>),
	calls: string[] = [],
): Classifier => ({
	id,
	classify: async () => {
		calls.push(id);
		return typeof result === "function" ? result() : result;
	},
});

const entry = (n: number): GateLogEntry => ({
	ts: "t",
	requestId: `r${n}`,
	actionId: `a${n}`,
	provider: "pi",
	tool: "bash",
	kind: "shell",
	depth: 0,
	argsDigest: "d",
	preview: "p",
	rule: { level: RiskLevel.LOW, ruleId: "x", autoAllowable: true },
	consulted: [],
	decision: "allow",
	decidedBy: "rules",
	reason: "",
});

describe("audit ring", () => {
	test("is bounded and drops the oldest", () => {
		const ring = new AuditRing(3);
		for (let i = 0; i < 10; i++) ring.push(entry(i));
		assert.strictEqual(ring.size, 3);
		assert.deepStrictEqual(
			ring.entries().map((e) => e.requestId),
			["r7", "r8", "r9"],
		);
		assert.strictEqual(ring.findByAction("a8")?.requestId, "r8");
		assert.strictEqual(ring.findByAction("a1"), undefined);
	});

	test("entries() is a copy", () => {
		const ring = new AuditRing(3);
		ring.push(entry(1));
		ring.entries().length = 0;
		assert.strictEqual(ring.size, 1);
	});

	test("rejects a nonsense capacity", () => {
		for (const c of [0, -1, 1.5, Number.NaN])
			assert.throws(() => new AuditRing(c));
	});

	test("digests ignore key order", () => {
		assert.strictEqual(
			digest({ a: 1, b: { c: 2, d: 3 } }),
			digest({ b: { d: 3, c: 2 }, a: 1 }),
		);
		assert.notStrictEqual(digest({ a: 1 }), digest({ a: 2 }));
		assert.strictEqual(
			canonicalJson([1, { b: 1, a: [2] }]),
			'[1,{"a":[2],"b":1}]',
		);
	});
});

describe("Gate", () => {
	test("records every decision, auto or not, bounded", async () => {
		const gate = fx.gate({ ringSize: 5 });
		await decide(gate, "bash", { command: "ls" });
		await decide(gate, "bash", { command: "rm -rf build" });
		await decide(gate, "write", { path: ".mcp.json" });
		const log = gate.log.entries();
		assert.deepStrictEqual(
			log.map((e) => e.decision),
			["allow", "escalate", "escalate"],
		);
		assert.deepStrictEqual(
			log.map((e) => e.decidedBy),
			["rules", "rules", "rules"],
		);
		assert.strictEqual(log[0].preview, "ls");
		assert.strictEqual(log[2].rule.autoAllowable, false);
		assert.match(log[0].argsDigest, /^[0-9a-f]{64}$/);
		for (let i = 0; i < 20; i++) await decide(gate, "bash", { command: "ls" });
		assert.strictEqual(gate.log.size, 5);
	});

	test("the log holds a digest and a short preview, not the arguments", async () => {
		const gate = fx.gate();
		const secret = "x".repeat(1000);
		await decide(gate, "write", { path: "src/a.ts", content: secret });
		const e = gate.log.entries()[0];
		assert.ok(!JSON.stringify(e).includes(secret));
		const long = await decide(gate, "bash", {
			command: `echo ${"y".repeat(500)}`,
		});
		assert.ok(long);
		assert.ok(gate.log.entries()[1].preview.length <= 200);
	});

	test("records the coordinator's answer against the same call", async () => {
		const gate = fx.gate();
		gate.decide(
			{ provider: "pi", toolName: "bash", input: { command: "rm x" } },
			"act1",
		);
		gate.recordResolution(
			"act1",
			"allow",
			"coordinator",
			"approved by the coordinator",
		);
		gate.recordResolution("unknown", "allow", "coordinator", "x");
		const log = gate.log.entries();
		assert.strictEqual(log.length, 2);
		assert.strictEqual(log[1].decidedBy, "coordinator");
		assert.strictEqual(log[1].decision, "allow");
		assert.strictEqual(log[1].tool, "bash");
	});

	test("a throwing tool map fails closed, never open", async () => {
		const toolMap = new Proxy(
			{},
			{
				getOwnPropertyDescriptor: () => {
					throw new Error("boom");
				},
			},
		);
		const gate = fx.gate({
			toolMap: toolMap as never,
			policy: permissive(RiskLevel.HIGH),
		});
		const out = await decide(gate, "read", { path: "a" });
		assert.strictEqual(out.decision, "escalate");
		assert.strictEqual(out.autoAllowable, false);
		assert.strictEqual(out.ruleId, "gate.error");
		assert.strictEqual(gate.log.size, 1);
	});

	test("decisions are synchronous with the rules alone", () => {
		const out = fx
			.gate()
			.decide({ provider: "pi", toolName: "bash", input: { command: "ls" } });
		assert.ok(!(out instanceof Promise));
		assert.strictEqual(out.decision, "allow");
	});
});

describe("classifier chain", () => {
	test("a further classifier is asked only about auto-allowable escalations", async () => {
		const calls: string[] = [];
		const gate = fx.gate({
			classifiers: [
				classifier("ext", { verdict: "allow", reason: "looks fine" }, calls),
			],
		});
		// LOW: allowed by the rules, so not asked.
		assert.strictEqual(
			(await decide(gate, "bash", { command: "ls" })).decidedBy,
			"rules",
		);
		assert.deepStrictEqual(calls, []);
		// HIGH: escalated by the rules, so asked, and its allow counts.
		const high = await decide(gate, "bash", { command: "rm file" });
		assert.strictEqual(high.decision, "allow");
		assert.strictEqual(high.decidedBy, "ext");
		assert.deepStrictEqual(calls, ["ext"]);
		assert.deepStrictEqual(
			high.consulted.map((c) => c.by),
			["rules", "ext"],
		);
	});

	test("it cannot allow a hard limit, and is not even asked", async () => {
		const calls: string[] = [];
		const gate = fx.gate({
			classifiers: [
				classifier("ext", { verdict: "allow", reason: "x" }, calls),
			],
		});
		for (const [tool, input] of [
			["write", { path: ".mcp.json" }],
			["edit", { path: ".git/hooks/pre-commit" }],
			["bash", { command: "echo x > .envrc" }],
			["read", { path: ".env" }],
		] as const) {
			const out = await decide(gate, tool, input);
			assert.strictEqual(out.decision, "escalate", tool);
		}
		assert.deepStrictEqual(calls, []);
	});

	test("it cannot allow CRITICAL", async () => {
		const gate = fx.gate({
			classifiers: [classifier("ext", { verdict: "allow", reason: "x" })],
		});
		assert.strictEqual(
			(await decide(gate, "write", { path: "/etc/x" })).decision,
			"escalate",
		);
		assert.strictEqual(
			(await decide(gate, "bash", { command: "sudo reboot" })).decision,
			"escalate",
		);
	});

	test("it cannot override a deny override", async () => {
		const calls: string[] = [];
		const gate = fx.gate({
			policy: permissive(RiskLevel.LOW, [
				{ match: { command: "rm *" }, action: "deny" },
			]),
			classifiers: [
				classifier("ext", { verdict: "allow", reason: "x" }, calls),
			],
		});
		assert.strictEqual(
			(await decide(gate, "bash", { command: "rm file" })).decision,
			"deny",
		);
		assert.deepStrictEqual(calls, []);
	});

	test("a failing classifier escalates to the coordinator", async () => {
		const gate = fx.gate({
			classifiers: [
				classifier("ext", () => {
					throw new Error("down");
				}),
			],
		});
		const out = await decide(gate, "bash", { command: "rm file" });
		assert.strictEqual(out.decision, "escalate");
		assert.strictEqual(out.consulted[1].error, "down");
	});

	test("the first decisive verdict wins; deny is honoured", async () => {
		const calls: string[] = [];
		const gate = fx.gate({
			classifiers: [
				classifier("one", { verdict: "escalate", reason: "unsure" }, calls),
				classifier("two", { verdict: "deny", reason: "no" }, calls),
				classifier("three", { verdict: "allow", reason: "yes" }, calls),
			],
		});
		const out = await decide(gate, "bash", { command: "rm file" });
		assert.strictEqual(out.decision, "deny");
		assert.strictEqual(out.decidedBy, "two");
		assert.deepStrictEqual(calls, ["one", "two"]);
	});
});
