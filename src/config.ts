import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { z } from "zod";

import { classifierUrlProblem } from "./gate/http-classifier.js";

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
		/** No longer used (it was the default wait of the removed blocking tool); kept so existing configs load. */
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
		/** Most workers alive at once; a spawn past it fails with LIMIT_REACHED. */
		maxWorkers: number;
		/** A worker with no run for this long is closed; its runs stay readable. */
		idleTimeoutMs: number;
		/**
		 * When not empty, a worker's `cwd` must lie inside one of these
		 * directories (absolute; compared by real path).
		 */
		allowedRoots: string[];
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
			/**
			 * Model for workers spawned without `model`, as `<provider>/<model>`.
			 * An explicit `model` always wins.
			 */
			defaultModel?: string;
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
		/**
		 * `manual`: the rules, then the coordinator. `auto`: calls the rules
		 * escalate go to the classifiers first, and only uncertain ones reach the
		 * coordinator. `auto` needs at least one classifier.
		 */
		mode: "manual" | "auto";
		/**
		 * Highest risk level a classifier may allow. Separate from
		 * `maxAutoApprove`, which bounds the coordinator's policy. Never CRITICAL.
		 */
		httpAllowCeiling: "LOW" | "MEDIUM" | "HIGH";
		/** What a classifier that cannot answer means. There is no `allow`. */
		onClassifierFailure: "escalate" | "deny";
		/** Consulted in order; the first decisive verdict wins. */
		classifiers: HttpClassifierConfig[];
		/** The cache of classifier verdicts. */
		cache: { maxEntries: number; maxTtlMs: number };
		/** How many recent decisions are summarised for a classifier. */
		recentActions: number;
	};
	audit: {
		enabled: boolean;
		/** The JSONL file; `<stateDir>/audit.jsonl` unless set. */
		file: string;
	};
	/** Linux only: bubblewrap. macOS has no sandbox, so `minimum` must stay `none`. */
	sandbox: {
		/** The least a worker may run with; a spawn cannot ask for less. */
		minimum: SandboxMode;
		/**
		 * What a spawn gets when it names none. Unset: `workspace` when the
		 * sandbox is available, else `none`.
		 */
		default?: SandboxMode;
		/** Extra read-only paths (absolute) mounted into the sandbox. */
		extraRo: string[];
		/** Extra read-write paths (absolute) mounted into the sandbox. */
		extraRw: string[];
		/**
		 * Absolute paths always hidden behind an empty tmpfs, for other ways to
		 * the home directory's data that detection misses.
		 */
		hide: string[];
		/** The bwrap binary. Unset: `WORKER_MCP_BWRAP`, else `bwrap` on PATH. */
		bwrapPath?: string;
	};
}

export type SandboxMode = "none" | "workspace";

