import assert from "node:assert";
import { describe, test } from "node:test";

import {
	isValidSessionId,
	readPositiveIntEnv,
	validateEnv,
} from "../validation.js";

describe("readPositiveIntEnv", () => {
	test("returns undefined when unset or empty", () => {
		assert.strictEqual(readPositiveIntEnv("X", {}), undefined);
		assert.strictEqual(readPositiveIntEnv("X", { X: "  " }), undefined);
	});

	test("parses positive integers", () => {
		assert.strictEqual(readPositiveIntEnv("X", { X: "1500" }), 1500);
	});

	test("rejects NaN, zero, negatives, fractions and trailing junk", () => {
		for (const bad of ["abc", "NaN", "0", "-5", "1.5", "10ms", "1e3"]) {
			assert.throws(
				() => readPositiveIntEnv("X", { X: bad }),
				/Invalid value for X/,
				bad,
			);
		}
	});

	test("validateEnv names the offending variable", () => {
		assert.throws(
			() => validateEnv({ WORKER_MCP_COMMAND_TIMEOUT: "abc" }),
			/WORKER_MCP_COMMAND_TIMEOUT/,
		);
		assert.doesNotThrow(() => validateEnv({}));
	});
});

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
