import assert from "node:assert";
import { describe, test } from "node:test";

import { buildWorkerEnv } from "../core/env.js";

const NONE = { allow: [], forceDropExempt: [] };

describe("buildWorkerEnv", () => {
	test("starts from empty and keeps only allowlisted names", () => {
		const env = buildWorkerEnv(
			{
				PATH: "/bin",
				HOME: "/h",
				LC_ALL: "C",
				PI_CODING_AGENT_DIR: "/pi",
				SSL_CERT_FILE: "/c",
				RANDOM_VAR: "x",
				GITHUB_TOKEN: "t",
			},
			NONE,
		);
		assert.deepStrictEqual(env, {
			PATH: "/bin",
			HOME: "/h",
			LC_ALL: "C",
			PI_CODING_AGENT_DIR: "/pi",
			SSL_CERT_FILE: "/c",
		});
	});

	test("passthrough adds names and prefixes", () => {
		const env = buildWorkerEnv(
			{ ANTHROPIC_API_KEY: "k", CORP_PROXY: "p", OTHER: "o" },
			{ allow: ["ANTHROPIC_API_KEY", "CORP_*"], forceDropExempt: [] },
		);
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
		const source: Record<string, string> = {};
		for (const name of names) source[name] = "v";
		assert.deepStrictEqual(
			buildWorkerEnv(source, {
				allow: [...names, "AWS_*"],
				forceDropExempt: [],
			}),
			{},
		);
	});

	test("a name exempted from the config file passes despite a force-drop pattern", () => {
		const source = { MY_API_TOKEN: "t", OTHER_TOKEN: "o", AWS_PROFILE: "p" };
		// Exempt only when it is also allowed, and only that exact name.
		assert.deepStrictEqual(
			buildWorkerEnv(source, {
				allow: ["MY_API_TOKEN", "OTHER_TOKEN", "AWS_*"],
				forceDropExempt: ["MY_API_TOKEN"],
			}),
			{ MY_API_TOKEN: "t" },
		);
		assert.deepStrictEqual(
			buildWorkerEnv(source, {
				allow: ["MY_API_TOKEN"],
				forceDropExempt: [],
			}),
			{},
		);
	});
});
