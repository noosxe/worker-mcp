import assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";

import { createIsolation, type Isolation } from "../helpers/isolation.js";
import { DIST_ENTRY, RUNTIME } from "../helpers/stdio.js";

let iso: Isolation;
beforeEach(() => {
	iso = createIsolation();
});
afterEach(async () => {
	await iso.cleanup();
});

const run = (args: string[], extra: Record<string, string> = {}) =>
	spawnSync(RUNTIME, [DIST_ENTRY, ...args], {
		env: { ...iso.env, ...extra },
		encoding: "utf8",
		input: "",
		timeout: 20_000,
	});

describe(`config CLI (${RUNTIME})`, () => {
	test("--print-config prints the effective config and exits", () => {
		const r = run(["--print-config", "--max-output-chars", "123"], {
			WORKER_MCP_COMMAND_TIMEOUT: "456",
		});
		assert.strictEqual(r.status, 0, r.stderr);
		const config = JSON.parse(r.stdout);
		assert.strictEqual(config.limits.maxOutputChars, 123);
		assert.strictEqual(config.limits.commandTimeoutMs, 456);
		assert.strictEqual(config.providers.pi.path, iso.env.WORKER_MCP_PI_PATH);
		// Printing creates nothing on disk.
		assert.deepStrictEqual(fs.readdirSync(iso.env.XDG_RUNTIME_DIR), []);
	});

	test("an invalid setting fails startup and names the variable", () => {
		const r = run([], { WORKER_MCP_MAX_OUTPUT_CHARS: "abc" });
		assert.strictEqual(r.status, 1);
		assert.match(r.stderr, /env WORKER_MCP_MAX_OUTPUT_CHARS/);
		assert.strictEqual(r.stdout, "");
	});

	test("an unknown key in the config file fails startup", () => {
		const file = `${iso.root}/bad.json`;
		fs.writeFileSync(file, '{"nope":1}', { mode: 0o600 });
		const r = run(["--config", file]);
		assert.strictEqual(r.status, 1);
		assert.match(r.stderr, /unknown key nope/);
	});

	test("a clean shutdown leaves no runtime dir behind", () => {
		// stdin is closed straight away, so the server connects and exits.
		const r = run([]);
		assert.strictEqual(r.status, 0, r.stderr);
		assert.deepStrictEqual(fs.readdirSync(iso.env.XDG_RUNTIME_DIR), []);
	});
});
