import assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
	ConfigError,
	configFileProblem,
	defaultConfig,
	formatConfig,
	loadConfig,
	parseArgs,
	redactConfig,
} from "../config.js";
import { buildWorkerEnv } from "../core/env.js";

let root: string;
let env: Record<string, string>;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-mcp-config-"));
	env = {
		HOME: path.join(root, "home"),
		XDG_CONFIG_HOME: path.join(root, "config"),
		XDG_STATE_HOME: path.join(root, "state"),
		XDG_RUNTIME_DIR: path.join(root, "runtime"),
	};
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function writeFile(content: unknown, mode = 0o600): string {
	const file = path.join(root, "config.json");
	fs.writeFileSync(
		file,
		typeof content === "string" ? content : JSON.stringify(content),
		{ mode },
	);
	fs.chmodSync(file, mode);
	return file;
}

const load = (argv: string[] = [], e = env) => loadConfig(argv, e).config;

function failure(fn: () => unknown): string {
	try {
		fn();
	} catch (e) {
		assert.ok(e instanceof ConfigError, String(e));
		return e.message;
	}
	assert.fail("expected the config to be rejected");
}

describe("run limits", () => {
	test("come from the file, the environment and flags", () => {
		const file = path.join(root, "limits.json");
		fs.writeFileSync(
			file,
			JSON.stringify({
				limits: { maxRunMs: 111, maxWaitMs: 20_000, defaultWaitMs: 30_000 },
				gate: { approvalTimeoutMs: 222 },
			}),
			{ mode: 0o600 },
		);
		const fromFile = load([`--config=${file}`]);
		assert.strictEqual(fromFile.limits.maxRunMs, 111);
		assert.strictEqual(fromFile.gate.approvalTimeoutMs, 222);
		// The default wait never exceeds the longest wait.
		assert.strictEqual(fromFile.limits.defaultWaitMs, 20_000);

		const fromEnv = load([`--config=${file}`], {
			...env,
			WORKER_MCP_RUN_TIMEOUT_MS: "333",
			WORKER_MCP_APPROVAL_TIMEOUT_MS: "444",
			WORKER_MCP_MAX_WAIT_MS: "5000",
		});
		assert.strictEqual(fromEnv.limits.maxRunMs, 333);
		assert.strictEqual(fromEnv.gate.approvalTimeoutMs, 444);
		assert.strictEqual(fromEnv.limits.maxWaitMs, 5000);

		const fromFlag = load(
			["--run-timeout-ms", "555", "--approval-timeout-ms=666"],
			{ ...env, WORKER_MCP_RUN_TIMEOUT_MS: "333" },
		);
		assert.strictEqual(fromFlag.limits.maxRunMs, 555);
		assert.strictEqual(fromFlag.gate.approvalTimeoutMs, 666);
	});

	test("a bad value fails and names its source", () => {
		const message = failure(() =>
			load([], { ...env, WORKER_MCP_RUN_TIMEOUT_MS: "soon" }),
		);
		assert.match(message, /WORKER_MCP_RUN_TIMEOUT_MS.*limits\.maxRunMs/);
	});
});

describe("worker limits", () => {
	test("default to 4 workers, a 30 minute idle timeout and no roots", () => {
		const { limits } = load();
		assert.strictEqual(limits.maxWorkers, 4);
		assert.strictEqual(limits.idleTimeoutMs, 30 * 60_000);
		assert.deepStrictEqual(limits.allowedRoots, []);
	});

	test("come from the file, the environment and flags, and are printed", () => {
		const file = writeFile({
			limits: { maxWorkers: 2, idleTimeoutMs: 1000, allowedRoots: ["/a"] },
		});
		const fromFile = load([`--config=${file}`]);
		assert.strictEqual(fromFile.limits.maxWorkers, 2);
		assert.strictEqual(fromFile.limits.idleTimeoutMs, 1000);
		assert.deepStrictEqual(fromFile.limits.allowedRoots, ["/a"]);

		const fromEnv = load([`--config=${file}`], {
			...env,
			WORKER_MCP_MAX_WORKERS: "3",
			WORKER_MCP_IDLE_TIMEOUT_MS: "2000",
			WORKER_MCP_ALLOWED_ROOTS: "/b, /c",
		});
		assert.strictEqual(fromEnv.limits.maxWorkers, 3);
		assert.strictEqual(fromEnv.limits.idleTimeoutMs, 2000);
		assert.deepStrictEqual(fromEnv.limits.allowedRoots, ["/b", "/c"]);

		const fromFlag = load(
			["--max-workers=5", "--idle-timeout-ms", "3000", "--allowed-roots=/d"],
			{ ...env, WORKER_MCP_MAX_WORKERS: "3" },
		);
		assert.strictEqual(fromFlag.limits.maxWorkers, 5);
		assert.strictEqual(fromFlag.limits.idleTimeoutMs, 3000);
		assert.deepStrictEqual(fromFlag.limits.allowedRoots, ["/d"]);

		const printed = JSON.parse(formatConfig(fromFlag));
		assert.strictEqual(printed.limits.maxWorkers, 5);
		assert.deepStrictEqual(printed.limits.allowedRoots, ["/d"]);
	});

	test("bad values fail and name their source", () => {
		assert.match(
			failure(() => load([], { ...env, WORKER_MCP_MAX_WORKERS: "0" })),
			/WORKER_MCP_MAX_WORKERS.*limits\.maxWorkers/,
		);
		assert.match(
			failure(() => load([], { ...env, WORKER_MCP_ALLOWED_ROOTS: "rel/dir" })),
			/WORKER_MCP_ALLOWED_ROOTS.*limits\.allowedRoots/,
		);
		assert.match(
			failure(() => load(["--max-workers", "many"])),
			/--max-workers/,
		);
	});
});

