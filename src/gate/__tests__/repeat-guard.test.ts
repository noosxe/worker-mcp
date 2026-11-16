import assert from "node:assert";
import test, { afterEach, beforeEach, describe } from "node:test";

import { digest } from "../audit.js";
import type { Classifier } from "../classifier.js";
import { REPEAT_GUARD_RULE_ID } from "../gate.js";
import { RiskLevel } from "../risk.js";
import { decide, fixture, permissive, type Fixture } from "./helpers.js";

let fx: Fixture;
beforeEach(() => {
	fx = fixture();
});
afterEach(() => fx.cleanup());

const MEDIUM_CALL = { path: "src/a.ts", content: "x" };
const cutOff = digest(MEDIUM_CALL);
const allowing: Classifier = {
	id: "http:ext",
	classify: async () => ({ verdict: "allow", reason: "looks fine" }),
};

describe("the repeat guard of a resumed worker", () => {
	test("sends a repeated cut-off call to the coordinator under an allow override", async () => {
		const gate = fx.gate({
			policy: permissive(RiskLevel.MEDIUM, [
				{ match: { tool: "write" }, action: "allow" },
			]),
		});
		const before = await decide(gate, "write", MEDIUM_CALL);
		assert.strictEqual(before.decision, "allow");

		gate.armRepeatGuard([cutOff]);
		const out = await decide(gate, "write", MEDIUM_CALL);
		assert.strictEqual(out.decision, "escalate");
		assert.strictEqual(out.ruleId, REPEAT_GUARD_RULE_ID);
		assert.strictEqual(out.escalatedBecause, "repeat_cut_off");
		assert.strictEqual(out.autoAllowable, false);
		assert.match(out.reason, /cut off before the restart/);
		assert.match(out.reason, /result is unknown/);
		const logged = gate.log.entries().at(-1);
		assert.strictEqual(logged?.rule.ruleId, REPEAT_GUARD_RULE_ID);
		assert.strictEqual(logged?.decision, "escalate");

		// other arguments are not affected
		const other = await decide(gate, "write", { ...MEDIUM_CALL, content: "y" });
		assert.strictEqual(other.decision, "allow");
	});

	test("also beats a classifier's allow and a remembered approval", async () => {
		const viaClassifier = fx.gate({
			mode: "auto",
			classifiers: [allowing],
			workerId: "w_aaaaaaaa",
		});
		const first = await decide(viaClassifier, "write", MEDIUM_CALL);
		assert.strictEqual(first.decision, "allow");
		assert.strictEqual(first.decidedBy, "http:ext");
		viaClassifier.armRepeatGuard([cutOff]);
		const guarded = await decide(viaClassifier, "write", MEDIUM_CALL);
		assert.strictEqual(guarded.decision, "escalate");
		assert.strictEqual(guarded.ruleId, REPEAT_GUARD_RULE_ID);

		const gate = fx.gate({ workerId: "w_bbbbbbbb" });
		const asked = await decide(gate, "write", MEDIUM_CALL);
		assert.strictEqual(asked.decision, "escalate");
		assert.strictEqual(gate.remember(asked), true);
		assert.strictEqual(
			(await decide(gate, "write", MEDIUM_CALL)).decidedBy,
			"cache",
		);
		gate.armRepeatGuard([cutOff]);
		const out = await decide(gate, "write", MEDIUM_CALL);
		assert.strictEqual(out.decision, "escalate");
		assert.strictEqual(out.ruleId, REPEAT_GUARD_RULE_ID);
		// and an approval of it is not remembered
		assert.strictEqual(gate.remember(out), false);
	});

	test("LOW calls are exempt, and a denial stays a denial", async () => {
		const read = { path: "src/a.ts" };
		const gate = fx.gate({
			policy: permissive(RiskLevel.LOW, [
				{ match: { command: "rm *" }, action: "deny" },
			]),
		});
		gate.armRepeatGuard([digest(read), digest({ command: "rm x" })]);
		assert.strictEqual((await decide(gate, "read", read)).decision, "allow");
		const denied = await decide(gate, "bash", { command: "rm x" });
		assert.strictEqual(denied.decision, "deny");
		assert.notStrictEqual(denied.ruleId, REPEAT_GUARD_RULE_ID);
	});

	test("the coordinator's approval lifts it for that call; disarming ends it", async () => {
		const gate = fx.gate({
			policy: permissive(RiskLevel.MEDIUM, [
				{ match: { tool: "write" }, action: "allow" },
			]),
		});
		gate.armRepeatGuard([cutOff]);
		const ask = gate.decide(
			{ provider: "pi", toolName: "write", input: MEDIUM_CALL },
			"call-1",
		);
		assert.strictEqual((await ask).decision, "escalate");
		gate.recordResolution("call-1", "allow", "coordinator", "ok");
		assert.strictEqual(
			(await decide(gate, "write", MEDIUM_CALL)).decision,
			"allow",
		);

		gate.armRepeatGuard([cutOff]);
		assert.strictEqual(
			(await decide(gate, "write", MEDIUM_CALL)).decision,
			"escalate",
		);
		gate.disarmRepeatGuard();
		assert.strictEqual(
			(await decide(gate, "write", MEDIUM_CALL)).decision,
			"allow",
		);
	});

	test("changing the policy does not lift it", async () => {
		const gate = fx.gate({
			policy: permissive(RiskLevel.MEDIUM, [
				{ match: { tool: "write" }, action: "allow" },
			]),
		});
		gate.armRepeatGuard([cutOff]);
		gate.setPolicy(permissive(RiskLevel.MEDIUM));
		const out = await decide(gate, "write", MEDIUM_CALL);
		assert.strictEqual(out.ruleId, REPEAT_GUARD_RULE_ID);
	});
});
