import assert from "node:assert";
import test from "node:test";

import { parseToolFromMessage } from "../request.js";

test("parses the worker-mcp-gate format", () => {
	assert.deepStrictEqual(
		parseToolFromMessage(
			"worker-mcp-gate",
			'{"toolName":"bash","input":{"command":"ls"}}',
		),
		{ toolName: "bash", input: { command: "ls" } },
	);
});

test("parses the old Allow Tool Execution format", () => {
	assert.deepStrictEqual(
		parseToolFromMessage(
			"Allow Tool Execution",
			'Allow the "bash" tool to run with arguments: {"command":"ls"}?',
		),
		{ toolName: "bash", input: { command: "ls" } },
	);
});

test("returns null for anything else, including inputs that are not objects", () => {
	assert.strictEqual(parseToolFromMessage("invalid", "{}"), null);
	assert.strictEqual(parseToolFromMessage("worker-mcp-gate", "nope"), null);
	assert.strictEqual(
		parseToolFromMessage("worker-mcp-gate", '{"toolName":"bash","input":[]}'),
		null,
	);
	assert.strictEqual(
		parseToolFromMessage("worker-mcp-gate", '{"toolName":"bash","input":null}'),
		null,
	);
	assert.strictEqual(
		parseToolFromMessage("worker-mcp-gate", '{"toolName":5,"input":{}}'),
		null,
	);
	assert.strictEqual(
		parseToolFromMessage(
			"Allow Tool Execution",
			'Allow the "bash" tool to run with arguments: []?',
		),
		null,
	);
});