describe("defaults", () => {
	test("need no file and no environment", () => {
		const config = load();
		assert.strictEqual(config.providers.pi.path, "pi");
		assert.strictEqual(config.providers.pi.startupTimeoutMs, 60000);
		assert.strictEqual(config.limits.commandTimeoutMs, null);
		assert.strictEqual(config.limits.maxOutputChars, 64000);
		assert.deepStrictEqual(config.env, { allow: [], forceDropExempt: [] });
		assert.deepStrictEqual(config.gate, {
			maxAutoApprove: "MEDIUM",
			protectedPaths: [],
			approvalTimeoutMs: 600_000,
			mode: "manual",
			httpAllowCeiling: "HIGH",
			onClassifierFailure: "escalate",
			classifiers: [],
			cache: { maxEntries: 1000, maxTtlMs: 600_000 },
			recentActions: 10,
		});
		assert.strictEqual(config.audit.enabled, true);
		assert.match(config.audit.file, /worker-mcp\/audit\.jsonl$/);
		assert.strictEqual(config.limits.maxRunMs, 1_800_000);
		assert.strictEqual(config.limits.maxWaitMs, 50_000);
		assert.strictEqual(config.limits.defaultWaitMs, 25_000);
		assert.strictEqual(config.stateDir, path.join(root, "state", "worker-mcp"));
		assert.strictEqual(config.runtimeDir, env.XDG_RUNTIME_DIR);
	});

	test("runtimeDir falls back to the state dir without XDG_RUNTIME_DIR", () => {
		const { XDG_RUNTIME_DIR: _unused, ...rest } = env;
		assert.strictEqual(
			load([], rest).runtimeDir,
			path.join(root, "state", "worker-mcp", "run"),
		);
	});

	test("loading reads the default file location and creates nothing", () => {
		const dir = path.join(env.XDG_CONFIG_HOME, "worker-mcp");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "config.json"),
			JSON.stringify({ providers: { pi: { path: "from-default-file" } } }),
			{ mode: 0o600 },
		);
		const loaded = loadConfig([], env);
		assert.strictEqual(loaded.config.providers.pi.path, "from-default-file");
		assert.strictEqual(loaded.configFile, path.join(dir, "config.json"));
		assert.ok(!fs.existsSync(env.XDG_STATE_HOME));
	});
});

describe("providers.pi.startupTimeoutMs", () => {
	test("file < env < flag, and the path next to it is kept", () => {
		const file = writeFile({
			providers: { pi: { path: "file-pi", startupTimeoutMs: 1000 } },
		});
		let config = load(["--config", file]);
		assert.strictEqual(config.providers.pi.startupTimeoutMs, 1000);
		assert.strictEqual(config.providers.pi.path, "file-pi");
		const withEnv = {
			...env,
			WORKER_MCP_PI_STARTUP_TIMEOUT_MS: "2000",
			WORKER_MCP_PI_PATH: "env-pi",
		};
		config = load(["--config", file], withEnv);
		assert.strictEqual(config.providers.pi.startupTimeoutMs, 2000);
		assert.strictEqual(config.providers.pi.path, "env-pi");
		config = load(["--config", file, "--pi-startup-timeout-ms=3000"], withEnv);
		assert.strictEqual(config.providers.pi.startupTimeoutMs, 3000);
		assert.strictEqual(config.providers.pi.path, "env-pi");
	});

	test("must be a positive integer, from every source", () => {
		for (const bad of ["0", "-5", "1.5", "abc"]) {
			assert.throws(
				() => load([], { ...env, WORKER_MCP_PI_STARTUP_TIMEOUT_MS: bad }),
				/WORKER_MCP_PI_STARTUP_TIMEOUT_MS|startupTimeoutMs/,
				`env ${bad}`,
			);
			assert.throws(
				() => load([`--pi-startup-timeout-ms=${bad}`]),
				/--pi-startup-timeout-ms|startupTimeoutMs/,
				`flag ${bad}`,
			);
		}
		for (const bad of [0, -1, 1.5, "60", null]) {
			const file = writeFile({ providers: { pi: { startupTimeoutMs: bad } } });
			assert.throws(() => load(["--config", file]), /startupTimeoutMs/);
		}
	});
});

