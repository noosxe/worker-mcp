import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { z } from "zod";

/**
 * The server's configuration. One `Config` is built at startup from, lowest to
 * highest precedence: built-in defaults, a JSON config file, `WORKER_MCP_*`
 * environment variables and command-line flags. It is validated as a whole and
 * passed down explicitly: nothing else reads `process.env` for settings.
 */
export interface Config {
	/** Where the server keeps state (reserved; nothing is written there yet). */
	stateDir: string;
	/** Directory holding the per-instance private runtime directory. */
	runtimeDir: string;
	limits: {
		/** Default blocking-call timeout in ms; null waits for the command. */
		commandTimeoutMs: number | null;
		/** Output size, in characters, past which a worker's output is cut off. */
		maxOutputChars: number;
		/** Wall-clock limit for one run; on expiry it is aborted and times out. */
		maxRunMs: number;
		/** Longest any single wait (`wait_run`, `start_run`'s `waitMs`) blocks. */
		maxWaitMs: number;
		/** The wait `wait_run` uses when the caller gives none. */
		defaultWaitMs: number;
		/** How long a finished run is kept after its worker is gone. */
		resultRetentionMs: number;
		/** Most finished runs kept at once, oldest dropped first. */
		maxRetainedRuns: number;
		/** Output kept per run, in characters; the oldest is dropped past it. */
		outputBufferChars: number;
		/** Default size of one page of output returned by `get_run`. */
		pageChars: number;
		/** How long a worker may take to accept a prompt before the run fails. */
		runStartTimeoutMs: number;
	};
	env: {
		/** Extra worker env names or `PREFIX_*` patterns, from every source. */
		allow: string[];
		/**
		 * Exact names listed in the config file's `env.allow`. Only these may
		 * pass although they match a force-drop pattern.
		 */
		forceDropExempt: string[];
	};
	providers: {
		pi: {
			path: string;
			/** How long a spawn waits for pi to confirm its approval gate. */
			startupTimeoutMs: number;
		};
	};
	gate: {
		/**
		 * Ceiling on what a coordinator-supplied policy may auto-approve. Policies
		 * from `spawn` and `set_risk_policy` are lowered to it. Never CRITICAL.
		 */
		maxAutoApprove: "LOW" | "MEDIUM" | "HIGH";
		/** Extra paths (absolute, or `~/`) workers may never write unasked. */
		protectedPaths: string[];
		/** How long an approval waits for the coordinator before it is denied. */
		approvalTimeoutMs: number;
	};
}

export const DEFAULT_MAX_OUTPUT_CHARS = 64000;
export const DEFAULT_MAX_RUN_MS = 30 * 60_000;
/** Under the 60 s default request timeout of the TypeScript MCP client. */
export const DEFAULT_MAX_WAIT_MS = 50_000;
export const DEFAULT_WAIT_MS = 25_000;
export const DEFAULT_RESULT_RETENTION_MS = 60 * 60_000;
export const DEFAULT_MAX_RETAINED_RUNS = 100;
export const DEFAULT_OUTPUT_BUFFER_CHARS = 1_048_576;
export const DEFAULT_PAGE_CHARS = 16_000;
export const DEFAULT_RUN_START_TIMEOUT_MS = 15_000;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;

/** An npx-wrapped pi can take most of a minute to start the first time. */
export const DEFAULT_PI_STARTUP_TIMEOUT_MS = 60_000;

/** Raised for every invalid setting; the message names the source and key. */
export class ConfigError extends Error {
	override name = "ConfigError";
}

// ---- schema -----------------------------------------------------------------

const positiveInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const absolutePath = z
	.string()
	.min(1)
	.refine((p) => path.isAbsolute(p), "must be an absolute path");
const envName = z
	.string()
	.regex(
		/^[A-Za-z0-9_*]+$/,
		"must be a variable name or a PREFIX_* pattern (letters, digits, '_' and '*')",
	);

