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