describe("precedence", () => {
	test("file < env < flag", () => {
		const file = writeFile({
			providers: { pi: { path: "file-pi" } },
			limits: { commandTimeoutMs: 1000, maxOutputChars: 111 },
		});
		let config = load(["--config", file]);
		assert.strictEqual(config.providers.pi.path, "file-pi");
		assert.strictEqual(config.limits.commandTimeoutMs, 1000);
		assert.strictEqual(config.limits.maxOutputChars, 111);

		const withEnv = {
			...env,
			WORKER_MCP_PI_PATH: "env-pi",
			WORKER_MCP_COMMAND_TIMEOUT: "2000",
		};
		config = load(["--config", file], withEnv);
		assert.strictEqual(config.providers.pi.path, "env-pi");
		assert.strictEqual(config.limits.commandTimeoutMs, 2000);
		assert.strictEqual(config.limits.maxOutputChars, 111);

		config = load(
			["--config", file, "--pi-path", "flag-pi", "--command-timeout-ms=3000"],
			withEnv,
		);
		assert.strictEqual(config.providers.pi.path, "flag-pi");
		assert.strictEqual(config.limits.commandTimeoutMs, 3000);
	});

	test("WORKER_MCP_CONFIG names the file and --config overrides it", () => {
		const a = writeFile({ providers: { pi: { path: "a" } } });
		const bPath = path.join(root, "b.json");
		fs.writeFileSync(
			bPath,
			JSON.stringify({ providers: { pi: { path: "b" } } }),
			{
				mode: 0o600,
			},
		);
		const withEnv = { ...env, WORKER_MCP_CONFIG: a };
		assert.strictEqual(load([], withEnv).providers.pi.path, "a");
		assert.strictEqual(
			load(["--config", bPath], withEnv).providers.pi.path,
			"b",
		);
	});

	test("env allow names accumulate across sources", () => {
		const file = writeFile({ env: { allow: ["FROM_FILE"] } });
		const config = load(["--config", file, "--env-passthrough", "FROM_FLAG"], {
			...env,
			WORKER_MCP_ENV_PASSTHROUGH: " FROM_ENV , CORP_*",
		});
		assert.deepStrictEqual(config.env.allow, [
			"FROM_FILE",
			"FROM_ENV",
			"CORP_*",
			"FROM_FLAG",
		]);
	});

	test("every existing variable keeps its name", () => {
		const config = load([], {
			...env,
			WORKER_MCP_PI_PATH: "/x/pi",
			WORKER_MCP_COMMAND_TIMEOUT: "5",
			WORKER_MCP_MAX_OUTPUT_CHARS: "6",
			WORKER_MCP_ENV_PASSTHROUGH: "A,B_*",
			WORKER_MCP_STATE_DIR: "/s",
			WORKER_MCP_RUNTIME_DIR: "/r",
		});
		assert.strictEqual(config.providers.pi.path, "/x/pi");
		assert.strictEqual(config.limits.commandTimeoutMs, 5);
		assert.strictEqual(config.limits.maxOutputChars, 6);
		assert.deepStrictEqual(config.env.allow, ["A", "B_*"]);
		assert.strictEqual(config.stateDir, "/s");
		assert.strictEqual(config.runtimeDir, "/r");
	});

	test("empty variables count as unset", () => {
		const config = load([], {
			...env,
			WORKER_MCP_PI_PATH: "",
			WORKER_MCP_COMMAND_TIMEOUT: "  ",
		});
		assert.strictEqual(config.providers.pi.path, "pi");
		assert.strictEqual(config.limits.commandTimeoutMs, null);
	});
});

describe("invalid input fails and names the source and key", () => {
	test("bad JSON", () => {
		const file = writeFile("{ nope");
		const msg = failure(() => load(["--config", file]));
		assert.match(msg, /file .*config\.json/);
		assert.match(msg, /not valid JSON/);
	});

	test("unknown keys, top level and nested", () => {
		let msg = failure(() => load(["--config", writeFile({ pipath: "x" })]));
		assert.match(msg, /unknown key pipath/);
		msg = failure(() =>
			load(["--config", writeFile({ limits: { maxOutput: 1 } })]),
		);
		assert.match(msg, /unknown key limits\.maxOutput/);
	});

	test("wrong types and non-positive or NaN numbers in the file", () => {
		for (const bad of ["abc", 0, -5, 1.5, null]) {
			const msg = failure(() =>
				load(["--config", writeFile({ limits: { maxOutputChars: bad } })]),
			);
			assert.match(msg, /file /);
			assert.match(msg, /limits\.maxOutputChars/);
		}
		const msg = failure(() =>
			load(["--config", writeFile({ env: { allow: "ANTHROPIC_API_KEY" } })]),
		);
		assert.match(msg, /env\.allow/);
	});

	test("a JSON document that is not an object", () => {
		assert.match(
			failure(() => load(["--config", writeFile("[]")])),
			/file /,
		);
	});

	test("relative directories are refused", () => {
		const msg = failure(() =>
			load(["--config", writeFile({ stateDir: "relative/dir" })]),
		);
		assert.match(msg, /stateDir.*absolute/);
	});

	test("bad numbers in the environment name the variable", () => {
		for (const bad of ["abc", "NaN", "0", "-1", "1e3", "1.5"]) {
			for (const name of [
				"WORKER_MCP_COMMAND_TIMEOUT",
				"WORKER_MCP_MAX_OUTPUT_CHARS",
			]) {
				const msg = failure(() => load([], { ...env, [name]: bad }));
				assert.match(msg, new RegExp(`env ${name}`));
			}
		}
	});

	test("bad env passthrough entries name the variable", () => {
		const msg = failure(() =>
			load([], { ...env, WORKER_MCP_ENV_PASSTHROUGH: "OK,not ok!" }),
		);
		assert.match(msg, /env WORKER_MCP_ENV_PASSTHROUGH/);
	});

	test("bad flags name the flag", () => {
		assert.match(
			failure(() => load(["--max-output-chars", "lots"])),
			/flag --max-output-chars.*limits\.maxOutputChars/,
		);
		assert.match(
			failure(() => load(["--bogus"])),
			/unknown flag --bogus/,
		);
		assert.match(
			failure(() => load(["--config"])),
			/--config needs a value/,
		);
		assert.match(
			failure(() => load(["--state-dir", "rel"])),
			/flag --state-dir/,
		);
	});

	test("a missing explicit config file fails, a missing default does not", () => {
		const missing = path.join(root, "missing.json");
		assert.match(
			failure(() => load(["--config", missing])),
			/missing\.json/,
		);
		assert.doesNotThrow(() => load());
	});

	test("a group- or world-writable file is refused", () => {
		const file = writeFile({}, 0o666);
		assert.match(
			failure(() => load(["--config", file])),
			/writable/,
		);
	});
});

