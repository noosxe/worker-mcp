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

let current: LogLevel = "info";

/**
 * Set once at startup from the resolved config (`logLevel`, which
 * `WORKER_MCP_LOG_LEVEL` and `--log-level` override). The one source of truth
 * for the stderr logger and `debugEnabled()`.
 */
export function setLogLevel(level: LogLevel): void {
	current = level;
}

/** Whether payload-carrying (debug) messages may be written. */
export const debugEnabled = (): boolean => current === "debug";

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
function at(level: LogLevel, m: string): void {
	if (LEVELS.indexOf(level) >= LEVELS.indexOf(current)) {
		console.error(`[${level}] ${m}`);
	}
}

export const stderrLogger: Logger = {
	debug: (m) => at("debug", m),
	info: (m) => at("info", m),
	warn: (m) => at("warn", m),
	error: (m) => at("error", m),
};
