/** Stable codes a coordinator can act on. */
export type ErrorCode =
	| "WORKER_NOT_FOUND"
	| "WORKER_BUSY"
	| "RUN_NOT_FOUND"
	| "APPROVAL_NOT_FOUND"
	| "LIMIT_REACHED"
	| "INVALID_ARGUMENT"
	| "PROVIDER_UNAVAILABLE"
	| "GATE_UNAVAILABLE"
	| "SANDBOX_UNAVAILABLE"
	| "CWD_NOT_ALLOWED";

/**
 * A failure whose message is `CODE: one sentence on what to do next`. It is
 * what a tool returns as an error result; it never carries a stack trace.
 */
export class ToolError extends Error {
	override name = "ToolError";
	constructor(
		readonly code: ErrorCode,
		detail: string,
	) {
		super(`${code}: ${detail}`);
	}
}