describe("force-drop exception", () => {
	const source = { FORCED_TOKEN: "t", OTHER_TOKEN: "o", AWS_PROFILE: "p" };
	const effective = (config: ReturnType<typeof load>) =>
		buildWorkerEnv(source, config.env);

	test("a name listed exactly in the file passes", () => {
		const file = writeFile({ env: { allow: ["FORCED_TOKEN"] } });
		assert.deepStrictEqual(effective(load(["--config", file])), {
			FORCED_TOKEN: "t",
		});
	});

	test("the same name from env or a flag does not", () => {
		assert.deepStrictEqual(
			effective(
				load([], { ...env, WORKER_MCP_ENV_PASSTHROUGH: "FORCED_TOKEN" }),
			),
			{},
		);
		assert.deepStrictEqual(
			effective(load(["--env-passthrough", "FORCED_TOKEN"])),
			{},
		);
	});

	test("a pattern in the file does not, even if it matches", () => {
		const file = writeFile({ env: { allow: ["*_TOKEN", "AWS_*"] } });
		const config = load(["--config", file]);
		assert.deepStrictEqual(config.env.forceDropExempt, []);
		assert.deepStrictEqual(effective(config), {});
	});
});

describe("gate settings", () => {
	test("maxAutoApprove comes from the file, the variable and the flag", () => {
		const file = writeFile({ gate: { maxAutoApprove: "LOW" } });
		assert.strictEqual(load(["--config", file]).gate.maxAutoApprove, "LOW");
		assert.strictEqual(
			load(["--config", file], { ...env, WORKER_MCP_MAX_AUTO_APPROVE: "high" })
				.gate.maxAutoApprove,
			"HIGH",
		);
		assert.strictEqual(
			load(["--config", file, "--max-auto-approve", "medium"], {
				...env,
				WORKER_MCP_MAX_AUTO_APPROVE: "HIGH",
			}).gate.maxAutoApprove,
			"MEDIUM",
		);
	});

	test("the ceiling can never be CRITICAL, or anything but a level", () => {
		for (const bad of ["CRITICAL", "critical", "3", "none"]) {
			assert.match(
				failure(() => load([], { ...env, WORKER_MCP_MAX_AUTO_APPROVE: bad })),
				/gate\.maxAutoApprove/,
			);
			assert.match(
				failure(() => load(["--max-auto-approve", bad])),
				/gate\.maxAutoApprove/,
			);
		}
		const file = writeFile({ gate: { maxAutoApprove: "CRITICAL" } });
		assert.match(
			failure(() => load(["--config", file])),
			/maxAutoApprove/,
		);
	});

	test("protectedPaths come from the file, accumulate, and must be absolute or ~/", () => {
		const file = writeFile({
			gate: { protectedPaths: ["/srv/keep", "~/precious", "/srv/keep"] },
		});
		assert.deepStrictEqual(load(["--config", file]).gate.protectedPaths, [
			"/srv/keep",
			"~/precious",
		]);
		const bad = writeFile({ gate: { protectedPaths: ["relative/x"] } });
		assert.match(
			failure(() => load(["--config", bad])),
			/absolute path or start with ~\//,
		);
		const unknown = writeFile({ gate: { other: 1 } });
		assert.match(
			failure(() => load(["--config", unknown])),
			/unknown key gate\.other/,
		);
	});
});

describe("--print-config", () => {
	test("parses as a flag and prints the effective config", () => {
		assert.strictEqual(parseArgs(["--print-config"]).printConfig, true);
		const file = writeFile({ providers: { pi: { path: "file-pi" } } });
		const out = formatConfig(
			load(["--config", file, "--max-output-chars", "9"], env),
		);
		const printed = JSON.parse(out);
		assert.strictEqual(printed.providers.pi.path, "file-pi");
		assert.strictEqual(printed.limits.maxOutputChars, 9);
		assert.ok(out.endsWith("\n"));
	});

	test("redacts secret-looking keys at any depth", () => {
		const redacted = redactConfig({
			apiKey: "k",
			nested: { authToken: "t", clientSecret: "s", password: "p", path: "ok" },
			list: [{ token: "x", name: "visible" }],
			empty: { token: null },
		});
		assert.deepStrictEqual(redacted, {
			apiKey: "[redacted]",
			nested: {
				authToken: "[redacted]",
				clientSecret: "[redacted]",
				password: "[redacted]",
				path: "ok",
			},
			list: [{ token: "[redacted]", name: "visible" }],
			empty: { token: null },
		});
	});

	test("the default config prints no secrets", () => {
		assert.ok(!formatConfig(defaultConfig()).includes("[redacted]"));
	});
});