const maxAutoApprove = z.enum(["LOW", "MEDIUM", "HIGH"]);
const protectedPath = z
	.string()
	.min(1)
	.refine(
		(p) => path.isAbsolute(p) || p.startsWith("~/"),
		"must be an absolute path or start with ~/",
	);

/** The JSON file: every key optional, unknown keys rejected. */
export const configFileSchema = z.strictObject({
	stateDir: absolutePath.optional(),
	runtimeDir: absolutePath.optional(),
	limits: z
		.strictObject({
			commandTimeoutMs: positiveInt.optional(),
			maxOutputChars: positiveInt.optional(),
			maxRunMs: positiveInt.optional(),
			maxWaitMs: positiveInt.optional(),
			defaultWaitMs: positiveInt.optional(),
			resultRetentionMs: positiveInt.optional(),
			maxRetainedRuns: positiveInt.optional(),
			outputBufferChars: positiveInt.optional(),
			pageChars: positiveInt.optional(),
			runStartTimeoutMs: positiveInt.optional(),
		})
		.optional(),
	env: z.strictObject({ allow: z.array(envName).optional() }).optional(),
	providers: z
		.strictObject({
			pi: z
				.strictObject({
					path: z.string().min(1).optional(),
					startupTimeoutMs: positiveInt.optional(),
				})
				.optional(),
		})
		.optional(),
	gate: z
		.strictObject({
			maxAutoApprove: maxAutoApprove.optional(),
			protectedPaths: z.array(protectedPath).optional(),
			approvalTimeoutMs: positiveInt.optional(),
		})
		.optional(),
});

type FileLayer = z.infer<typeof configFileSchema>;

function formatIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const where = issue.path.join(".");
			if (issue.code === "unrecognized_keys") {
				const keys = issue.keys.map((k) => [...issue.path, k].join("."));
				return `unknown key${keys.length > 1 ? "s" : ""} ${keys.join(", ")}`;
			}
			return `${where || "<root>"}: ${issue.message}`;
		})
		.join("; ");
}

// ---- sources ----------------------------------------------------------------

interface EnvVar {
	name: string;
	key: string;
}

/** Every environment variable the server understands. */
export const ENV_VARS = {
	config: { name: "WORKER_MCP_CONFIG", key: "config file path" },
	piPath: { name: "WORKER_MCP_PI_PATH", key: "providers.pi.path" },
	piStartupTimeout: {
		name: "WORKER_MCP_PI_STARTUP_TIMEOUT_MS",
		key: "providers.pi.startupTimeoutMs",
	},
	commandTimeout: {
		name: "WORKER_MCP_COMMAND_TIMEOUT",
		key: "limits.commandTimeoutMs",
	},
	maxOutputChars: {
		name: "WORKER_MCP_MAX_OUTPUT_CHARS",
		key: "limits.maxOutputChars",
	},
	runTimeout: { name: "WORKER_MCP_RUN_TIMEOUT_MS", key: "limits.maxRunMs" },
	maxWait: { name: "WORKER_MCP_MAX_WAIT_MS", key: "limits.maxWaitMs" },
	runStartTimeout: {
		name: "WORKER_MCP_RUN_START_TIMEOUT_MS",
		key: "limits.runStartTimeoutMs",
	},
	approvalTimeout: {
		name: "WORKER_MCP_APPROVAL_TIMEOUT_MS",
		key: "gate.approvalTimeoutMs",
	},
	envPassthrough: { name: "WORKER_MCP_ENV_PASSTHROUGH", key: "env.allow" },
	stateDir: { name: "WORKER_MCP_STATE_DIR", key: "stateDir" },
	runtimeDir: { name: "WORKER_MCP_RUNTIME_DIR", key: "runtimeDir" },
	maxAutoApprove: {
		name: "WORKER_MCP_MAX_AUTO_APPROVE",
		key: "gate.maxAutoApprove",
	},
} as const satisfies Record<string, EnvVar>;

interface FlagDef {
	flag: string;
	key: string;
	kind: "string" | "int" | "list";
}

