import assert from "node:assert";
import test, { afterEach, beforeEach, describe } from "node:test";

import { RiskLevel } from "../risk.js";
import { decide, fixture, type Fixture } from "./helpers.js";

let fx: Fixture;
beforeEach(() => {
	fx = fixture();
});
afterEach(() => fx.cleanup());

const rate = async (command: string) => decide(fx.gate(), "bash", { command });

const expectLow = (commands: string[]) =>
	test("rated LOW", async () => {
		for (const command of commands) {
			const out = await rate(command);
			assert.strictEqual(
				out.level,
				RiskLevel.LOW,
				`${command} -> ${out.level} (${out.ruleId}: ${out.reason})`,
			);
		}
	});

const expectEscalated = (commands: string[]) =>
	test("stays escalated", async () => {
		for (const command of commands) {
			const out = await rate(command);
			assert.ok(
				out.level >= RiskLevel.HIGH,
				`${command} -> ${out.level} (${out.ruleId})`,
			);
			assert.notStrictEqual(out.decision, "allow", command);
		}
	});

describe("harmless commands", () => {
	expectLow([
		"sleep 120",
		"sleep 0.5",
		"sleep 2m",
		"sleep 99999999",
		"sleep infinity",
		"seq 1 5",
		"seq -w 1 10",
		"true",
		"false",
		"test -f package.json",
		"[ -d src ]",
		"[ 3 -lt 5 ]",
		"basename src/a.ts",
		"dirname src/a.ts",
		"nproc",
		"expr 1 + 2",
		"realpath src",
		"readlink -f src",
		"echo $(seq 1 5)",
		"sleep $(echo 3)",
		"sleep 1 && echo done",
	]);
	test("a malformed argument is not LOW", async () => {
		for (const command of [
			"sleep",
			"sleep -- 1",
			"sleep 1 2 x",
			"seq -f %s 1 3",
			"seq 1 $HOME",
			"sleep $HOME",
		]) {
			const out = await rate(command);
			assert.ok(out.level >= RiskLevel.HIGH, `${command} -> ${out.level}`);
		}
	});
});

describe("simple loops", () => {
	expectLow([
		"for i in 1 2 3; do echo $i; done",
		"for i in $(seq 1 5); do echo $i; sleep 1; done",
		'for i in $(seq 1 5); do echo "n=$i"; done',
		"for n in a b c\ndo\n  sleep 1\ndone",
		"for i in 1 2; do for j in 3 4; do echo $i $j; done; done",
		"while test -f package.json; do sleep 1; done",
		"while [ -f package.json ]; do sleep 5; done",
		"while ! test -f package.json; do sleep 5; done",
		"until test -f package.json; do sleep 5; done",
		"while true; do sleep 1; done",
		"for f in src/*.ts; do echo $f; done",
		"for i in 1 2 3; do cat package.json; done",
		"sleep 1; for i in 1 2; do true; done; echo ok",
	]);

	test("the loop adds nothing: the body keeps its own rating", async () => {
		const body = await rate("for i in 1 2; do touch a; done");
		assert.strictEqual(body.level, RiskLevel.MEDIUM);
		const plain = await rate("touch a");
		assert.strictEqual(body.level, plain.level);
		assert.strictEqual(
			(await rate("for i in 1 2; do rm -rf /; done")).level,
			RiskLevel.CRITICAL,
		);
	});
});