describe("config file trust", () => {
	const ME = 1000;
	const ok = { mode: 0o100644, uid: ME };
	const dir = { mode: 0o040755, uid: ME };

	test("own file and root's file are accepted, others' are not", () => {
		assert.strictEqual(configFileProblem(ok, dir, ME), null);
		assert.strictEqual(configFileProblem({ ...ok, uid: 0 }, dir, ME), null);
		assert.match(
			configFileProblem({ ...ok, uid: 4242 }, dir, ME) ?? "",
			/owned by you or root/,
		);
	});

	test("group- or world-writable files are refused for either owner", () => {
		for (const uid of [ME, 0]) {
			for (const mode of [0o100664, 0o100646, 0o100666]) {
				assert.match(
					configFileProblem({ mode, uid }, dir, ME) ?? "",
					/writable/,
				);
			}
		}
	});

	test("a writable directory is refused unless root-owned and sticky", () => {
		assert.ok(configFileProblem(ok, { mode: 0o040777, uid: ME }, ME));
		assert.ok(configFileProblem(ok, { mode: 0o040775, uid: 0 }, ME));
		assert.strictEqual(
			configFileProblem(ok, { mode: 0o041777, uid: 0 }, ME),
			null,
		);
		assert.strictEqual(
			configFileProblem(ok, { mode: 0o041775, uid: 0 }, ME), // like /nix/store
			null,
		);
	});

	test("in the Nix store a foreign uid is fine, a writable mode is not", () => {
		const foreign = { mode: 0o100444, uid: 65534 };
		const store = { mode: 0o040755, uid: 65534 };
		assert.strictEqual(configFileProblem(foreign, store, ME, true), null);
		assert.strictEqual(
			configFileProblem(foreign, { mode: 0o040777, uid: 65534 }, ME, true),
			null,
			"directory is not checked",
		);
		assert.match(
			configFileProblem({ ...foreign, mode: 0o100464 }, store, ME, true) ?? "",
			/writable/,
		);
		// The same uid outside the store is still refused.
		assert.match(
			configFileProblem(foreign, store, ME, false) ?? "",
			/owned by you or root/,
		);
	});

	test("a file outside NIX_STORE_DIR does not get the store exemption", () => {
		// Group-writable parent would be refused, so it must not count as store.
		const open = path.join(root, "notstore");
		fs.mkdirSync(open);
		fs.chmodSync(open, 0o777);
		const file = path.join(open, "c.json");
		fs.writeFileSync(file, "{}", { mode: 0o600 });
		assert.match(
			failure(() =>
				load(["--config", file], { ...env, NIX_STORE_DIR: root + "/other" }),
			),
			/directory/,
		);
		// With the store pointed at that directory, the same file is accepted.
		assert.doesNotThrow(() =>
			load(["--config", file], { ...env, NIX_STORE_DIR: open }),
		);
	});

	test("a symlink to a real Nix store file is accepted", (t) => {
		const made = spawnSync(
			"nix",
			[
				"eval",
				"--impure",
				"--raw",
				"--expr",
				'builtins.toFile "worker-mcp-test.json" "{\\"providers\\":{\\"pi\\":{\\"path\\":\\"from-store\\"}}}"',
			],
			{ encoding: "utf8" },
		);
		if (made.status !== 0 || !fs.existsSync(made.stdout.trim())) {
			t.skip("nix is not available");
			return;
		}
		const link = path.join(root, "store-link.json");
		fs.symlinkSync(made.stdout.trim(), link);
		assert.strictEqual(
			load(["--config", link]).providers.pi.path,
			"from-store",
		);
	});

	test("no uid notion: only the mode checks apply", () => {
		assert.strictEqual(configFileProblem({ ...ok, uid: 5 }, dir, null), null);
	});

	test("a symlink to an acceptable file is accepted", () => {
		const target = writeFile({ providers: { pi: { path: "via-link" } } });
		const link = path.join(root, "link.json");
		fs.symlinkSync(target, link);
		assert.strictEqual(load(["--config", link]).providers.pi.path, "via-link");
	});

	test("a file in a world-writable directory is refused", () => {
		const open = path.join(root, "open");
		fs.mkdirSync(open);
		fs.chmodSync(open, 0o777);
		const file = path.join(open, "c.json");
		fs.writeFileSync(file, "{}", { mode: 0o600 });
		assert.match(
			failure(() => load(["--config", file])),
			/directory/,
		);
	});
});

const classifier = (over: Record<string, unknown> = {}) => ({
	name: "local",
	url: "http://127.0.0.1:9/c",
	...over,
});
const withGate = (gate: unknown) => writeFile({ gate });

const jev = (over: Record<string, unknown> = {}) =>
	load([
		"--config",
		withGate({
			mode: "auto",
			classifiers: [
				{ name: "j", dialect: "jev", tokenFile: "/run/secrets/k", ...over },
			],
		}),
	]).gate.classifiers[0];