const VALUE_FLAGS = {
	config: { flag: "--config", key: "config file path", kind: "string" },
	piPath: { flag: "--pi-path", key: "providers.pi.path", kind: "string" },
	piStartupTimeout: {
		flag: "--pi-startup-timeout-ms",
		key: "providers.pi.startupTimeoutMs",
		kind: "int",
	},
	commandTimeout: {
		flag: "--command-timeout-ms",
		key: "limits.commandTimeoutMs",
		kind: "int",
	},
	maxOutputChars: {
		flag: "--max-output-chars",
		key: "limits.maxOutputChars",
		kind: "int",
	},
	runTimeout: {
		flag: "--run-timeout-ms",
		key: "limits.maxRunMs",
		kind: "int",
	},
	maxWait: { flag: "--max-wait-ms", key: "limits.maxWaitMs", kind: "int" },
	runStartTimeout: {
		flag: "--run-start-timeout-ms",
		key: "limits.runStartTimeoutMs",
		kind: "int",
	},
	approvalTimeout: {
		flag: "--approval-timeout-ms",
		key: "gate.approvalTimeoutMs",
		kind: "int",
	},
	envPassthrough: {
		flag: "--env-passthrough",
		key: "env.allow",
		kind: "list",
	},
	stateDir: { flag: "--state-dir", key: "stateDir", kind: "string" },
	runtimeDir: { flag: "--runtime-dir", key: "runtimeDir", kind: "string" },
	maxAutoApprove: {
		flag: "--max-auto-approve",
		key: "gate.maxAutoApprove",
		kind: "string",
	},
} as const satisfies Record<string, FlagDef>;

export interface CliFlags {
	help: boolean;
	version: boolean;
	printConfig: boolean;
	values: Partial<Record<keyof typeof VALUE_FLAGS, string>>;
}

/** Parse argv (without the node and script entries). Unknown flags fail. */
export function parseArgs(argv: readonly string[]): CliFlags {
	const flags: CliFlags = {
		help: false,
		version: false,
		printConfig: false,
		values: {},
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") flags.help = true;
		else if (arg === "--version" || arg === "-v") flags.version = true;
		else if (arg === "--print-config") flags.printConfig = true;
		else {
			const eq = arg.indexOf("=");
			const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
			const entry = Object.entries(VALUE_FLAGS).find(
				([, def]) => def.flag === name,
			);
			if (!entry) {
				throw new ConfigError(`Invalid command line: unknown flag ${arg}`);
			}
			let value: string | undefined;
			if (name !== arg) value = arg.slice(eq + 1);
			else value = argv[++i];
			if (value === undefined || value === "") {
				throw new ConfigError(`Invalid command line: ${name} needs a value`);
			}
			flags.values[entry[0] as keyof typeof VALUE_FLAGS] = value;
		}
	}
	return flags;
}

function parseInteger(source: string, key: string, raw: string): number {
	const text = raw.trim();
	const value = Number(text);
	if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value <= 0) {
		throw new ConfigError(
			`Invalid config (${source}) ${key}: ${JSON.stringify(raw)} is not a positive integer`,
		);
	}
	return value;
}

