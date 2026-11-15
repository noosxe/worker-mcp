import assert from "node:assert";
import test, { afterEach, beforeEach, describe } from "node:test";

import { RiskLevel } from "../risk.js";
import { decide, fixture, permissive, type Fixture } from "./helpers.js";

let fx: Fixture;
beforeEach(() => {
	fx = fixture();
});
afterEach(() => fx.cleanup());

const HIGH = { command: "rm file" };

describe("remember: worker", () => {
	test("the same call is then allowed by the cache, and only that call", async () => {
		const gate = fx.gate({ workerId: "w_aaaaaaaa" });
		const first = await decide(gate, "bash", HIGH);
		assert.strictEqual(first.decision, "escalate");
		assert.strictEqual(gate.remember(first), true);

		const again = await decide(gate, "bash", HIGH);
		assert.strictEqual(again.decision, "allow");
		assert.strictEqual(again.decidedBy, "cache");
		assert.strictEqual(again.consulted.at(-1)?.cached, true);

		for (const other of [
			{ command: "rm other" },
			{ command: "rm  file" },
			{ command: "rm file", extra: 1 },
		]) {
			assert.strictEqual(
				(await decide(gate, "bash", other)).decision,
				"escalate",
			);
		}
		const log = gate.log.entries().filter((e) => e.decidedBy === "cache");
		assert.strictEqual(log.length, 1);
	});

	test("it is scoped to the worker", async () => {
		const a = fx.gate({ workerId: "w_aaaaaaaa" });
		const b = fx.gate({ workerId: "w_bbbbbbbb" });
		a.remember(await decide(a, "bash", HIGH));
		assert.strictEqual((await decide(a, "bash", HIGH)).decision, "allow");
		assert.strictEqual((await decide(b, "bash", HIGH)).decision, "escalate");
	});

	test("a hard limit, a protected path and CRITICAL are never remembered", async () => {
		const gate = fx.gate({ workerId: "w_aaaaaaaa" });
		for (const [tool, input] of [
			["write", { path: ".mcp.json" }],
			["edit", { path: ".git/hooks/pre-commit" }],
			["read", { path: ".env" }],
			["write", { path: "/etc/x" }],
			["bash", { command: "sudo reboot" }],
		] as const) {
			const first = await decide(gate, tool, input);
			assert.strictEqual(first.decision, "escalate", tool);
			assert.strictEqual(
				gate.remember(first),
				false,
				`${tool} ${JSON.stringify(input)}`,
			);
			assert.strictEqual(
				(await decide(gate, tool, input)).decision,
				"escalate",
			);
		}
	});

	test("a deny override still denies a remembered call", async () => {
		const gate = fx.gate({ workerId: "w_aaaaaaaa" });
		gate.remember(await decide(gate, "bash", HIGH));
		gate.setPolicy(
			permissive(RiskLevel.LOW, [
				{ match: { command: "rm *" }, action: "deny" },
			]),
		);
		assert.strictEqual((await decide(gate, "bash", HIGH)).decision, "deny");
	});

	test("it ends when the worker closes or its policy changes", async () => {
		const gate = fx.gate({ workerId: "w_aaaaaaaa" });
		gate.remember(await decide(gate, "bash", HIGH));
		gate.setPolicy(permissive(RiskLevel.LOW));
		assert.strictEqual((await decide(gate, "bash", HIGH)).decision, "escalate");
		gate.remember(await decide(gate, "bash", HIGH));
		gate.forget(); // what closing the worker does
		assert.strictEqual((await decide(gate, "bash", HIGH)).decision, "escalate");
	});
});