describe("classifier settings", () => {
	test("defaults are filled in for a classifier", () => {
		const c = load([
			"--config",
			withGate({
				mode: "auto",
				classifiers: [classifier({ tokenFile: "/run/secrets/k" })],
			}),
		]);
		assert.strictEqual(c.gate.mode, "auto");
		assert.deepStrictEqual(c.gate.classifiers, [
			{
				name: "local",
				url: "http://127.0.0.1:9/c",
				tokenFile: "/run/secrets/k",
				dialect: "worker-mcp-v1",
				timeoutMs: 3000,
				minAllowConfidence: 0.85,
				minDenyConfidence: 0.6,
				maxArgumentBytes: 8192,
				sendIntent: true,
				breaker: { failures: 5, coolDownMs: 60_000 },
			},
		]);
	});

	test("a jev classifier: backend defaults, thresholds and rules", () => {
		const d = jev();
		assert.strictEqual(d.url, "https://api.typesafe.ai");
		assert.strictEqual(d.backend, "typesafe");
		assert.strictEqual(d.model, "jev-latest");
		assert.strictEqual(d.timeoutMs, 3000);
		assert.strictEqual(d.cacheTtlMs, undefined);
		assert.deepStrictEqual(d.jev, {
			denyScore: 2.5,
			askScore: 1.5,
			askProbability: 0.75,
			untrustedProbability: 0.7,
			userRequestedProbability: 0.85,
			thresholdMargin: 0.05,
		});
		const o = jev({ backend: "openrouter" });
		assert.strictEqual(o.url, "https://openrouter.ai/api");
		assert.strictEqual(o.model, "jev-1.13");
		const c = jev({
			url: "http://127.0.0.1:9",
			model: "m",
			cacheTtlMs: 5000,
			thresholds: { denyScore: 2 },
		});
		assert.strictEqual(c.backend, "custom");
		assert.strictEqual(c.url, "http://127.0.0.1:9");
		assert.strictEqual(c.model, "m");
		assert.strictEqual(c.cacheTtlMs, 5000);
		assert.strictEqual(c.jev?.denyScore, 2);
		for (const [over, pattern] of [
			[{ backend: "custom" }, /needs url/],
			[{ url: "https://example.com", backend: "typesafe" }, /backend custom/],
			[{ tokenFile: undefined }, /needs tokenFile/],
			[{ thresholds: { askScore: 3, denyScore: 2 } }, /askScore/],
			[{ thresholds: { denyScore: 4 } }, /denyScore/],
		] as const) {
			assert.match(
				failure(() => jev(over as any)),
				pattern,
			);
		}
		assert.match(
			failure(() =>
				load([
					"--config",
					withGate({
						classifiers: [classifier({ model: "x" })],
					}),
				]),
			),
			/model is for dialect jev/,
		);
	});

	test("auto mode needs a classifier; manual mode may list some", () => {
		assert.match(
			failure(() => load(["--config", withGate({ mode: "auto" })])),
			/gate\.mode is auto but gate\.classifiers is empty/,
		);
		assert.match(
			failure(() => load([], { ...env, WORKER_MCP_GATE_MODE: "auto" })),
			/gate\.classifiers is empty/,
		);
		assert.strictEqual(
			load(["--config", withGate({ classifiers: [classifier()] })]).gate.mode,
			"manual",
		);
	});

	test("invalid classifiers are rejected with the key", () => {
		for (const [what, gate, pattern] of [
			[
				"relative token file",
				{ classifiers: [classifier({ tokenFile: "k" })] },
				/absolute/,
			],
			["bad name", { classifiers: [classifier({ name: "a b" })] }, /name/],
			[
				"http elsewhere",
				{ classifiers: [classifier({ url: "http://example.com" })] },
				/https/,
			],
			[
				"unknown key",
				{ classifiers: [classifier({ token: "x" })] },
				/unknown key/,
			],
			[
				"confidence",
				{ classifiers: [classifier({ minAllowConfidence: 2 })] },
				/minAllowConfidence/,
			],
			[
				"duplicate",
				{ classifiers: [classifier(), classifier()] },
				/two classifiers named local/,
			],
			["ceiling", { httpAllowCeiling: "CRITICAL" }, /httpAllowCeiling/],
			[
				"failure mode allow",
				{ onClassifierFailure: "allow" },
				/onClassifierFailure/,
			],
		] as const) {
			assert.match(
				failure(() => load(["--config", withGate(gate)])),
				pattern,
				what,
			);
		}
	});

	test("env and flags set the simple choices; flags win", () => {
		const c = load(["--http-allow-ceiling", "medium"], {
			...env,
			WORKER_MCP_HTTP_ALLOW_CEILING: "low",
			WORKER_MCP_ON_CLASSIFIER_FAILURE: "deny",
			WORKER_MCP_AUDIT_FILE: path.join(root, "a.jsonl"),
		});
		assert.strictEqual(c.gate.httpAllowCeiling, "MEDIUM");
		assert.strictEqual(c.gate.onClassifierFailure, "deny");
		assert.strictEqual(c.audit.file, path.join(root, "a.jsonl"));
		assert.match(
			failure(() => load([], { ...env, WORKER_MCP_AUDIT: "maybe" })),
			/WORKER_MCP_AUDIT.*audit\.enabled/,
		);
		assert.match(
			failure(() => load([], { ...env, WORKER_MCP_AUDIT_FILE: "rel" })),
			/absolute/,
		);
	});

	test("the printed config shows the token file path and no secret", () => {
		const c = load([
			"--config",
			withGate({
				mode: "auto",
				classifiers: [classifier({ tokenFile: "/run/secrets/k" })],
			}),
		]);
		const printed = formatConfig(c);
		assert.match(printed, /"tokenFile": "\/run\/secrets\/k"/);
		assert.ok(!printed.includes("[redacted]"));
	});
});

const withFile = (body: unknown) => {
	const file = path.join(root, "c.json");
	fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
	return ["--config", file];
};

describe("sandbox config", () => {
	test("defaults: minimum none, no default pinned, no extra paths", () => {
		const c = load();
		assert.deepStrictEqual(c.sandbox, {
			minimum: "none",
			extraRo: [],
			extraRw: [],
			hide: [],
			toolIsolation: "auto",
		});
	});

	test("file, env and flag layer; extra paths accumulate in the file", () => {
		const args = withFile({
			sandbox: {
				minimum: "none",
				default: "workspace",
				extraRo: ["/opt/tools"],
				extraRw: ["/var/cache/x"],
				bwrapPath: "/usr/bin/bwrap",
			},
		});
		const c = load(args);
		assert.strictEqual(c.sandbox.default, "workspace");
		assert.deepStrictEqual(c.sandbox.extraRo, ["/opt/tools"]);
		assert.deepStrictEqual(c.sandbox.extraRw, ["/var/cache/x"]);
		assert.strictEqual(c.sandbox.bwrapPath, "/usr/bin/bwrap");
		const viaEnv = load(args, {
			...env,
			WORKER_MCP_SANDBOX_DEFAULT: "none",
			WORKER_MCP_SANDBOX_MINIMUM: "none",
		});
		assert.strictEqual(viaEnv.sandbox.default, "none");
		const viaFlag = load([...args, "--sandbox-minimum", "workspace"], {
			...env,
			WORKER_MCP_SANDBOX_MINIMUM: "none",
		});
		assert.strictEqual(viaFlag.sandbox.minimum, "workspace");
	});

	test("toolIsolation defaults to auto; file, env and flag set it", () => {
		assert.strictEqual(load([]).sandbox.toolIsolation, "auto");
		const args = withFile({ sandbox: { toolIsolation: "require" } });
		assert.strictEqual(load(args).sandbox.toolIsolation, "require");
		assert.strictEqual(
			load(args, { ...env, WORKER_MCP_SANDBOX_TOOL_ISOLATION: "off" }).sandbox
				.toolIsolation,
			"off",
		);
		assert.strictEqual(
			load([...args, "--sandbox-tool-isolation", "auto"]).sandbox.toolIsolation,
			"auto",
		);
		assert.throws(
			() => load(withFile({ sandbox: { toolIsolation: "maybe" } })),
			/toolIsolation/,
		);
	});

	test("WORKER_MCP_BWRAP is the fallback for bwrapPath; the file wins", () => {
		const e = { ...env, WORKER_MCP_BWRAP: "/nix/store/x-bubblewrap/bin/bwrap" };
		assert.strictEqual(
			load([], e).sandbox.bwrapPath,
			"/nix/store/x-bubblewrap/bin/bwrap",
		);
		assert.strictEqual(
			load(withFile({ sandbox: { bwrapPath: "/usr/bin/bwrap" } }), e).sandbox
				.bwrapPath,
			"/usr/bin/bwrap",
		);
	});

	test("invalid values name the key", () => {
		for (const bad of [
			{ minimum: "strict" },
			{ extraRo: ["relative/path"] },
			{ extraRw: ["/"] },
			{ hide: ["relative"] },
			{ hide: ["/"] },
			{ extraRw: ["/a/../etc"] },
			{ extraRo: [""] },
			{ unknown: true },
			{ bwrapPath: "" },
		]) {
			assert.throws(
				() => load(withFile({ sandbox: bad })),
				ConfigError,
				JSON.stringify(bad),
			);
		}
		assert.throws(
			() => load([], { ...env, WORKER_MCP_SANDBOX_MINIMUM: "full" }),
			/WORKER_MCP_SANDBOX_MINIMUM.*sandbox\.minimum/,
		);
	});

	test("a default below the minimum is refused", () => {
		assert.throws(
			() =>
				load(withFile({ sandbox: { minimum: "workspace", default: "none" } })),
			/sandbox\.default is none but sandbox\.minimum is workspace/,
		);
	});
});

