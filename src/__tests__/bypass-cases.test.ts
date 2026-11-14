import assert from "node:assert";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";

import { classifyAction, RiskLevel } from "../session/risk-classifier.js";
import {
	DEFAULT_RISK_POLICY,
	shouldAutoApprove,
} from "../session/risk-policy.js";

interface BypassCase {
	name: string;
	toolName: string;
	command?: string;
	path?: string;
	/** The lowest level the call may be classified as. */
	min: keyof typeof RiskLevel;
	/** The highest level, for calls that must not be over-blocked. */
	max?: keyof typeof RiskLevel;
}

const cases: BypassCase[] = JSON.parse(
	readFileSync(new URL("./bypass-cases.json", import.meta.url), "utf8"),
);

const toolCall = (c: BypassCase) => ({
	toolName: c.toolName,
	input: c.command !== undefined ? { command: c.command } : { path: c.path },
});

describe("bypass cases", () => {
	test("the fixture is well formed", () => {
		assert.ok(cases.length > 100);
		const names = new Set(cases.map((c) => c.name));
		assert.strictEqual(names.size, cases.length, "names are unique");
		for (const c of cases) {
			assert.ok(c.min in RiskLevel, `${c.name}: unknown level ${c.min}`);
			if (c.max) assert.ok(c.max in RiskLevel, `${c.name}: bad max`);
		}
	});

	for (const c of cases) {
		test(c.name, () => {
			const call = toolCall(c);
			const res = classifyAction(call, "/work");
			assert.ok(
				res.riskLevel >= RiskLevel[c.min],
				`${JSON.stringify(call.input)} classified ${res.riskLabel}, expected at least ${c.min} (${res.matchedRule})`,
			);
			if (c.max) {
				assert.ok(
					res.riskLevel <= RiskLevel[c.max],
					`${JSON.stringify(call.input)} classified ${res.riskLabel}, expected at most ${c.max} (${res.matchedRule})`,
				);
			}
			// With the default policy, only LOW is ever auto-approved.
			const decision = shouldAutoApprove(res, DEFAULT_RISK_POLICY, call);
			assert.strictEqual(
				decision.approved,
				res.riskLevel === RiskLevel.LOW,
				`default policy decision for ${c.name}`,
			);
		});
	}
});
