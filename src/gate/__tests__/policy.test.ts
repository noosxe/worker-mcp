import assert from "node:assert";
import test, { afterEach, beforeEach, describe } from "node:test";

import {
	clampPolicy,
	DEFAULT_RISK_POLICY,
	normalizePolicy,
	PolicyError,
	type RiskPolicy,
} from "../policy.js";
import { RiskLevel } from "../risk.js";
import { decide, fixture, permissive, type Fixture } from "./helpers.js";

describe("normalizePolicy", () => {
	test("accepts v2 as it is", () => {
		const n = normalizePolicy({
			autoApproveUpTo: 1,
			overrides: [
				{ match: { tool: "edit" }, action: "allow", maxRiskLevel: "HIGH" },
			],
			classifiers: "off",
		});
		assert.deepStrictEqual(n.policy, {
			autoApproveUpTo: RiskLevel.MEDIUM,
			classifiers: "off",
			overrides: [
				{
					match: { tool: "edit" },
					action: "allow",
					maxRiskLevel: RiskLevel.HIGH,
				},
			],
		});
	});

	test("an empty object is the default policy", () => {
		assert.deepStrictEqual(
			normalizePolicy({}).policy.autoApproveUpTo,
			DEFAULT_RISK_POLICY.autoApproveUpTo,
		);
		assert.deepStrictEqual(normalizePolicy({}).policy.overrides, []);
	});

	test("rejects the v1 shape", () => {
		for (const bad of [
			{ notifyUpTo: 1 },
			{ overrides: [{ pattern: "git *", action: "allow" }] },
			{
				overrides: [
					{ match: { tool: "bash" }, pathPattern: "*/src/*", action: "allow" },
				],
			},
			{ overrides: [{ match: { command: "rm *" }, action: "block" }] },
		]) {
			assert.throws(() => normalizePolicy(bad), PolicyError);
		}
	});

	test("rejects anything else", () => {
		for (const bad of [
			null,
			"LOW",
			[],
			5,
			{ autoApproveUpTo: 9 },
			{ autoApproveUpTo: "BOGUS" },
			{ overrides: "x" },
			{ overrides: [{ match: {}, action: "allow" }] },
			{ overrides: [{ match: { tool: "x" }, action: "block" }] },
			{ overrides: [{ match: { tool: "x" }, action: "allow", extra: 1 }] },
			{ overrides: [{ match: { kind: "nonsense" }, action: "allow" }] },
			{ overrides: [{ match: { tool: "*".repeat(600) }, action: "allow" }] },
			{ unknownKey: 1 },
			{ notifyUpTo: 1, overrides: [{ match: { tool: "x" }, action: "allow" }] },
		]) {
			assert.throws(
				() => normalizePolicy(bad),
				PolicyError,
				JSON.stringify(bad),
			);
		}
	});
});

describe("clampPolicy", () => {
	const policy: RiskPolicy = {
		autoApproveUpTo: RiskLevel.CRITICAL,
		overrides: [
			{
				match: { tool: "a" },
				action: "allow",
				maxRiskLevel: RiskLevel.CRITICAL,
			},
			{ match: { tool: "b" }, action: "allow" },
			{ match: { tool: "c" }, action: "allow", maxRiskLevel: RiskLevel.LOW },
			{ match: { tool: "d" }, action: "escalate" },
			{ match: { tool: "e" }, action: "deny" },
		],
	};

	test("lowers the threshold and every allow to the ceiling, and says so", () => {
		const { policy: out, clamped } = clampPolicy(policy, RiskLevel.MEDIUM);
		assert.strictEqual(out.autoApproveUpTo, RiskLevel.MEDIUM);
		assert.deepStrictEqual(
			out.overrides.map((o) => o.maxRiskLevel),
			[RiskLevel.MEDIUM, RiskLevel.MEDIUM, RiskLevel.LOW, undefined, undefined],
		);
		assert.strictEqual(clamped.length, 2);
		assert.match(clamped[0], /autoApproveUpTo CRITICAL lowered to MEDIUM/);
		assert.match(clamped[1], /overrides\[0\]/);
	});

	test("an allow with no max is limited to its default under a lower ceiling", () => {
		const { policy: out, clamped } = clampPolicy(
			{
				autoApproveUpTo: RiskLevel.LOW,
				overrides: [{ match: { tool: "b" }, action: "allow" }],
			},
			RiskLevel.LOW,
		);
		assert.strictEqual(out.overrides[0].maxRiskLevel, RiskLevel.LOW);
		assert.strictEqual(clamped.length, 1);
	});

	test("changes nothing, and reports nothing, when already within it", () => {
		const within = permissive(RiskLevel.LOW);
		const { policy: out, clamped } = clampPolicy(within, RiskLevel.MEDIUM);
		assert.deepStrictEqual(out, within);
		assert.deepStrictEqual(clamped, []);
	});

	test("does not modify its input", () => {
		const copy = JSON.stringify(policy);
		clampPolicy(policy, RiskLevel.LOW);
		assert.strictEqual(JSON.stringify(policy), copy);
	});
});

describe("the gate applies the ceiling", () => {
	let fx: Fixture;
	beforeEach(() => {
		fx = fixture();
	});
	afterEach(() => fx.cleanup());

	test("a policy given at construction or later never exceeds it", async () => {
		const gate = fx.gate({ policy: permissive(RiskLevel.CRITICAL) });
		assert.strictEqual(gate.policy.autoApproveUpTo, RiskLevel.MEDIUM);
		assert.strictEqual(
			(await decide(gate, "bash", { command: "rm file" })).decision,
			"escalate",
		);
		assert.strictEqual(
			(await decide(gate, "write", { path: "src/a.ts" })).decision,
			"allow",
		);

		const set = gate.setPolicy(permissive(RiskLevel.HIGH));
		assert.strictEqual(set.clamped.length, 1);
		assert.strictEqual(
			(await decide(gate, "bash", { command: "rm file" })).decision,
			"escalate",
		);
	});

	test("the ceiling can be lowered to LOW or raised to HIGH, never CRITICAL", async () => {
		const low = fx.gate({
			policy: permissive(RiskLevel.MEDIUM),
			maxAutoApprove: RiskLevel.LOW,
		});
		assert.strictEqual(
			(await decide(low, "write", { path: "src/a.ts" })).decision,
			"escalate",
		);
		const high = fx.gate({
			policy: permissive(RiskLevel.HIGH),
			maxAutoApprove: RiskLevel.HIGH,
		});
		assert.strictEqual(
			(await decide(high, "bash", { command: "rm file" })).decision,
			"allow",
		);
		const crit = fx.gate({
			policy: permissive(RiskLevel.CRITICAL),
			maxAutoApprove: RiskLevel.CRITICAL,
		});
		assert.strictEqual(crit.policy.autoApproveUpTo, RiskLevel.HIGH);
		assert.strictEqual(
			(await decide(crit, "write", { path: "/etc/x" })).decision,
			"escalate",
		);
	});
});
