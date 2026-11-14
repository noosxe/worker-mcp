import assert from "node:assert";
import { describe, test } from "node:test";

import { TaskSettler } from "../task-settle.js";

const result = { content: [{ type: "text" as const, text: "x" }] };

describe("TaskSettler", () => {
	test("stores a result only once per task", async () => {
		const calls: string[] = [];
		const settler = new TaskSettler({
			storeTaskResult: async (id, status) => {
				calls.push(`${id}:${status}`);
			},
		});
		assert.strictEqual(await settler.settle("t1", "completed", result), true);
		assert.strictEqual(await settler.settle("t1", "failed", result), false);
		assert.strictEqual(await settler.settle("t2", "failed", result), true);
		assert.deepStrictEqual(calls, ["t1:completed", "t2:failed"]);
	});

	test("a throwing store does not reject and still marks the task settled", async () => {
		const settler = new TaskSettler({
			storeTaskResult: async () => {
				throw new Error("task is terminal");
			},
		});
		assert.strictEqual(await settler.settle("t1", "completed", result), false);
		assert.strictEqual(settler.isSettled("t1"), true);
	});
});
