const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidSessionId(value: unknown): value is string {
	return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/** Throws unless the value is safe to use in paths, URIs and lookups. */
export function assertValidSessionId(value: unknown): asserts value is string {
	if (!isValidSessionId(value)) {
		throw new Error(
			"Invalid sessionId: use 1-64 characters from A-Z, a-z, 0-9, '_' and '-'.",
		);
	}
}

/**
 * Read a positive integer from an environment variable.
 * Returns undefined when the variable is unset or empty and throws a clear
 * error when it is set to anything that is not a positive integer.
 */
export function readPositiveIntEnv(
	name: string,
	env: NodeJS.ProcessEnv = process.env,
): number | undefined {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return undefined;
	const text = raw.trim();
	const value = Number(text);
	if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error(
			`Invalid value for ${name}: ${JSON.stringify(raw)} (expected a positive integer)`,
		);
	}
	return value;
}

export const NUMERIC_ENV_VARS = [
	"WORKER_MCP_COMMAND_TIMEOUT",
	"WORKER_MCP_MAX_OUTPUT_CHARS",
] as const;

/** Validate every numeric environment variable; throws on the first bad one. */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): void {
	for (const name of NUMERIC_ENV_VARS) {
		readPositiveIntEnv(name, env);
	}
}