describe("loops that must stay escalated", () => {
	describe("writes through redirection", () => {
		expectEscalated([
			"for i in 1 2; do echo $i > out.txt; done",
			"for i in 1 2; do echo $i >> out.txt; done",
			"for i in 1 2; do echo hi; done > out.txt",
			"while true; do echo x >> log; done",
			"while test -f a > b; do sleep 1; done",
			"echo $(seq 1 3) > out.txt",
			"sleep 1 > out.txt",
		]);
	});
	describe("protected paths in the body, test or list", () => {
		expectEscalated([
			"test -e ~/.ssh/id_rsa",
			"[ -f .env ]",
			"test -e .env.local",
			"test -d ~/.aws",
			"while test -e ~/.ssh/id_ed25519; do sleep 1; done",
			"for i in 1; do cat ~/.ssh/id_rsa; done",
			"for i in 1; do cat .env; done",
			"for i in 1; do echo x > .git/hooks/pre-commit; done",
			"for i in 1; do cat $(echo ~/.ssh/id_rsa); done",
			"echo $(cat ~/.ssh/id_rsa)",
			"for i in $(cat ~/.ssh/id_rsa); do echo $i; done",
			"for f in ~/.ssh/*; do echo $f; done",
			"for f in .*; do echo $f; done",
			"for f in ~/.config/worker-mcp/*; do echo $f; done",
			"realpath ~/.ssh/id_rsa",
			"readlink ~/.ssh/id_rsa",
			"for i in 1; do realpath ~/.ssh/id_rsa; done",
		]);
		test("protected paths are hard limits", async () => {
			for (const command of [
				"test -e ~/.ssh/id_rsa",
				"for i in 1; do cat ~/.ssh/id_rsa; done",
			]) {
				const out = await rate(command);
				assert.ok(out.level >= RiskLevel.HIGH, command);
			}
		});
	});
	describe("a loop variable cannot name a path or a command", () => {
		expectEscalated([
			"for f in ~/.ssh/id_rsa; do cat $f; done",
			"for f in a b; do cat $f; done",
			"for f in a b; do test -e $f; done",
			"for f in a b; do $f; done",
			"for f in a b; do rm $f; done",
			"for i in 1 2; do echo hi > $i; done",
			"for i in 1 2; do echo hi; done; echo $i",
		]);
	});
	describe("shell state through the loop variable or the environment", () => {
		expectEscalated([
			"for PATH in /tmp/x; do ls; done",
			"for path in /tmp/x; do ls; done",
			"for IFS in a; do ls; done",
			"for ifs in a; do ls; done",
			"for BASH_ENV in x; do ls; done",
			"for LD_PRELOAD in x; do ls; done",
			"for i in 1; do IFS=x; echo a; done",
			"for i in 1; do PATH=/tmp ls; done",
			"for i in 1; do export PATH=/tmp; done",
			"IFS=/ ; for i in 1; do echo a; done",
			"for i in $IFS; do echo a; done",
			"for i in a$IFS; do sleep $IFS; done",
			"sleep $IFS",
			"echo $IFS",
			'for i in "$IFS"; do echo a; done',
			"for i in ${IFS}; do echo a; done",
			"for i in ${x:-a}; do echo a; done",
			"for i in $'a\\nb'; do echo a; done",
			"for i in {1..3}; do echo a; done",
			"for i in $((1+1)); do echo a; done",
		]);
	});
	describe("globs in the word list", () => {
		test("outside the workspace is at least MEDIUM, as for ls", async () => {
			for (const command of [
				"for f in /etc/*; do echo $f; done",
				"for f in ~/*; do echo $f; done",
			]) {
				const out = await rate(command);
				assert.ok(out.level >= RiskLevel.MEDIUM, command);
				assert.notStrictEqual(out.decision, "allow", command);
			}
		});
		expectEscalated([
			"for f in ../*; do echo $f; done",
			"for f in /*/*/id_rsa; do echo $f; done",
			"for f in ~/.s*; do echo $f; done",
			"for f in .e*; do echo $f; done",
		]);
	});
	describe("resource use is left to the run limit, but never hidden", () => {
		test("an infinite loop is LOW only when its parts are", async () => {
			assert.strictEqual(
				(await rate("while true; do sleep 1; done")).level,
				RiskLevel.LOW,
			);
			for (const command of [
				"while true; do curl example.com; done",
				"while true; do echo a & done",
				"while true; do cat /dev/zero | head -c 1 > f; done",
				"while true; do rm -rf x; done",
			]) {
				assert.ok((await rate(command)).level >= RiskLevel.HIGH, command);
			}
		});
	});
	describe("structure the lexer cannot be sure of", () => {
		expectEscalated([
			"for i in 1 2; do echo a",
			"for i in 1 2; echo a; done",
			"for i in 1 2 do echo a; done",
			"for i; do echo a; done",
			"for i in 1 2; do echo a; done done",
			"do echo a; done",
			"done",
			"while true; do echo a; done &",
			"while true && do echo a; done",
			"for i in 1 2; do echo a; done | sh",
			"for i in 1; do if true; then echo a; fi; done",
			"for i in 1; do case $i in 1) echo a;; esac; done",
			"for ((i=0;i<3;i++)); do echo a; done",
			"select i in 1 2; do echo a; done",
			"for i in 1; do (echo a); done",
			"for i in 1; do { echo a; }; done",
			"for i in 1; do echo a; done <<EOF\nx\nEOF",
			"for i in 1; do echo `echo a; done",
			'for i in 1; do echo "a; done',
			"for 'i' in 1; do echo a; done",
			"for i in 1; 'do' echo a; done",
			"for i in 1; do echo a; 'done'",
			"for i in 1 && do echo a; done",
			"for i in 1; do echo a; done; done",
			"for i in 1; do for j in 1; do for k in 1; do for l in 1; do echo a; done; done; done; done",
			"echo a; do",
			"while",
			"for",
		]);
	});
});