export interface HttpClassifierConfig {
	/** Names the classifier in the gate log as `http:<name>`. */
	name: string;
	/**
	 * https, or http only for localhost, 127.0.0.1 and [::1]. For dialect
	 * `jev` it is the server's base URL: `/v1/systemone` is appended.
	 */
	url: string;
	/**
	 * A file holding the bearer token. Mode 0600 or stricter, owned by the
	 * user running the server; a symlink is judged by its target. Read at
	 * startup and again on SIGHUP. The token itself is never configured.
	 */
	tokenFile?: string;
	/**
	 * The wire format: `worker-mcp-v1` is the provisional API, `jev` is
	 * TypeSafe's System One API.
	 */
	dialect: "worker-mcp-v1" | "jev";
	/** Dialect `jev`: where `url` comes from. `custom` is any compatible server. */
	backend?: JevBackend;
	/** Dialect `jev`: the System One model. */
	model?: string;
	/** Dialect `jev`: how the answers map to a verdict. */
	jev?: JevThresholds;
	/**
	 * How long a decisive verdict is reused for the same call of the same
	 * worker. For dialects whose answer carries no TTL (`jev`); unset: off.
	 */
	cacheTtlMs?: number;
	timeoutMs: number;
	minAllowConfidence: number;
	minDenyConfidence: number;
	maxArgumentBytes: number;
	sendIntent: boolean;
	breaker: { failures: number; coolDownMs: number };
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
export const DEFAULT_MAX_WORKERS = 4;
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 3000;

export type JevBackend = "typesafe" | "openrouter" | "custom";
export const JEV_BACKENDS: Record<
	Exclude<JevBackend, "custom">,
	{ url: string; model: string }
> = {
	typesafe: { url: "https://api.typesafe.ai", model: "jev-latest" },
	openrouter: { url: "https://openrouter.ai/api", model: "jev-1.13" },
};
/** Model for `custom` servers, which have no default URL of their own. */
export const JEV_CUSTOM_MODEL = "jev-latest";

/** How a System One answer becomes a verdict; see docs/classifier-api.md. */
export interface JevThresholds {
	/** `risk` (0-3) at or above this: deny. */
	denyScore: number;
	/** `risk` at or above this makes a call risky. */
	askScore: number;
	/** `approval` at or above this makes a call risky. */
	askProbability: number;
	/** `from_untrusted` at or above this: deny. */
	untrustedProbability: number;
	/** `user_requested` at or above this lets a risky call through. */
	userRequestedProbability: number;
	/**
	 * An allow is refused when a probability or score it rests on is within
	 * this distance of its threshold.
	 */
	thresholdMargin: number;
}
export const DEFAULT_JEV_THRESHOLDS: JevThresholds = {
	denyScore: 2.5,
	askScore: 1.5,
	askProbability: 0.75,
	untrustedProbability: 0.7,
	userRequestedProbability: 0.85,
	thresholdMargin: 0.05,
};
export const DEFAULT_MIN_ALLOW_CONFIDENCE = 0.85;
export const DEFAULT_MIN_DENY_CONFIDENCE = 0.6;
export const DEFAULT_MAX_ARGUMENT_BYTES = 8192;
export const DEFAULT_BREAKER = { failures: 5, coolDownMs: 60_000 };
export const DEFAULT_CACHE = { maxEntries: 1000, maxTtlMs: 10 * 60_000 };
export const DEFAULT_RECENT_ACTIONS = 10;

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
const confidence = z.number().gt(0).max(1);

const httpClassifier = z.strictObject({
	name: z
		.string()
		.regex(
			/^[A-Za-z0-9_-]{1,32}$/,
			"must be 1-32 characters from A-Z a-z 0-9 _ -",
		),
	url: z
		.string()
		.superRefine((u, ctx) => {
			const problem = classifierUrlProblem(u);
			if (problem) ctx.addIssue({ code: "custom", message: problem });
		})
		.optional(),
	tokenFile: absolutePath.optional(),
	dialect: z.enum(["worker-mcp-v1", "jev"]).optional(),
	backend: z.enum(["typesafe", "openrouter", "custom"]).optional(),
	model: z.string().min(1).max(100).optional(),
	thresholds: z
		.strictObject({
			denyScore: z.number().gt(0).max(3).optional(),
			askScore: z.number().gt(0).max(3).optional(),
			askProbability: confidence.optional(),
			untrustedProbability: confidence.optional(),
			userRequestedProbability: confidence.optional(),
			thresholdMargin: z.number().min(0).max(1).optional(),
		})
		.optional(),
	cacheTtlMs: positiveInt.optional(),
	timeoutMs: positiveInt.max(60_000).optional(),
	minAllowConfidence: confidence.optional(),
	minDenyConfidence: confidence.optional(),
	maxArgumentBytes: positiveInt.max(65_536).optional(),
	sendIntent: z.boolean().optional(),
	breaker: z
		.strictObject({
			failures: positiveInt.optional(),
			coolDownMs: positiveInt.optional(),
		})
		.optional(),
});
/** A mount source for the sandbox: absolute, normalised, never the root. */
const sandboxPath = absolutePath.refine(
	(p) =>
		!p.includes("\0") &&
		!p.split("/").includes("..") &&
		path.normalize(p).replace(/\/+$/, "") !== "",
	"must be an absolute path without '..' segments, and not the root",
);
const sandboxMode = z.enum(["none", "workspace"]);
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
	/** No longer used: accepted so existing config files keep loading. */
	legacyTools: z.boolean().optional(),
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
			maxWorkers: positiveInt.optional(),
			idleTimeoutMs: positiveInt.optional(),
			allowedRoots: z.array(absolutePath).optional(),
		})
		.optional(),
	env: z.strictObject({ allow: z.array(envName).optional() }).optional(),
	providers: z
		.strictObject({
			pi: z
				.strictObject({
					path: z.string().min(1).optional(),
					defaultModel: z.string().min(1).optional(),
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
			mode: z.enum(["manual", "auto"]).optional(),
			httpAllowCeiling: maxAutoApprove.optional(),
			onClassifierFailure: z.enum(["escalate", "deny"]).optional(),
			classifiers: z.array(httpClassifier).optional(),
			cache: z
				.strictObject({
					maxEntries: positiveInt.max(100_000).optional(),
					maxTtlMs: positiveInt.optional(),
				})
				.optional(),
			recentActions: z.number().int().min(0).max(50).optional(),
		})
		.optional(),
	audit: z
		.strictObject({
			enabled: z.boolean().optional(),
			file: absolutePath.optional(),
		})
		.optional(),
	sandbox: z
		.strictObject({
			minimum: sandboxMode.optional(),
			default: sandboxMode.optional(),
			extraRo: z.array(sandboxPath).optional(),
			extraRw: z.array(sandboxPath).optional(),
			hide: z.array(sandboxPath).optional(),
			bwrapPath: z.string().min(1).optional(),
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
	piDefaultModel: {
		name: "WORKER_MCP_PI_DEFAULT_MODEL",
		key: "providers.pi.defaultModel",
	},
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
	maxWorkers: { name: "WORKER_MCP_MAX_WORKERS", key: "limits.maxWorkers" },
	idleTimeout: {
		name: "WORKER_MCP_IDLE_TIMEOUT_MS",
		key: "limits.idleTimeoutMs",
	},
	allowedRoots: {
		name: "WORKER_MCP_ALLOWED_ROOTS",
		key: "limits.allowedRoots",
	},
	approvalTimeout: {
		name: "WORKER_MCP_APPROVAL_TIMEOUT_MS",
		key: "gate.approvalTimeoutMs",
	},
	envPassthrough: { name: "WORKER_MCP_ENV_PASSTHROUGH", key: "env.allow" },
	/** No longer used: accepted and ignored, with a warning. */
	legacyTools: { name: "WORKER_MCP_LEGACY_TOOLS", key: "legacyTools" },
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
	piDefaultModel: {
		flag: "--pi-default-model",
		key: "providers.pi.defaultModel",
		kind: "string",
	},
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
	maxWorkers: { flag: "--max-workers", key: "limits.maxWorkers", kind: "int" },
	idleTimeout: {
		flag: "--idle-timeout-ms",
		key: "limits.idleTimeoutMs",
		kind: "int",
	},
	allowedRoots: {
		flag: "--allowed-roots",
		key: "limits.allowedRoots",
		kind: "list",
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

/**
 * Settings that are one value each, not numbers: the same name in the
 * environment and on the command line.
 */
const CHOICE_SETTINGS = {
	gateMode: {
		env: "WORKER_MCP_GATE_MODE",
		flag: "--gate-mode",
		key: "gate.mode",
	},
	httpAllowCeiling: {
		env: "WORKER_MCP_HTTP_ALLOW_CEILING",
		flag: "--http-allow-ceiling",
		key: "gate.httpAllowCeiling",
	},
	onClassifierFailure: {
		env: "WORKER_MCP_ON_CLASSIFIER_FAILURE",
		flag: "--on-classifier-failure",
		key: "gate.onClassifierFailure",
	},
	auditEnabled: {
		env: "WORKER_MCP_AUDIT",
		flag: "--audit",
		key: "audit.enabled",
	},
	auditFile: {
		env: "WORKER_MCP_AUDIT_FILE",
		flag: "--audit-file",
		key: "audit.file",
	},
	sandboxMinimum: {
		env: "WORKER_MCP_SANDBOX_MINIMUM",
		flag: "--sandbox-minimum",
		key: "sandbox.minimum",
	},
	sandboxDefault: {
		env: "WORKER_MCP_SANDBOX_DEFAULT",
		flag: "--sandbox-default",
		key: "sandbox.default",
	},
} as const;
type ChoiceName = keyof typeof CHOICE_SETTINGS;

/** One choice setting, checked against its schema, as a config layer. */
function choiceLayer(source: string, name: ChoiceName, raw: string): FileLayer {
	const key = CHOICE_SETTINGS[name].key;
	const fail = (message: string): never => {
		throw new ConfigError(`Invalid config (${source}) ${key}: ${message}`);
	};
	const word = raw.trim().toLowerCase();
	const pick = <T extends string>(allowed: readonly T[], value: string): T =>
		(allowed as readonly string[]).includes(value)
			? (value as T)
			: fail(`${JSON.stringify(raw)} is not one of ${allowed.join(", ")}`);
	switch (name) {
		case "gateMode":
			return {
				gate: { mode: pick<"manual" | "auto">(["manual", "auto"], word) },
			};
		case "httpAllowCeiling":
			return {
				gate: {
					httpAllowCeiling: pick<"LOW" | "MEDIUM" | "HIGH">(
						["LOW", "MEDIUM", "HIGH"],
						word.toUpperCase(),
					),
				},
			};
		case "onClassifierFailure":
			return {
				gate: {
					onClassifierFailure: pick<"escalate" | "deny">(
						["escalate", "deny"],
						word,
					),
				},
			};
		case "auditEnabled":
			if (["1", "true", "on", "yes"].includes(word)) {
				return { audit: { enabled: true } };
			}
			if (["0", "false", "off", "no"].includes(word)) {
				return { audit: { enabled: false } };
			}
			return fail(`${JSON.stringify(raw)} is not 0 or 1`);
		case "sandboxMinimum":
			return {
				sandbox: { minimum: pick<SandboxMode>(["none", "workspace"], word) },
			};
		case "sandboxDefault":
			return {
				sandbox: { default: pick<SandboxMode>(["none", "workspace"], word) },
			};
		case "auditFile": {
			const result = absolutePath.safeParse(raw);
			return result.success
				? { audit: { file: result.data } }
				: fail("must be an absolute path");
		}
	}
}

export interface CliFlags {
	help: boolean;
	version: boolean;
	printConfig: boolean;
	values: Partial<Record<keyof typeof VALUE_FLAGS, string>>;
	choices: Partial<Record<ChoiceName, string>>;
}

/** Parse argv (without the node and script entries). Unknown flags fail. */
export function parseArgs(argv: readonly string[]): CliFlags {
	const flags: CliFlags = {
		help: false,
		version: false,
		printConfig: false,
		values: {},
		choices: {},
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
			const choice = Object.entries(CHOICE_SETTINGS).find(
				([, def]) => def.flag === name,
			);
			if (!entry && !choice) {
				throw new ConfigError(`Invalid command line: unknown flag ${arg}`);
			}
			let value: string | undefined;
			if (name !== arg) value = arg.slice(eq + 1);
			else value = argv[++i];
			if (value === undefined || value === "") {
				throw new ConfigError(`Invalid command line: ${name} needs a value`);
			}
			if (choice) flags.choices[choice[0] as ChoiceName] = value;
			else if (entry) {
				flags.values[entry[0] as keyof typeof VALUE_FLAGS] = value;
			}
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
		piDefaultModel?: string;
		piStartupTimeout?: { key: string; raw: string };
		commandTimeout?: { key: string; raw: string };
		maxOutputChars?: { key: string; raw: string };
		runTimeout?: { key: string; raw: string };
		maxWait?: { key: string; raw: string };
		runStartTimeout?: { key: string; raw: string };
		approvalTimeout?: { key: string; raw: string };
		maxWorkers?: { key: string; raw: string };
		idleTimeout?: { key: string; raw: string };
		allowedRoots?: { key: string; raw: string };
		passthrough?: { key: string; raw: string };
		stateDir?: string;
		runtimeDir?: string;
		maxAutoApprove?: string;
	},
	keys: {
		piPath: string;
		piDefaultModel: string;
		stateDir: string;
		runtimeDir: string;
	},
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
	if (values.piDefaultModel !== undefined) {
		layer.providers = {
			pi: {
				...layer.providers?.pi,
				defaultModel: check(
					keys.piDefaultModel,
					z.string().min(1),
					values.piDefaultModel,
				),
			},
		};
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
		["maxWorkers", "maxWorkers"],
		["idleTimeout", "idleTimeoutMs"],
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
	if (values.allowedRoots) {
		const roots = values.allowedRoots.raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		layer.limits = {
			...layer.limits,
			allowedRoots: check(
				values.allowedRoots.key,
				z.array(absolutePath),
				roots,
			),
		};
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
			label(ENV_VARS.piDefaultModel),
			{ piDefaultModel: get(ENV_VARS.piDefaultModel) },
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
			label(ENV_VARS.maxWorkers),
			{ maxWorkers: num(ENV_VARS.maxWorkers) },
			keysOf(),
		),
		stringLayer(
			label(ENV_VARS.idleTimeout),
			{ idleTimeout: num(ENV_VARS.idleTimeout) },
			keysOf(),
		),
		stringLayer(
			label(ENV_VARS.allowedRoots),
			{ allowedRoots: num(ENV_VARS.allowedRoots) },
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
	for (const [name, def] of Object.entries(CHOICE_SETTINGS)) {
		const raw = env[def.env];
		if (raw === undefined || raw.trim() === "") continue;
		parts.push(choiceLayer(`env ${def.env}`, name as ChoiceName, raw));
	}
	if (get(ENV_VARS.legacyTools) !== undefined)
		parts.push({ legacyTools: true });
	return parts.reduce<FileLayer>(mergeLayers, {});
}

function keysOf() {
	return {
		piPath: ENV_VARS.piPath.key,
		piDefaultModel: ENV_VARS.piDefaultModel.key,
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
			piDefaultModel: VALUE_FLAGS.piDefaultModel.key,
			stateDir: VALUE_FLAGS.stateDir.key,
			runtimeDir: VALUE_FLAGS.runtimeDir.key,
		};
		const entry = { key: def.key, raw };
		switch (name) {
			case "piPath":
				parts.push(stringLayer(source, { piPath: raw }, keys));
				break;
			case "piDefaultModel":
				parts.push(stringLayer(source, { piDefaultModel: raw }, keys));
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
			case "maxWorkers":
			case "idleTimeout":
			case "allowedRoots":
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
	for (const [name, raw] of Object.entries(flags.choices)) {
		const def = CHOICE_SETTINGS[name as ChoiceName];
		parts.push(choiceLayer(`flag ${def.flag}`, name as ChoiceName, raw));
	}
	return parts.reduce<FileLayer>(mergeLayers, {});
}

/** `over` wins for scalars; `env.allow` accumulates across layers. */
function mergeLayers(base: FileLayer, over: FileLayer): FileLayer {
	const allow = [...(base.env?.allow ?? []), ...(over.env?.allow ?? [])];
	return {
		stateDir: over.stateDir ?? base.stateDir,
		runtimeDir: over.runtimeDir ?? base.runtimeDir,
		legacyTools: over.legacyTools ?? base.legacyTools,
		limits: { ...base.limits, ...over.limits },
		env: { allow },
		audit: {
			enabled: over.audit?.enabled ?? base.audit?.enabled,
			file: over.audit?.file ?? base.audit?.file,
		},
		providers: {
			pi: {
				path: over.providers?.pi?.path ?? base.providers?.pi?.path,
				defaultModel:
					over.providers?.pi?.defaultModel ?? base.providers?.pi?.defaultModel,
				startupTimeoutMs:
					over.providers?.pi?.startupTimeoutMs ??
					base.providers?.pi?.startupTimeoutMs,
			},
		},
		sandbox: {
			minimum: over.sandbox?.minimum ?? base.sandbox?.minimum,
			default: over.sandbox?.default ?? base.sandbox?.default,
			extraRo: [
				...(base.sandbox?.extraRo ?? []),
				...(over.sandbox?.extraRo ?? []),
			],
			extraRw: [
				...(base.sandbox?.extraRw ?? []),
				...(over.sandbox?.extraRw ?? []),
			],
			hide: [...(base.sandbox?.hide ?? []), ...(over.sandbox?.hide ?? [])],
			bwrapPath: over.sandbox?.bwrapPath ?? base.sandbox?.bwrapPath,
		},
		gate: {
			maxAutoApprove: over.gate?.maxAutoApprove ?? base.gate?.maxAutoApprove,
			approvalTimeoutMs:
				over.gate?.approvalTimeoutMs ?? base.gate?.approvalTimeoutMs,
			mode: over.gate?.mode ?? base.gate?.mode,
			httpAllowCeiling:
				over.gate?.httpAllowCeiling ?? base.gate?.httpAllowCeiling,
			onClassifierFailure:
				over.gate?.onClassifierFailure ?? base.gate?.onClassifierFailure,
			// Classifiers come from the file only; a later layer never has any.
			classifiers: over.gate?.classifiers ?? base.gate?.classifiers,
			cache: { ...base.gate?.cache, ...over.gate?.cache },
			recentActions: over.gate?.recentActions ?? base.gate?.recentActions,
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

function resolveClassifiers(
	list: NonNullable<NonNullable<FileLayer["gate"]>["classifiers"]>,
): HttpClassifierConfig[] {
	const names = new Set<string>();
	return list.map((c) => {
		if (names.has(c.name)) {
			throw new ConfigError(
				`Invalid config: gate.classifiers has two classifiers named ${c.name}`,
			);
		}
		names.add(c.name);
		const where = `Invalid config: gate.classifiers ${c.name}`;
		const dialect = c.dialect ?? "worker-mcp-v1";
		let url: string;
		let jevFields: Partial<HttpClassifierConfig> = {};
		if (dialect === "jev") {
			const backend: JevBackend = c.backend ?? (c.url ? "custom" : "typesafe");
			if (backend === "custom") {
				if (!c.url) throw new ConfigError(`${where}: backend custom needs url`);
				url = c.url;
			} else {
				if (c.url) {
					throw new ConfigError(
						`${where}: url goes with backend custom; backend ${backend} has its own`,
					);
				}
				if (c.tokenFile === undefined) {
					throw new ConfigError(
						`${where}: backend ${backend} needs tokenFile (a file holding the API key)`,
					);
				}
				url = JEV_BACKENDS[backend].url;
			}
			const th = { ...DEFAULT_JEV_THRESHOLDS, ...c.thresholds };
			if (th.askScore > th.denyScore) {
				throw new ConfigError(
					`${where}: thresholds.askScore must not exceed thresholds.denyScore`,
				);
			}
			jevFields = {
				backend,
				model:
					c.model ??
					(backend === "custom"
						? JEV_CUSTOM_MODEL
						: JEV_BACKENDS[backend].model),
				jev: th,
				...(c.cacheTtlMs === undefined ? {} : { cacheTtlMs: c.cacheTtlMs }),
			};
		} else {
			for (const k of ["backend", "model", "thresholds"] as const) {
				if (c[k] !== undefined) {
					throw new ConfigError(`${where}: ${k} is for dialect jev`);
				}
			}
			if (!c.url) throw new ConfigError(`${where}: url is required`);
			url = c.url;
		}
		return {
			name: c.name,
			url,
			...(c.tokenFile === undefined ? {} : { tokenFile: c.tokenFile }),
			dialect,
			...jevFields,
			timeoutMs: c.timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS,
			minAllowConfidence: c.minAllowConfidence ?? DEFAULT_MIN_ALLOW_CONFIDENCE,
			minDenyConfidence: c.minDenyConfidence ?? DEFAULT_MIN_DENY_CONFIDENCE,
			maxArgumentBytes: c.maxArgumentBytes ?? DEFAULT_MAX_ARGUMENT_BYTES,
			sendIntent: c.sendIntent ?? true,
			breaker: {
				failures: c.breaker?.failures ?? DEFAULT_BREAKER.failures,
				coolDownMs: c.breaker?.coolDownMs ?? DEFAULT_BREAKER.coolDownMs,
			},
		};
	});
}

function applyDefaults(
	layer: FileLayer,
	env: NodeJS.ProcessEnv,
	exempt: string[],
): Config {
	const stateBase =
		env.XDG_STATE_HOME || path.join(homeOf(env), ".local", "state");
	const stateDir = layer.stateDir ?? path.join(stateBase, "worker-mcp");
	const mode = layer.gate?.mode ?? "manual";
	const classifiers = resolveClassifiers(layer.gate?.classifiers ?? []);
	if (mode === "auto" && classifiers.length === 0) {
		throw new ConfigError(
			"Invalid config: gate.mode is auto but gate.classifiers is empty; configure a classifier or use gate.mode manual",
		);
	}
	const minimum = layer.sandbox?.minimum ?? "none";
	if (minimum === "workspace" && layer.sandbox?.default === "none") {
		throw new ConfigError(
			"Invalid config: sandbox.default is none but sandbox.minimum is workspace; a worker may not run below the minimum",
		);
	}
	const bwrapEnv = env.WORKER_MCP_BWRAP?.trim();
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
			maxWorkers: layer.limits?.maxWorkers ?? DEFAULT_MAX_WORKERS,
			idleTimeoutMs: layer.limits?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
			allowedRoots: [...new Set(layer.limits?.allowedRoots ?? [])],
		},
		env: {
			allow: [...new Set(layer.env?.allow ?? [])],
			forceDropExempt: exempt,
		},
		providers: {
			pi: {
				path: layer.providers?.pi?.path || "pi",
				defaultModel: layer.providers?.pi?.defaultModel,
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
			mode,
			httpAllowCeiling: layer.gate?.httpAllowCeiling ?? "HIGH",
			onClassifierFailure: layer.gate?.onClassifierFailure ?? "escalate",
			classifiers,
			cache: {
				maxEntries: layer.gate?.cache?.maxEntries ?? DEFAULT_CACHE.maxEntries,
				maxTtlMs: layer.gate?.cache?.maxTtlMs ?? DEFAULT_CACHE.maxTtlMs,
			},
			recentActions: layer.gate?.recentActions ?? DEFAULT_RECENT_ACTIONS,
		},
		audit: {
			enabled: layer.audit?.enabled ?? true,
			file: layer.audit?.file ?? path.join(stateDir, "audit.jsonl"),
		},
		sandbox: {
			minimum,
			...(layer.sandbox?.default === undefined
				? {}
				: { default: layer.sandbox.default }),
			extraRo: [...new Set(layer.sandbox?.extraRo ?? [])],
			extraRw: [...new Set(layer.sandbox?.extraRw ?? [])],
			hide: [...new Set(layer.sandbox?.hide ?? [])],
			// The file wins over the environment, which the Nix package sets.
			...(layer.sandbox?.bwrapPath || bwrapEnv
				? { bwrapPath: layer.sandbox?.bwrapPath || bwrapEnv }
				: {}),
		},
	};
}

export interface LoadedConfig {
	config: Config;
	/** The config file that was read, or null when there was none. */
	configFile: string | null;
	flags: CliFlags;
	/** Settings that are no longer used, one line each; the server logs them at startup. */
	warnings: string[];
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
	const warnings: string[] = [];
	if (merged.legacyTools !== undefined) {
		warnings.push(
			`${ENV_VARS.legacyTools.name} / config key legacyTools is no longer used and is ignored: the pi-named tools are gone. Remove it.`,
		);
	}
	return {
		config: applyDefaults(merged, env, exempt),
		configFile,
		flags,
		warnings,
	};
}

/** The config with nothing set: for tests and library use. */
export function defaultConfig(env: NodeJS.ProcessEnv = {}): Config {
	return applyDefaults({}, env, []);
}

// ---- print ------------------------------------------------------------------

const SECRET_KEY = /token|secret|password|passwd|credential|api[_-]?key/i;
/** Names a file that holds a secret, not the secret: safe and useful to show. */
const PATH_KEY = /File$/;

/** Deep copy with the value of every secret-looking key replaced. */
export function redactConfig<T>(value: T): T {
	if (Array.isArray(value)) return value.map((v) => redactConfig(v)) as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] =
				SECRET_KEY.test(k) && !PATH_KEY.test(k) && v != null
					? "[redacted]"
					: redactConfig(v);
		}
		return out as T;
	}
	return value;
}

/** What `--print-config` prints. */
export function formatConfig(config: Config): string {
	return `${JSON.stringify(redactConfig(config), null, 2)}\n`;
}