describe("legacyTools (no longer used)", () => {
	test("nothing warns when it is not set", () => {
		assert.deepStrictEqual(loadConfig([], env).warnings, []);
	});

	test("a config file that sets it still loads, with one warning", () => {
		const file = writeFile({ legacyTools: false });
		const loaded = loadConfig(["--config", file], env);
		assert.strictEqual("legacyTools" in loaded.config, false);
		assert.strictEqual(loaded.warnings.length, 1);
		assert.match(loaded.warnings[0], /legacyTools.*no longer used/);
	});

	test("the environment variable is ignored, with one warning", () => {
		for (const value of ["0", "1", "maybe"]) {
			const loaded = loadConfig([], { ...env, WORKER_MCP_LEGACY_TOOLS: value });
			assert.strictEqual("legacyTools" in loaded.config, false);
			assert.strictEqual(loaded.warnings.length, 1);
			assert.match(
				loaded.warnings[0],
				/WORKER_MCP_LEGACY_TOOLS.*no longer used/,
			);
		}
	});

	test("both together still give one warning", () => {
		const file = writeFile({ legacyTools: true });
		const loaded = loadConfig(["--config", file], {
			...env,
			WORKER_MCP_LEGACY_TOOLS: "0",
		});
		assert.strictEqual(loaded.warnings.length, 1);
	});
});

describe("saved conversations", () => {
	test("are on by default, kept 3 days or 256 MiB", () => {
		const config = load();
		assert.strictEqual(config.persistSessions, true);
		assert.strictEqual(config.limits.sessionRetentionMs, 3 * 24 * 60 * 60_000);
		assert.strictEqual(config.limits.maxSessionBytes, 256 * 1024 * 1024);
	});

	test("the setting and the limits come from the file, the environment and flags", () => {
		const file = writeFile({
			persistSessions: false,
			limits: { sessionRetentionMs: 1000, maxSessionBytes: 7 },
		});
		const fromFile = load([`--config=${file}`]);
		assert.strictEqual(fromFile.persistSessions, false);
		assert.strictEqual(fromFile.limits.sessionRetentionMs, 1000);
		assert.strictEqual(fromFile.limits.maxSessionBytes, 7);

		const fromEnv = load([`--config=${file}`], {
			...env,
			WORKER_MCP_PERSIST_SESSIONS: "on",
			WORKER_MCP_SESSION_RETENTION_MS: "2000",
			WORKER_MCP_MAX_SESSION_BYTES: "8",
		});
		assert.strictEqual(fromEnv.persistSessions, true);
		assert.strictEqual(fromEnv.limits.sessionRetentionMs, 2000);
		assert.strictEqual(fromEnv.limits.maxSessionBytes, 8);

		const fromFlag = load(
			[
				"--persist-sessions=off",
				"--session-retention-ms",
				"3000",
				"--max-session-bytes=9",
			],
			{ ...env, WORKER_MCP_PERSIST_SESSIONS: "on" },
		);
		assert.strictEqual(fromFlag.persistSessions, false);
		assert.strictEqual(fromFlag.limits.sessionRetentionMs, 3000);
		assert.strictEqual(fromFlag.limits.maxSessionBytes, 9);
		assert.strictEqual(
			JSON.parse(formatConfig(fromFlag)).persistSessions,
			false,
		);
	});

	test("bad values fail and name their source", () => {
		assert.match(
			failure(() => load([], { ...env, WORKER_MCP_PERSIST_SESSIONS: "maybe" })),
			/WORKER_MCP_PERSIST_SESSIONS/,
		);
		for (const [name, bad] of [
			["WORKER_MCP_SESSION_RETENTION_MS", "0"],
			["WORKER_MCP_SESSION_RETENTION_MS", "-5"],
			["WORKER_MCP_SESSION_RETENTION_MS", String(366 * 24 * 60 * 60_000)],
			["WORKER_MCP_MAX_SESSION_BYTES", "0"],
			["WORKER_MCP_MAX_SESSION_BYTES", String(1024 ** 4 + 1)],
			["WORKER_MCP_MAX_SESSION_BYTES", "lots"],
		]) {
			assert.match(
				failure(() => load([], { ...env, [name]: bad })),
				new RegExp(name),
				`${name}=${bad}`,
			);
		}
		assert.throws(() => load(["--session-retention-ms", "0"]));
		assert.throws(() => load(["--max-session-bytes", "1.5"]));
		const file = writeFile({ limits: { maxSessionBytes: 1024 ** 4 + 1 } });
		assert.throws(() => load([`--config=${file}`]));
	});
});

