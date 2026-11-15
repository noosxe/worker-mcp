import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";

import { defaultConfig, ConfigError, type Config } from "../../config.js";
import { GateServices } from "../services.js";
import {
	readTokenFile,
	tokenFileProblem,
	TokenFileError,
} from "../token-file.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-mcp-token-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const put = (name: string, text: string, mode: number) => {
	const file = path.join(dir, name);
	fs.writeFileSync(file, text);
	fs.chmodSync(file, mode);
	return file;
};

describe("token file", () => {
	test("0600 and 0400 are accepted, and the token is trimmed", () => {
		assert.strictEqual(readTokenFile(put("a", "abc\n", 0o600)), "abc");
		assert.strictEqual(readTokenFile(put("b", "abc", 0o400)), "abc");
	});

	test("group- or world-accessible files are refused", () => {
		for (const mode of [0o640, 0o604, 0o660, 0o644, 0o440, 0o666]) {
			assert.throws(
				() => readTokenFile(put(`m${mode}`, "abc", mode)),
				/accessible to group or others/,
				mode.toString(8),
			);
		}
	});

	test("a file of another user is refused", () => {
		const base = { mode: 0o600, isFile: () => true };
		assert.match(
			tokenFileProblem({ ...base, uid: 1001 }, 1000) ?? "",
			/not owned/,
		);
		assert.strictEqual(tokenFileProblem({ ...base, uid: 1000 }, 1000), null);
		assert.strictEqual(tokenFileProblem({ ...base, uid: 5 }, null), null);
	});

	test("a symlink is judged by its target (the sops-nix layout)", () => {
		const target = put("secret", "viasymlink", 0o400);
		const link = path.join(dir, "link");
		fs.symlinkSync(target, link);
		// The link itself has mode 0777 on Linux: only the target counts.
		assert.strictEqual(readTokenFile(link), "viasymlink");
		const loose = put("loose", "x", 0o644);
		const bad = path.join(dir, "badlink");
		fs.symlinkSync(loose, bad);
		assert.throws(() => readTokenFile(bad), /accessible to group or others/);
	});

	test("missing, empty, directory and multi-line files are errors that never quote the token", () => {
		assert.throws(
			() => readTokenFile(path.join(dir, "nope")),
			/cannot read token file/,
		);
		assert.throws(() => readTokenFile(put("e", " \n", 0o600)), /is empty/);
		assert.throws(() => readTokenFile(dir), TokenFileError);
		try {
			readTokenFile(put("two", "line-one-secret\nline-two", 0o600));
			assert.fail("expected an error");
		} catch (e) {
			assert.match((e as Error).message, /more than one line/);
			assert.ok(!(e as Error).message.includes("line-one-secret"));
		}
	});
});

const configWith = (tokenFile: string, over: Partial<Config["gate"]> = {}) => {
	const config = defaultConfig();
	config.audit.enabled = false;
	config.gate = {
		...config.gate,
		mode: "auto",
		classifiers: [
			{
				name: "c",
				url: "https://example.com/x",
				tokenFile,
				dialect: "worker-mcp-v1",
				timeoutMs: 1000,
				minAllowConfidence: 0.85,
				minDenyConfidence: 0.6,
				maxArgumentBytes: 8192,
				sendIntent: true,
				breaker: { failures: 5, coolDownMs: 60_000 },
			},
		],
		...over,
	};
	return config;
};

describe("GateServices", () => {
	test("a missing or insecure token file at startup is a ConfigError naming the key", () => {
		assert.throws(
			() => new GateServices(configWith(path.join(dir, "nope"))),
			(e) =>
				e instanceof ConfigError &&
				/gate\.classifiers c\.tokenFile: cannot read token file/.test(
					e.message,
				),
		);
		assert.throws(
			() => new GateServices(configWith(put("w", "x", 0o666))),
			ConfigError,
		);
	});

	test("manual mode needs no token file and builds no classifier", () => {
		const s = new GateServices(
			configWith(path.join(dir, "nope"), { mode: "manual" }),
		);
		assert.deepStrictEqual(s.classifiers, []);
		assert.strictEqual(s.hasTokenFiles, false);
	});

	test("reloading picks up a rotated token and keeps the old one on failure", () => {
		const file = put("t", "first", 0o600);
		const logs: string[] = [];
		const s = new GateServices(configWith(file), { log: (m) => logs.push(m) });
		assert.strictEqual(s.hasTokenFiles, true);
		fs.writeFileSync(file, "second");
		assert.deepStrictEqual(s.reloadTokens(), { reloaded: 1, failed: 0 });
		fs.chmodSync(file, 0o644);
		assert.deepStrictEqual(s.reloadTokens(), { reloaded: 0, failed: 1 });
		assert.match(logs.join("\n"), /keeping the old token of classifier c/);
		assert.ok(!logs.join("\n").includes("second"));
		fs.chmodSync(file, 0o600);
		fs.writeFileSync(file, "third");
		s.reloadTokens();
	});
});
