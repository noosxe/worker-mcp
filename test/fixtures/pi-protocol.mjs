// Message shapes of pi's `--mode rpc` JSONL protocol, as far as worker-mcp
// uses them. Kept in one place so the fake-pi fixture never invents shapes.
//
// Checked against pi 1.4.0 (docs/rpc.md of @earendil-works/pi-coding-agent):
//   - commands on stdin: `prompt`, `abort`, `set_model`, and the
//     `extension_ui_response` reply to a dialog
//   - `response` acknowledges a command (it does not mean the run is done)
//   - events on stdout: agent_start, agent_end, agent_settled, turn_start,
//     turn_end, message_update (with `assistantMessageEvent.delta`),
//     message_end, tool_execution_start, tool_execution_end
//   - dialogs (`confirm` here) are `extension_ui_request` records with a
//     unique `id`, answered by `extension_ui_response` with `confirmed`
//     (or `cancelled: true`)
// Framing is strict JSONL with LF as the only record delimiter.
// When pi is upgraded, re-check these shapes against its docs.

export const PI_PROTOCOL_CHECKED_AGAINST = "1.4.0";

export const response = (id, command, success = true, error = undefined) => ({
	...(id === undefined ? {} : { id }),
	type: "response",
	command,
	success,
	...(error === undefined ? {} : { error }),
});

export const agentStart = () => ({ type: "agent_start" });
export const agentEnd = () => ({
	type: "agent_end",
	messages: [],
	willRetry: false,
});
export const agentSettled = () => ({ type: "agent_settled" });
export const turnStart = () => ({ type: "turn_start" });
export const turnEnd = () => ({ type: "turn_end", toolResults: [] });

export const messageUpdate = (delta) => ({
	type: "message_update",
	usage: { input: 0, output: 0, totalTokens: 0 },
	assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
});

export const messageEnd = (text) => ({
	type: "message_end",
	message: { role: "assistant", content: [{ type: "text", text }] },
});

export const toolExecutionStart = (toolCallId, toolName, args) => ({
	type: "tool_execution_start",
	toolCallId,
	toolName,
	args,
});

export const toolExecutionEnd = (toolCallId, toolName, isError = false) => ({
	type: "tool_execution_end",
	toolCallId,
	toolName,
	result: { content: [{ type: "text", text: "" }] },
	isError,
});

export const confirmRequest = (id, title, message) => ({
	type: "extension_ui_request",
	id,
	method: "confirm",
	title,
	message,
});

/** Split a stream chunk on LF only (readline also splits on U+2028/2029). */
export function createLineSplitter(onLine) {
	let buffer = "";
	return (chunk) => {
		buffer += chunk;
		let index = buffer.indexOf("\n");
		while (index !== -1) {
			const line = buffer.slice(0, index).replace(/\r$/, "");
			buffer = buffer.slice(index + 1);
			if (line) onLine(line);
			index = buffer.indexOf("\n");
		}
	};
}
