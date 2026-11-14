import assert from "node:assert";
import { describe, test } from "node:test";

import { isValidSessionId } from "../validation.js";

describe("isValidSessionId", () => {
	test("accepts simple ids", () => {
		assert.strictEqual(isValidSessionId("worker_1-a"), true);
		assert.strictEqual(isValidSessionId("a".repeat(64)), true);
	});

	test("rejects traversal, separators, empty and overlong ids", () => {
		for (const bad of ["", "../x", "a/b", "x/../../e", "a b", "a".repeat(65)]) {
			assert.strictEqual(isValidSessionId(bad), false, bad);
		}
		assert.strictEqual(isValidSessionId(undefined), false);
		assert.strictEqual(isValidSessionId(5), false);
	});
});
