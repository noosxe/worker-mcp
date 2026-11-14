/** A tool call as the gate extension reports it. */
export interface ToolCallInfo {
	toolName: string;
	input: Record<string, unknown>;
}

/**
 * Read a tool call out of a pi confirmation request. Returns null for
 * anything else, and the caller then sends the request to the coordinator.
 */
export function parseToolFromMessage(
	title: string,
	message: string,
): ToolCallInfo | null {
	if (title === "worker-mcp-gate") {
		try {
			const parsed = JSON.parse(message);
			if (
				typeof parsed.toolName === "string" &&
				typeof parsed.input === "object" &&
				parsed.input !== null &&
				!Array.isArray(parsed.input)
			) {
				return { toolName: parsed.toolName, input: parsed.input };
			}
		} catch {
			return null;
		}
	} else if (title === "Allow Tool Execution") {
		const match = message.match(
			/^Allow the "(.+?)" tool to run with arguments: (.+)\?$/,
		);
		if (match) {
			try {
				const input = JSON.parse(match[2]);
				if (
					typeof input === "object" &&
					input !== null &&
					!Array.isArray(input)
				) {
					return { toolName: match[1], input };
				}
			} catch {
				return null;
			}
		}
	}
	return null;
}
