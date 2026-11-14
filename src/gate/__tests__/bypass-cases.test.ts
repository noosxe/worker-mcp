import assert from "node:assert";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";

import { Gate } from "../gate.js";
import { RISK_LABELS, RiskLevel } from "../risk.js";

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

// Neither directory needs to exist: paths resolve lexically.
const gate = new Gate({ cwd: "/work", home: "/home/user" });

describe("bypass cases", () => {
	test("the fixture is well formed", () => {
		assert.ok(cases.length > 150);
		const names = new Set(cases.map((c) => c.name));
		assert.strictEqual(names.size, cases.length, "names are unique");
		for (const c of cases) {
			assert.ok(c.min in RiskLevel, `${c.name}: unknown level ${c.min}`);
			if (c.max) assert.ok(c.max in RiskLevel, `${c.name}: bad max`);
		}
	});

	for (const c of cases) {
		test(c.name, async () => {
			const input =
				c.command !== undefined ? { command: c.command } : { path: c.path };
			const out = await gate.decide({
				provider: "pi",
				toolName: c.toolName,
				input,
			});
			const where = `${JSON.stringify(input).slice(0, 120)} classified ${RISK_LABELS[out.level]} (${out.ruleId})`;
			assert.ok(
				out.level >= RiskLevel[c.min],
				`${where}, expected at least ${c.min}`,
			);
			if (c.max) {
				assert.ok(
					out.level <= RiskLevel[c.max],
					`${where}, expected at most ${c.max}`,
				);
			}
			// With the default policy, only LOW is ever auto-allowed.
			assert.strictEqual(
				out.decision === "allow",
				out.level === RiskLevel.LOW,
				`default policy decision for ${c.name}: ${out.decision}`,
			);
		});
	}
});
