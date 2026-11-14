import assert from "node:assert";
import { spawn } from "node:child_process";
import { describe, test } from "node:test";

import { descendantsOf, readProcessTable, TreeTracker } from "../proctree.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("process tree", () => {
	test("descendantsOf walks down through parents", () => {
		const table = [
			{ pid: 2, ppid: 1, token: "a" },
			{ pid: 3, ppid: 2, token: "b" },
			{ pid: 4, ppid: 3, token: "c" },
			{ pid: 5, ppid: 9, token: "d" },
		];
		assert.deepStrictEqual(
			new Set(descendantsOf(table, [2]).map((e) => e.pid)),
			new Set([3, 4]),
		);
	});

	test("the table lists this process with a stable token", () => {
		const a = readProcessTable().find((e) => e.pid === process.pid);
		const b = readProcessTable().find((e) => e.pid === process.pid);
		assert.ok(a);
		assert.strictEqual(a.token, b?.token);
	});

	test("the tracker remembers a child and forgets it once it has exited", async () => {
		const tracker = new TreeTracker(process.pid);
		const child = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
		const pid = child.pid as number;
		try {
			tracker.refresh();
			assert.ok(tracker.pids.includes(pid), "recorded while running");
			child.kill("SIGKILL");
			await new Promise((r) => child.once("exit", r));
			await sleep(20);
			tracker.refresh();
			assert.ok(!tracker.pids.includes(pid), "pruned after exit");
		} finally {
			child.kill("SIGKILL");
		}
	});

	test("the tracked set does not grow with every short-lived command", async () => {
		const tracker = new TreeTracker(process.pid);
		for (let i = 0; i < 20; i++) {
			const c = spawn("true", [], { stdio: "ignore" });
			await new Promise((r) => c.once("exit", r));
			tracker.refresh();
		}
		assert.ok(tracker.pids.length < 5, `kept ${tracker.pids.length} pids`);
	});
});
