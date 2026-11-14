import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../server.js";
import { SessionManager } from "../session/session-manager.js";

const fakePi = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"fake-pi.mjs",
);

let tempHome: string;
let previousHome: string | undefined;
let previousPiPath: string | undefined;

async function connect() {
	const manager = new SessionManager();
	const server = createServer(manager, "0.0.0-test");
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	return { manager, client };
}

describe("MCP server - in-process", () => {
	before(() => {
		previousHome = process.env.HOME;
		previousPiPath = process.env.WORKER_MCP_PI_PATH;
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "worker-mcp-test-"));
		process.env.HOME = tempHome;
		process.env.WORKER_MCP_PI_PATH = fakePi;
	});

	after(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousPiPath === undefined) delete process.env.WORKER_MCP_PI_PATH;
		else process.env.WORKER_MCP_PI_PATH = previousPiPath;
		fs.rmSync(tempHome, { recursive: true, force: true });
	});

	test("a plain send_pi_command returns the worker output", async () => {
		const { manager, client } = await connect();
		try {
			const spawned = await client.callTool({
				name: "spawn_pi_session",
				arguments: { sessionId: "plain", cwd: tempHome },
			});
			assert.notStrictEqual(spawned.isError, true);

			const result = await client.callTool({
				name: "send_pi_command",
				arguments: { sessionId: "plain", command: "hello" },
			});
			assert.notStrictEqual(result.isError, true);
			assert.strictEqual("task" in result, false, "no task for a plain call");
			assert.deepStrictEqual(result.content, [
				{ type: "text", text: "fake-pi reply: hello" },
			]);
		} finally {
			manager.terminateAll();
			await client.close();
		}
	});

	test("an invalid sessionId is rejected", async () => {
		const { manager, client } = await connect();
		try {
			const result = await client.callTool({
				name: "spawn_pi_session",
				arguments: { sessionId: "../escape", cwd: tempHome },
			});
			assert.strictEqual(result.isError, true);
			assert.match(
				(result.content as { text: string }[])[0].text,
				/Invalid sessionId/,
			);
		} finally {
			manager.terminateAll();
			await client.close();
		}
	});
});
