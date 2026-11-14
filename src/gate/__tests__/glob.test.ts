import assert from "node:assert";
import test, { describe } from "node:test";

import { MAX_GLOB_LENGTH, matchCommand, matchGlob } from "../glob.js";

describe("matchGlob", () => {
	test("literal, star and empty", () => {
		assert.ok(matchGlob("git status", "git status"));
		assert.ok(matchGlob("git commit -m msg", "git commit*"));
		assert.ok(matchGlob("sudo rm -rf", "*rm*"));
		assert.ok(matchGlob("", "*"));
		assert.ok(matchGlob("", ""));
		assert.ok(!matchGlob("a", ""));
		assert.ok(!matchGlob("git status", "git"));
		assert.ok(!matchGlob("xgit", "git*"));
	});

	test("a star crosses slashes", () => {
		assert.ok(matchGlob("/work/src/a/b.ts", "*/src/*"));
		assert.ok(matchGlob("/work/src/a/b.ts", "/work/**/b.ts"));
	});

	test("regex metacharacters in the pattern are literal", () => {
		assert.ok(matchGlob("a.b", "a.b"));
		assert.ok(!matchGlob("axb", "a.b"));
		assert.ok(matchGlob("(x)+", "(x)+"));
		assert.ok(matchGlob("[a]", "[a]"));
		assert.ok(!matchGlob("a", "[a]"));
		assert.ok(matchGlob("?", "?"));
		assert.ok(!matchGlob("a", "?"));
	});

	test("stars in the middle and at both ends", () => {
		assert.ok(matchGlob("abcabc", "a*c*c"));
		assert.ok(matchGlob("abc", "*a*b*c*"));
		assert.ok(!matchGlob("acb", "*a*b*c*"));
	});

	test("a pathological pattern finishes fast", () => {
		// `(a*)*b`-style blow-ups in a backtracking engine: many stars and no
		// match at the end.
		const pattern = `${"*a".repeat(200)}*b`;
		const input = "a".repeat(4000);
		const t0 = performance.now();
		assert.strictEqual(matchGlob(input, pattern), false);
		assert.strictEqual(matchCommand(input, pattern), false);
		const ms = performance.now() - t0;
		assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
	});

	test("a pathological pattern that does match also finishes fast", () => {
		const pattern = "*a".repeat(250);
		const input = "a".repeat(8000);
		const t0 = performance.now();
		assert.strictEqual(matchGlob(input, pattern), true);
		assert.ok(performance.now() - t0 < 2000);
	});

	test("an over-long pattern or input never matches", () => {
		assert.ok(!matchGlob("a", "*".repeat(MAX_GLOB_LENGTH + 1)));
		assert.ok(!matchGlob("a".repeat(70000), "*"));
	});
});

describe("matchCommand", () => {
	test("`*` matches ordinary arguments", () => {
		assert.ok(matchCommand("git log --oneline", "git *"));
		assert.ok(matchCommand("git", "git*"));
	});

	test("`*` stops at chaining, substitution, redirection and newlines", () => {
		for (const bad of [
			"git status; rm -rf ~",
			"git status && x",
			"git status | sh",
			"git status\nrm -rf ~",
			"git $(id)",
			"git `id`",
			"git status > f",
			"git status & x",
		]) {
			assert.ok(!matchCommand(bad, "git *"), bad);
		}
	});

	test("metacharacters written in the pattern still match literally", () => {
		assert.ok(matchCommand("ls | wc -l", "ls | wc *"));
		assert.ok(!matchCommand("ls | wc -l; id", "ls | wc *"));
	});
});
