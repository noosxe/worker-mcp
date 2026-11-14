/** Minimal logging seam: messages are metadata only, never tool payloads. */
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

/** Writes to stderr, which MCP clients keep apart from the protocol stream. */
export const stderrLogger: Logger = {
	debug: (m) => console.error(`[debug] ${m}`),
	info: (m) => console.error(`[info] ${m}`),
	warn: (m) => console.error(`[warn] ${m}`),
	error: (m) => console.error(`[error] ${m}`),
};