describe("run records", () => {
	test("are on by default, kept 7 days or 500 runs", () => {
		const config = load();
		assert.strictEqual(config.persistRuns, true);
		assert.strictEqual(config.limits.recordRetentionMs, 7 * 24 * 60 * 60_000);
		assert.strictEqual(config.limits.maxRecordedRuns, 500);
	});

	test("persistRuns and the retention come from the file, the environment and flags", () => {
		const file = writeFile({
			persistRuns: false,
			limits: { recordRetentionMs: 1000, maxRecordedRuns: 7 },
		});
		const fromFile = load([`--config=${file}`]);
		assert.strictEqual(fromFile.persistRuns, false);
		assert.strictEqual(fromFile.limits.recordRetentionMs, 1000);
		assert.strictEqual(fromFile.limits.maxRecordedRuns, 7);

		const fromEnv = load([`--config=${file}`], {
			...env,
			WORKER_MCP_PERSIST_RUNS: "on",
			WORKER_MCP_RECORD_RETENTION_MS: "2000",
			WORKER_MCP_MAX_RECORDED_RUNS: "8",
		});
		assert.strictEqual(fromEnv.persistRuns, true);
		assert.strictEqual(fromEnv.limits.recordRetentionMs, 2000);
		assert.strictEqual(fromEnv.limits.maxRecordedRuns, 8);

		const fromFlag = load(
			[
				"--persist-runs=off",
				"--record-retention-ms",
				"3000",
				"--max-recorded-runs=9",
			],
			{ ...env, WORKER_MCP_PERSIST_RUNS: "on" },
		);
		assert.strictEqual(fromFlag.persistRuns, false);
		assert.strictEqual(fromFlag.limits.recordRetentionMs, 3000);
		assert.strictEqual(fromFlag.limits.maxRecordedRuns, 9);
		assert.strictEqual(JSON.parse(formatConfig(fromFlag)).persistRuns, false);
	});

	test("bad values fail and name their source", () => {
		assert.match(
			failure(() => load([], { ...env, WORKER_MCP_PERSIST_RUNS: "maybe" })),
			/WORKER_MCP_PERSIST_RUNS.*persistRuns/,
		);
		assert.match(
			failure(() => load(["--persist-runs", "2"])),
			/--persist-runs/,
		);
		assert.match(
			failure(() => load([], { ...env, WORKER_MCP_MAX_RECORDED_RUNS: "0" })),
			/WORKER_MCP_MAX_RECORDED_RUNS.*limits\.maxRecordedRuns/,
		);
	});
});

describe("resume context cap", () => {
	test("defaults to 150000 and comes from the file, the environment and flags", () => {
		assert.strictEqual(load().resume.maxContextTokens, 150_000);
		const file = writeFile({ resume: { maxContextTokens: 1000 } });
		assert.strictEqual(
			load([`--config=${file}`]).resume.maxContextTokens,
			1000,
		);
		const fromEnv = load([`--config=${file}`], {
			...env,
			WORKER_MCP_RESUME_MAX_CONTEXT_TOKENS: "2000",
		});
		assert.strictEqual(fromEnv.resume.maxContextTokens, 2000);
		const fromFlag = load(["--resume-max-context-tokens=3000"], {
			...env,
			WORKER_MCP_RESUME_MAX_CONTEXT_TOKENS: "2000",
		});
		assert.strictEqual(fromFlag.resume.maxContextTokens, 3000);
		assert.strictEqual(
			JSON.parse(formatConfig(fromFlag)).resume.maxContextTokens,
			3000,
		);
	});

	test("bad values fail and name their source", () => {
		for (const bad of ["0", "-1", "many", String(100_000_001)]) {
			assert.match(
				failure(() =>
					load([], { ...env, WORKER_MCP_RESUME_MAX_CONTEXT_TOKENS: bad }),
				),
				/WORKER_MCP_RESUME_MAX_CONTEXT_TOKENS/,
				bad,
			);
		}
		assert.throws(() => load(["--resume-max-context-tokens", "0"]));
		const file = writeFile({ resume: { maxContextTokens: 0 } });
		assert.throws(() => load([`--config=${file}`]));
	});
});

describe("providers.pi.skills", () => {
	test("is on by default and can be turned off in the file", () => {
		assert.strictEqual(load([]).providers.pi.skills, true);
		const off = writeFile({ providers: { pi: { skills: false } } });
		assert.strictEqual(load(["--config", off]).providers.pi.skills, false);
		const bad = writeFile({ providers: { pi: { skills: "no" } } });
		assert.throws(() => load(["--config", bad]), /skills/);
	});
});

describe("usage.reportCost", () => {
	test("is on by default and can be turned off in the file", () => {
		assert.strictEqual(load([]).usage.reportCost, true);
		const file = path.join(root, "usage.json");
		fs.writeFileSync(file, JSON.stringify({ usage: { reportCost: false } }), {
			mode: 0o600,
		});
		assert.strictEqual(load([`--config=${file}`]).usage.reportCost, false);
	});
});
