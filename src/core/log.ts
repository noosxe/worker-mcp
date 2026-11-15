import { createHash } from "node:crypto";

/**
 * Minimal logging seam. At every level above `debug` a message is metadata
 * only (names, ids, counts, labels): never a tool input, file content, worker
 * output, prompt or classifier body. `debug` may carry such payloads.
 */
export interface Logger {
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export const noopLogger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** The level from `WORKER_MCP_LOG_LEVEL`; anything unknown means `info`. */
export function logLevelFrom(env: NodeJS.ProcessEnv = process.env): LogLevel {
	const raw = env.WORKER_MCP_LOG_LEVEL?.trim().toLowerCase();
	return LEVELS.find((l) => l === raw) ?? "info";
}

/** Whether payload-carrying (debug) messages may be written. */
export const debugEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
	logLevelFrom(env) === "debug";

/** First line of an error message, capped: enough to diagnose, never a dump. */
export function describeError(e: unknown, max = 200): string {
	const raw = e instanceof Error ? e.message : String(e);
	const line = raw.split("\n", 1)[0] ?? "";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Short digest of a payload, so log lines can be correlated without it. */
export function shortDigest(payload: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(payload) ?? "null")
		.digest("hex")
		.slice(0, 12);
}

/** Writes to stderr, which MCP clients keep apart from the protocol stream. */
export function createStderrLogger(
	env: NodeJS.ProcessEnv = process.env,
): Logger {
	const rank = LEVELS.indexOf(logLevelFrom(env));
	const at = (level: LogLevel, m: string) => {
		if (LEVELS.indexOf(level) >= rank) console.error(`[${level}] ${m}`);
	};
	return {
		debug: (m) => at("debug", m),
		info: (m) => at("info", m),
		warn: (m) => at("warn", m),
		error: (m) => at("error", m),
	};
}

export const stderrLogger: Logger = createStderrLogger();