/** A layer from strings (env or flags): same schema, with a source label. */
function stringLayer(
	source: string,
	values: {
		piPath?: string;
		piStartupTimeout?: { key: string; raw: string };
		commandTimeout?: { key: string; raw: string };
		maxOutputChars?: { key: string; raw: string };
		runTimeout?: { key: string; raw: string };
		maxWait?: { key: string; raw: string };
		runStartTimeout?: { key: string; raw: string };
		approvalTimeout?: { key: string; raw: string };
		passthrough?: { key: string; raw: string };
		stateDir?: string;
		runtimeDir?: string;
		maxAutoApprove?: string;
	},
	keys: { piPath: string; stateDir: string; runtimeDir: string },
): FileLayer {
	const layer: FileLayer = {};
	const check = <T>(key: string, schema: z.ZodType<T>, value: unknown): T => {
		const result = schema.safeParse(value);
		if (!result.success) {
			throw new ConfigError(
				`Invalid config (${source}) ${key}: ${result.error.issues.map((i) => i.message).join("; ")}`,
			);
		}
		return result.data;
	};
	if (values.stateDir !== undefined) {
		layer.stateDir = check(keys.stateDir, absolutePath, values.stateDir);
	}
	if (values.runtimeDir !== undefined) {
		layer.runtimeDir = check(keys.runtimeDir, absolutePath, values.runtimeDir);
	}
	if (values.piPath !== undefined) {
		layer.providers = { pi: { path: values.piPath } };
	}
	if (values.piStartupTimeout) {
		layer.providers = {
			pi: {
				...layer.providers?.pi,
				startupTimeoutMs: parseInteger(
					source,
					values.piStartupTimeout.key,
					values.piStartupTimeout.raw,
				),
			},
		};
	}
	if (values.maxAutoApprove !== undefined) {
		layer.gate = {
			maxAutoApprove: check(
				ENV_VARS.maxAutoApprove.key,
				maxAutoApprove,
				values.maxAutoApprove.toUpperCase(),
			),
		};
	}
	if (values.approvalTimeout) {
		layer.gate = {
			...layer.gate,
			approvalTimeoutMs: parseInteger(
				source,
				values.approvalTimeout.key,
				values.approvalTimeout.raw,
			),
		};
	}
	for (const [name, field] of [
		["runTimeout", "maxRunMs"],
		["maxWait", "maxWaitMs"],
		["runStartTimeout", "runStartTimeoutMs"],
	] as const) {
		const entry = values[name];
		if (!entry) continue;
		layer.limits = {
			...layer.limits,
			[field]: parseInteger(source, entry.key, entry.raw),
		};
	}
	if (values.commandTimeout || values.maxOutputChars) {
		layer.limits = { ...layer.limits };
		if (values.commandTimeout) {
			layer.limits.commandTimeoutMs = parseInteger(
				source,
				values.commandTimeout.key,
				values.commandTimeout.raw,
			);
		}
		if (values.maxOutputChars) {
			layer.limits.maxOutputChars = parseInteger(
				source,
				values.maxOutputChars.key,
				values.maxOutputChars.raw,
			);
		}
	}
	if (values.passthrough) {
		const names = values.passthrough.raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		layer.env = {
			allow: check(values.passthrough.key, z.array(envName), names),
		};
	}
	return layer;
}

const label = (v: EnvVar) => `env ${v.name}`;

function envLayer(env: NodeJS.ProcessEnv): FileLayer {
	const get = (v: EnvVar) => {
		const raw = env[v.name];
		return raw === undefined || raw.trim() === "" ? undefined : raw;
	};
	const num = (v: EnvVar) => {
		const raw = get(v);
		return raw === undefined ? undefined : { key: v.key, raw };
	};
	// One call per variable so the error names the variable that was bad.
	const parts: FileLayer[] = [
		stringLayer(
			label(ENV_VARS.piPath),
			{ piPath: get(ENV_VARS.piPath) },
			keysOf(),
		),
		stringLayer(
			label(ENV_VARS.piStartupTimeout),
			{ piStartupTimeout: num(ENV_VARS.piStartupTimeout) },
			keysOf(),
		),
		stringLayer(
			label(ENV_VARS.commandTimeout),
			{ commandTimeout: num(ENV_VARS.commandTimeout) },
			keysOf(),
		),
		stringLayer(
			label(ENV_VARS.maxOutputChars),
			{ maxOutputChars: num(ENV_VARS.maxOutputChars) },
			keysOf(),
		),
		stringLayer(
			label(ENV_VARS.runTimeout),
			{ runTimeout: num(ENV_VARS.runTimeout) },
			keysOf(),
		),
		stringLayer(
			label(ENV_VARS.maxWait),
			{ maxWait: num(ENV_VARS.maxWait) },
			keysOf(),
		),
		stringLayer(
			label(ENV_VARS.runStartTimeout),
			{ runStartTimeout: num(ENV_VARS.runStartTimeout) },
			keysOf(),
		),
		stringLayer(
			label(ENV_VARS.approvalTimeout),
			{ approvalTimeout: num(ENV_VARS.approvalTimeout) },
			keysOf(),
		),
		stringLayer(
			label(ENV_VARS.envPassthrough),
			{ passthrough: num(ENV_VARS.envPassthrough) },
			keysOf(),
		),
		stringLayer(
			label(ENV_VARS.stateDir),
			{ stateDir: get(ENV_VARS.stateDir) },
			keysOf(),
		),
		stringLayer(
			label(ENV_VARS.runtimeDir),
			{ runtimeDir: get(ENV_VARS.runtimeDir) },
			keysOf(),
		),
		stringLayer(
			label(ENV_VARS.maxAutoApprove),
			{ maxAutoApprove: get(ENV_VARS.maxAutoApprove) },
			keysOf(),
		),
	];
	return parts.reduce<FileLayer>(mergeLayers, {});
}

