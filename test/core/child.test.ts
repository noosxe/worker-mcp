import assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import {
	FAKE_PI,
	createIsolation,
	type Isolation,
} from "../helpers/isolation.js";
import { REPO_ROOT } from "../helpers/isolation.js";
import { RUNTIME } from "../helpers/stdio.js";

// ChildRegistry is exercised through a small driver script that runs under the
// runtime being tested (Node or Bun); the assertions are made out here.
const DRIVER = path.join(REPO_ROOT, "test", "fixtures", "child-driver.mjs");

describe(`core/child under ${RUNTIME}`, () => {
	let iso: Isolation;
	before(() => {
		iso = createIsolation();
	});
	after(async () => {
		await iso.cleanup();
	});

	function drive(scenario: string): Record<string, any> {
		const res = spawnSync(RUNTIME, [DRIVER, scenario, FAKE_PI], {
			env: iso.env,
			cwd: iso.cwd,
			encoding: "utf8",
			timeout: 20_000,
		});
		assert.strictEqual(res.status, 0, `driver failed: ${res.stderr}`);
		return JSON.parse(res.stdout.trim().split("\n").pop() as string);
	}

	test("terminate kills a grandchild in its own process group", () => {
		const r = drive("grandchild");
		assert.strictEqual(r.aliveBefore, true, "the grandchild was running");
		assert.strictEqual(r.grandchildAlive, false);
		assert.strictEqual(r.alive, false);
	});

	test("a worker that ignores SIGTERM is killed after the grace period", () => {
		const r = drive("ignore-sigterm");
		assert.strictEqual(r.alive, false);
		assert.strictEqual(r.exit.signal, "SIGKILL");
		assert.ok(r.ms >= 350, `waited the grace period (${r.ms} ms)`);
		assert.ok(r.ms < 3000, `did not wait longer than needed (${r.ms} ms)`);
	});

	test("terminating everything on shutdown leaves no process behind", () => {
		const r = drive("shutdown");
		assert.deepStrictEqual(r.alive, [false, false, false]);
		assert.strictEqual(r.size, 0);
	});

	test("terminating twice is safe and shares one result", () => {
		const r = drive("double-terminate");
		assert.strictEqual(r.samePromise, true);
		assert.strictEqual(r.alive, false);
	});

	test("writing to a worker that closed its stdin does not crash", () => {
		const r = drive("epipe");
		// The driver finishing normally is the main assertion: an unhandled
		// EPIPE would have killed it. Every send answers, one way or another.
		assert.strictEqual(r.results.length, 5);
		for (const x of r.results) assert.notStrictEqual(x.err, "no callback");
		// Node reports the broken pipe through the write callback. Bun accepts
		// writes to a closed pipe silently, so there is nothing to report there.
		if (RUNTIME === "node") {
			assert.ok(
				r.results.some((x: { err: string | null }) => x.err !== null),
				"at least one write reported the broken pipe",
			);
		}
		assert.strictEqual(r.stillThere, true);
	});

	test("send after the worker exited returns false and never throws", () => {
		const r = drive("send-after-exit");
		assert.strictEqual(r.threw, false);
		assert.strictEqual(r.accepted, false);
		assert.match(r.cbErr, /closed/);
	});

	test("an oversized line is dropped and framing recovers", () => {
		const r = drive("oversize");
		// {"a":1} and {"b":2} are 7 chars each; the 5000-char line is dropped, and
		// the unterminated 3500-char tail is over the 3000-char cap too.
		assert.deepStrictEqual(r.lines, [7, 7]);
		assert.deepStrictEqual(r.problems, ["line_too_long"]);
		assert.deepStrictEqual(r.stderr, [51], "stderr line cut to 50 chars + …");
	});

	test("a missing binary rejects `started`, settles `exited` and is forgotten", () => {
		const r = drive("spawn-failure");
		assert.strictEqual(r.startedRejected, true);
		assert.strictEqual(r.hasError, true);
		assert.strictEqual(r.size, 0);
		assert.strictEqual(r.terminateOk, true);
	});

	test("the worker environment is the allowlist plus provider extras", () => {
		const r = drive("env");
		assert.ok(r.names.includes("WM_EXTRA"));
		assert.ok(r.names.includes("PATH"));
		for (const secret of [
			"GITHUB_TOKEN",
			"AWS_SECRET_ACCESS_KEY",
			"MY_API_KEY",
			"SSH_AUTH_SOCK",
			"WM_TEST_NOT_PASSED",
		]) {
			assert.ok(!r.names.includes(secret), `${secret} must not be passed`);
		}
	});
});
