import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
	CallToolResultSchema,
	CreateTaskResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

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

type TestClient = Awaited<ReturnType<typeof connect>>["client"];

async function startTask(
	client: TestClient,
	sessionId: string,
	command: string,
) {
	const created = await client.request(
		{
			method: "tools/call",
			params: {
				name: "send_pi_command",
				arguments: { sessionId, command },
				task: { ttl: 60_000 },
			},
		},
		CreateTaskResultSchema,
	);
	return created.task.taskId;
}

async function waitForTaskStatus(
	client: TestClient,
	taskId: string,
	status: string,
) {
	for (let i = 0; i < 100; i++) {
		const task = await client.experimental.tasks.getTask(taskId);
		if (task.status === status) return task;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`task ${taskId} never reached ${status}`);
}

describe("MCP server - in-process", () => {
	before(() => {
		previousHome = process.env.HOME;
		previousPiPath = process.env.WORKER_MCP_PI_PATH;
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "worker-mcp-test-"));
		process.env.HOME = tempHome;
		process.env.WORKER_MCP_PI_PATH = fakePi;
		process.env.FAKE_PI_LOG = path.join(tempHome, "fake-pi.log");
	});

	after(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousPiPath === undefined) delete process.env.WORKER_MCP_PI_PATH;
		else process.env.WORKER_MCP_PI_PATH = previousPiPath;
		delete process.env.FAKE_PI_LOG;
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

	test("a task-augmented send_pi_command completes its task with the output", async () => {
		const { manager, client } = await connect();
		try {
			await client.callTool({
				name: "spawn_pi_session",
				arguments: { sessionId: "task-ok", cwd: tempHome },
			});
			const taskId = await startTask(client, "task-ok", "hello");
			await waitForTaskStatus(client, taskId, "completed");
			const result = await client.experimental.tasks.getTaskResult(
				taskId,
				CallToolResultSchema,
			);
			assert.deepStrictEqual(result.content[0], {
				type: "text",
				text: "fake-pi reply: hello",
			});
		} finally {
			manager.terminateAll();
			await client.close();
		}
	});

	test("cancelling a task-mode run aborts the worker and keeps the server alive", async () => {
		const { manager, client } = await connect();
		try {
			await client.callTool({
				name: "spawn_pi_session",
				arguments: { sessionId: "task-cancel", cwd: tempHome },
			});
			const taskId = await startTask(client, "task-cancel", "slow job");
			await waitForTaskStatus(client, taskId, "working");

			await client.callTool({
				name: "cancel_pi_command",
				arguments: { sessionId: "task-cancel" },
			});
			await waitForTaskStatus(client, taskId, "cancelled");

			// The worker settles after the abort; storing a result for the now
			// cancelled task must not throw or crash the process.
			for (let i = 0; i < 100; i++) {
				if (manager.getSession("task-cancel").status === "IDLE") break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.strictEqual(manager.getSession("task-cancel").status, "IDLE");
			const aborts = fs
				.readFileSync(process.env.FAKE_PI_LOG as string, "utf8")
				.split("\n")
				.filter((line) => line === "abort");
			assert.strictEqual(
				aborts.length,
				1,
				"exactly one abort reaches the worker",
			);

			// The server still answers.
			const listed = await client.callTool({
				name: "list_pi_sessions",
				arguments: {},
			});
			assert.notStrictEqual(listed.isError, true);
		} finally {
			manager.terminateAll();
			await client.close();
		}
	});

	test("a run that hits an approval keeps its task input_required until approved", async () => {
		const { manager, client } = await connect();
		try {
			await client.callTool({
				name: "spawn_pi_session",
				arguments: { sessionId: "task-approve", cwd: tempHome },
			});
			const taskId = await startTask(client, "task-approve", "approve it");
			await waitForTaskStatus(client, taskId, "input_required");
			// Give the stopped run time to (wrongly) complete the task.
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.strictEqual(
				(await client.experimental.tasks.getTask(taskId)).status,
				"input_required",
			);

			const approved = await client.callTool({
				name: "approve_action",
				arguments: { sessionId: "task-approve", actionId: "ui-1" },
			});
			assert.deepStrictEqual(approved.content, [
				{ type: "text", text: "approved and done" },
			]);
			await waitForTaskStatus(client, taskId, "completed");
		} finally {
			manager.terminateAll();
			await client.close();
		}
	});
});