function keysOf() {
	return {
		piPath: ENV_VARS.piPath.key,
		stateDir: ENV_VARS.stateDir.key,
		runtimeDir: ENV_VARS.runtimeDir.key,
	};
}

function flagLayer(flags: CliFlags): FileLayer {
	const parts: FileLayer[] = [];
	for (const [name, raw] of Object.entries(flags.values)) {
		const def = VALUE_FLAGS[name as keyof typeof VALUE_FLAGS];
		const source = `flag ${def.flag}`;
		const keys = {
			piPath: VALUE_FLAGS.piPath.key,
			stateDir: VALUE_FLAGS.stateDir.key,
			runtimeDir: VALUE_FLAGS.runtimeDir.key,
		};
		const entry = { key: def.key, raw };
		switch (name) {
			case "piPath":
				parts.push(stringLayer(source, { piPath: raw }, keys));
				break;
			case "piStartupTimeout":
				parts.push(stringLayer(source, { piStartupTimeout: entry }, keys));
				break;
			case "commandTimeout":
				parts.push(stringLayer(source, { commandTimeout: entry }, keys));
				break;
			case "maxOutputChars":
				parts.push(stringLayer(source, { maxOutputChars: entry }, keys));
				break;
			case "runTimeout":
			case "maxWait":
			case "runStartTimeout":
			case "approvalTimeout":
				parts.push(stringLayer(source, { [name]: entry }, keys));
				break;
			case "envPassthrough":
				parts.push(stringLayer(source, { passthrough: entry }, keys));
				break;
			case "stateDir":
				parts.push(stringLayer(source, { stateDir: raw }, keys));
				break;
			case "runtimeDir":
				parts.push(stringLayer(source, { runtimeDir: raw }, keys));
				break;
			case "maxAutoApprove":
				parts.push(stringLayer(source, { maxAutoApprove: raw }, keys));
				break;
			default:
				break; // --config is handled when locating the file
		}
	}
	return parts.reduce<FileLayer>(mergeLayers, {});
}

/** `over` wins for scalars; `env.allow` accumulates across layers. */
function mergeLayers(base: FileLayer, over: FileLayer): FileLayer {
	const allow = [...(base.env?.allow ?? []), ...(over.env?.allow ?? [])];
	return {
		stateDir: over.stateDir ?? base.stateDir,
		runtimeDir: over.runtimeDir ?? base.runtimeDir,
		limits: { ...base.limits, ...over.limits },
		env: { allow },
		providers: {
			pi: {
				path: over.providers?.pi?.path ?? base.providers?.pi?.path,
				startupTimeoutMs:
					over.providers?.pi?.startupTimeoutMs ??
					base.providers?.pi?.startupTimeoutMs,
			},
		},
		gate: {
			maxAutoApprove: over.gate?.maxAutoApprove ?? base.gate?.maxAutoApprove,
			approvalTimeoutMs:
				over.gate?.approvalTimeoutMs ?? base.gate?.approvalTimeoutMs,
			// Protected paths only ever accumulate.
			protectedPaths: [
				...(base.gate?.protectedPaths ?? []),
				...(over.gate?.protectedPaths ?? []),
			],
		},
	};
}

