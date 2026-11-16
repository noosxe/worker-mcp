import assert from "node:assert";
import { after, before, describe, test } from "node:test";

import { createIsolation, type Isolation } from "../helpers/isolation.js";
import { RawServer } from "../helpers/stdio.js";
import { TOOLS } from "../helpers/tools.js";

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);

/** A run of eight calls: four allowed, one denied, three escalated. */
const CALLS = [
	"echo one",
	"echo two",
	"rm -rf build-a",
	"echo three",
	"curl https://example.invalid/x",
	"rm -rf build-b",
	"echo four",
	"rm -rf build-c",
].map((command) => ({ tool: "bash", input: { command } }));

describe("responses of a scripted run: shape and size", () => {
	let iso: Isolation;
	before(() => {
		iso = createIsolation();
	});
	after(() => iso.cleanup());

	test("the run's responses", async () => {
		const server = new RawServer(iso);
		const sizes: Record<string, number[]> = {};
		const answers: Record<string, any[]> = {
			[TOOLS.approve]: [],
			[TOOLS.reject]: [],
		};
		const waits: any[] = [];
		const timed = async (name: string, args: object) => {
			const res = await server.callTool(name, args);
			assert.notStrictEqual(res.result.isError, true, JSON.stringify(res));
			if (process.env.DUMP && name === TOOLS.waitRun)
				console.log("DUMP", JSON.stringify(res.result));
			(sizes[name] ??= []).push(
				Buffer.byteLength(JSON.stringify(res.result), "utf8"),
			);
			const data = res.result.structuredContent;
			if (name in answers) answers[name].push(data);
			if (name === TOOLS.waitRun) waits.push(data);
			return data;
		};
		try {
			await server.initialize();
			await server.callTool(TOOLS.spawn, {
				name: "w",
				cwd: iso.cwd,
				policy: {
					autoApproveUpTo: 0,
					overrides: [
						{ match: { command: "echo *" }, action: "allow" },
						{ match: { command: "curl *" }, action: "deny" },
					],
				},
			});
			let view = await timed(TOOLS.startRun, {
				workerId: "w",
				prompt: `scenario:sequence:${JSON.stringify(CALLS)}`,
				waitMs: 10_000,
			});
			let rejectNext = 0;
			const deadline = Date.now() + 30_000;
			while (!TERMINAL.has(view.state)) {
				assert.ok(Date.now() < deadline, "the run did not end");
				if (view.state === "awaiting_approval") {
					const id = view.pendingApprovals[0].approvalId;
					const answer = await timed(
						rejectNext++ === 2 ? TOOLS.reject : TOOLS.approve,
						{ approvalId: id },
					);
					view = {
						...view,
						seq: answer.seq ?? answer.run.seq,
						state: "running",
					};
				}
				view = await timed(TOOLS.waitRun, {
					runId: view.runId,
					sinceSeq: view.seq,
					waitMs: 10_000,
				});
			}
			let total = 0;
			for (const [name, list] of Object.entries(sizes)) {
				const sum = list.reduce((a, b) => a + b, 0);
				total += sum;
				console.log(`SIZE ${name}: ${list.join(" ")} (sum ${sum})`);
			}
			if (process.env.DUMP) console.log(JSON.stringify(view, null, 1));
			console.log(`SIZE total: ${total}`);

			// Approve and reject carry the outcome only; the next wait the view.
			for (const [name, outcome] of [
				[TOOLS.approve, "approved"],
				[TOOLS.reject, "rejected"],
			] as const) {
				assert.ok(answers[name].length > 0);
				for (const a of answers[name]) {
					assert.deepStrictEqual(
						new Set(Object.keys(a).filter((k) => k !== "remembered")),
						new Set(["approvalId", "next", "outcome", "runId", "seq", "state"]),
					);
					assert.strictEqual(a.outcome, outcome);
					assert.match(a.next, /wait_run/);
				}
			}
			assert.strictEqual(
				typeof answers[TOOLS.approve][0].remembered,
				"boolean",
			);
			assert.strictEqual("remembered" in answers[TOOLS.reject][0], false);

			// The denied call is reported once, in the wait that follows it,
			// and no wait repeats a call an earlier one reported.
			const seen = waits.flatMap((w) => w.gate.untrustedNotable);
			assert.strictEqual(new Set(seen).size, seen.length, seen.join("\n"));
			assert.ok(
				seen.some((l) => /curl/.test(l)),
				"the denied call",
			);
			assert.ok(waits.every((w) => w.gate.notableOmitted === 0));
			// Allowed calls are counted, not listed.
			assert.ok(
				seen.every((l) => !/echo/.test(l)),
				seen.join("\n"),
			);
			assert.strictEqual(view.gate.autoAllowed, 4);
			assert.strictEqual(view.gate.autoDenied, 1);
			assert.strictEqual(view.gate.escalated, 3);
		} finally {
			await server.dispose();
		}
	});
});
