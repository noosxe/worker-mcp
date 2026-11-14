import assert from "node:assert";
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
import { buildWorkerEnv } from "../session/launch.js";

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

describe("defaults", () => {
	test("need no file and no environment", () => {
		const config = load();
		assert.strictEqual(config.providers.pi.path, "pi");
		assert.strictEqual(config.limits.commandTimeoutMs, null);
		assert.strictEqual(config.limits.maxOutputChars, 64000);
		assert.deepStrictEqual(config.env, { allow: [], forceDropExempt: [] });
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