/**
 * Why a config file must not be trusted, or null. Like OpenSSH: owned by the
 * current user or by root, not group- or world-writable, and not in a
 * directory others can write to (a root-owned sticky directory is fine).
 * A file in the Nix store (`inStore`) only has to be not writable by others.
 * `uid` is the current user, or null where there is no such notion.
 */
export function configFileProblem(
	file: { mode: number; uid: number },
	dir: { mode: number; uid: number },
	uid: number | null,
	inStore = false,
): string | null {
	// The Nix store is immutable, and inside a user namespace its files show up
	// owned by the overflow uid, so only the file's own mode is judged there.
	if (inStore) {
		return (file.mode & 0o022) !== 0
			? "refusing a file that is group- or world-writable"
			: null;
	}
	if (uid !== null && file.uid !== uid && file.uid !== 0) {
		return "refusing a file that is not owned by you or root";
	}
	if ((file.mode & 0o022) !== 0) {
		return "refusing a file that is group- or world-writable (run chmod go-w on it)";
	}
	const sticky = (dir.mode & 0o1000) !== 0;
	if ((dir.mode & 0o022) !== 0 && !(dir.uid === 0 && sticky)) {
		return "refusing a file in a directory that is group- or world-writable";
	}
	return null;
}

function readConfigFile(file: string, env: NodeJS.ProcessEnv): FileLayer {
	const where = `file ${file}`;
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch (e) {
		throw new ConfigError(
			`Invalid config (${where}): cannot read it (${(e as NodeJS.ErrnoException).code ?? String(e)})`,
		);
	}
	if (!stat.isFile()) {
		throw new ConfigError(`Invalid config (${where}): not a regular file`);
	}
	const uid = typeof process.getuid === "function" ? process.getuid() : null;
	let parent: { mode: number; uid: number };
	let inStore = false;
	try {
		// The directory of the resolved target, so a symlink is judged by where
		// it leads (a Nix-managed file is a symlink into the store).
		const real = fs.realpathSync(file);
		const store = path.resolve(env.NIX_STORE_DIR || "/nix/store");
		inStore = real.startsWith(store + path.sep);
		parent = fs.statSync(path.dirname(real));
	} catch (e) {
		throw new ConfigError(
			`Invalid config (${where}): cannot check its directory (${(e as NodeJS.ErrnoException).code ?? String(e)})`,
		);
	}
	const problem = configFileProblem(stat, parent, uid, inStore);
	if (problem) throw new ConfigError(`Invalid config (${where}): ${problem}`);
	let json: unknown;
	try {
		json = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		throw new ConfigError(
			`Invalid config (${where}): not valid JSON (${e instanceof Error ? e.message : String(e)})`,
		);
	}
	const result = configFileSchema.safeParse(json);
	if (!result.success) {
		throw new ConfigError(
			`Invalid config (${where}): ${formatIssues(result.error)}`,
		);
	}
	return result.data;
}

// ---- build ------------------------------------------------------------------

function homeOf(env: NodeJS.ProcessEnv): string {
	return env.HOME || os.homedir();
}

/** Default config file: `$XDG_CONFIG_HOME/worker-mcp/config.json`. */
export function defaultConfigFile(env: NodeJS.ProcessEnv): string {
	const base = env.XDG_CONFIG_HOME || path.join(homeOf(env), ".config");
	return path.join(base, "worker-mcp", "config.json");
}

