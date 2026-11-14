import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

import {
	assertGatePresent,
	buildWorkerEnv,
	GateError,
	removeGate,
	writeGate,
} from "../session/launch.js";

describe("buildWorkerEnv", () => {
	test("starts from empty and keeps only allowlisted names", () => {
		const env = buildWorkerEnv({
			PATH: "/bin",
			HOME: "/h",
			LC_ALL: "C",
			PI_CODING_AGENT_DIR: "/pi",
			SSL_CERT_FILE: "/c",
			RANDOM_VAR: "x",
			GITHUB_TOKEN: "t",
		});
		assert.deepStrictEqual(env, {
			PATH: "/bin",
			HOME: "/h",
			LC_ALL: "C",
			PI_CODING_AGENT_DIR: "/pi",
			SSL_CERT_FILE: "/c",
		});
	});

	test("passthrough adds names and prefixes", () => {
		const env = buildWorkerEnv({
			WORKER_MCP_ENV_PASSTHROUGH: " ANTHROPIC_API_KEY , CORP_*",
			ANTHROPIC_API_KEY: "k",
			CORP_PROXY: "p",
			OTHER: "o",
		});
		assert.deepStrictEqual(env, { ANTHROPIC_API_KEY: "k", CORP_PROXY: "p" });
	});

	test("secrets are dropped even when passed through", () => {
		const names = [
			"SSH_AUTH_SOCK",
			"GPG_AGENT_INFO",
			"GITHUB_TOKEN",
			"MY_SECRET",
			"CLIENT_SECRET_ID",
			"AWS_ACCESS_KEY_ID",
			"AWS_PROFILE",
			"GOOGLE_APPLICATION_CREDENTIALS",
			"KUBECONFIG",
			"DOCKER_HOST",
			"WORKER_MCP_PI_PATH",
			"PI_API_TOKEN",
		];
		const source: Record<string, string> = {
			WORKER_MCP_ENV_PASSTHROUGH: `${names.join(",")},AWS_*`,
		};
		for (const name of names) source[name] = "v";
		assert.deepStrictEqual(buildWorkerEnv(source), {});
	});
});

describe("writeGate", () => {
	test("writes a private gate and removes it", () => {
		const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "worker-mcp-gate-"));
		try {
			const gate = writeGate({ XDG_RUNTIME_DIR: runtime });
			assert.strictEqual(fs.statSync(gate.dir).mode & 0o777, 0o700);
			assert.strictEqual(fs.statSync(gate.file).mode & 0o777, 0o600);
			assertGatePresent(gate);
			removeGate(gate);
			removeGate(gate);
			assert.ok(!fs.existsSync(gate.dir));
			assert.throws(() => assertGatePresent(gate), GateError);
		} finally {
			fs.rmSync(runtime, { recursive: true, force: true });
		}
	});

	test("throws GateError when the runtime dir is unusable", () => {
		const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "worker-mcp-gate-"));
		try {
			fs.writeFileSync(path.join(runtime, "worker-mcp"), "x");
			assert.throws(
				() => writeGate({ XDG_RUNTIME_DIR: runtime }),
				/without the approval gate/,
			);
		} finally {
			fs.rmSync(runtime, { recursive: true, force: true });
		}
	});
});