function applyDefaults(
	layer: FileLayer,
	env: NodeJS.ProcessEnv,
	exempt: string[],
): Config {
	const stateBase =
		env.XDG_STATE_HOME || path.join(homeOf(env), ".local", "state");
	const stateDir = layer.stateDir ?? path.join(stateBase, "worker-mcp");
	return {
		stateDir,
		runtimeDir:
			layer.runtimeDir ??
			(env.XDG_RUNTIME_DIR ? env.XDG_RUNTIME_DIR : path.join(stateDir, "run")),
		limits: {
			commandTimeoutMs: layer.limits?.commandTimeoutMs ?? null,
			maxOutputChars: layer.limits?.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
			maxRunMs: layer.limits?.maxRunMs ?? DEFAULT_MAX_RUN_MS,
			maxWaitMs: layer.limits?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
			defaultWaitMs: Math.min(
				layer.limits?.defaultWaitMs ?? DEFAULT_WAIT_MS,
				layer.limits?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
			),
			resultRetentionMs:
				layer.limits?.resultRetentionMs ?? DEFAULT_RESULT_RETENTION_MS,
			maxRetainedRuns:
				layer.limits?.maxRetainedRuns ?? DEFAULT_MAX_RETAINED_RUNS,
			outputBufferChars:
				layer.limits?.outputBufferChars ?? DEFAULT_OUTPUT_BUFFER_CHARS,
			pageChars: layer.limits?.pageChars ?? DEFAULT_PAGE_CHARS,
			runStartTimeoutMs:
				layer.limits?.runStartTimeoutMs ?? DEFAULT_RUN_START_TIMEOUT_MS,
		},
		env: {
			allow: [...new Set(layer.env?.allow ?? [])],
			forceDropExempt: exempt,
		},
		providers: {
			pi: {
				path: layer.providers?.pi?.path || "pi",
				startupTimeoutMs:
					layer.providers?.pi?.startupTimeoutMs ??
					DEFAULT_PI_STARTUP_TIMEOUT_MS,
			},
		},
		gate: {
			maxAutoApprove: layer.gate?.maxAutoApprove ?? "MEDIUM",
			protectedPaths: [...new Set(layer.gate?.protectedPaths ?? [])],
			approvalTimeoutMs:
				layer.gate?.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
		},
	};
}

export interface LoadedConfig {
	config: Config;
	/** The config file that was read, or null when there was none. */
	configFile: string | null;
	flags: CliFlags;
}

/**
 * Build the effective config. Throws a `ConfigError` naming the source and key
 * of the first invalid setting. `env` is only used here; it is never consulted
 * again after this returns.
 */
export function loadConfig(
	argv: readonly string[],
	env: NodeJS.ProcessEnv,
): LoadedConfig {
	const flags = parseArgs(argv);

	let explicit: string | undefined = flags.values.config;
	if (explicit === undefined) {
		const fromEnv = env[ENV_VARS.config.name];
		if (fromEnv !== undefined && fromEnv.trim() !== "") explicit = fromEnv;
	}
	let configFile: string | null = null;
	let fileLayer: FileLayer = {};
	if (explicit !== undefined) {
		configFile = path.resolve(explicit);
		fileLayer = readConfigFile(configFile, env);
	} else {
		const candidate = defaultConfigFile(env);
		if (fs.existsSync(candidate)) {
			configFile = candidate;
			fileLayer = readConfigFile(candidate, env);
		}
	}

	const exempt = (fileLayer.env?.allow ?? []).filter((n) => !n.includes("*"));
	const merged = [fileLayer, envLayer(env), flagLayer(flags)].reduce(
		mergeLayers,
		{},
	);
	return { config: applyDefaults(merged, env, exempt), configFile, flags };
}

/** The config with nothing set: for tests and library use. */
export function defaultConfig(env: NodeJS.ProcessEnv = {}): Config {
	return applyDefaults({}, env, []);
}

// ---- print ------------------------------------------------------------------

const SECRET_KEY = /token|secret|password|passwd|credential|api[_-]?key/i;

/** Deep copy with the value of every secret-looking key replaced. */
export function redactConfig<T>(value: T): T {
	if (Array.isArray(value)) return value.map((v) => redactConfig(v)) as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = SECRET_KEY.test(k) && v != null ? "[redacted]" : redactConfig(v);
		}
		return out as T;
	}
	return value;
}

/** What `--print-config` prints. */
export function formatConfig(config: Config): string {
	return `${JSON.stringify(redactConfig(config), null, 2)}\n`;
}
