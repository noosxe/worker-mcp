import assert from "node:assert";
import * as fs from "node:fs";
import { describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
	CallToolResultSchema,
	CreateTaskResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createServer } from "../../src/server.js";
import { SessionManager } from "../../src/session/session-manager.js";
import {
	behaviourTests,
	callOk,
	type Connection,
	textOf,
} from "../helpers/behaviour.js";
import {
	applyEnv,
	createIsolation,
	type Isolation,
	waitUntil,
} from "../helpers/isolation.js";
import { TOOLS } from "../helpers/tools.js";

async function connect(): Promise<Connection & { manager: SessionManager }> {
	const manager = new SessionManager();
	const server = createServer(manager, "0.0.0-test");
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	return {
		manager,
		client,
		async close() {
			manager.terminateAll();
			await client.close();
		},
	};
}

// The behaviour shared with the stdio layer.
behaviourTests("MCP in-process: behaviour", {
	setup: (iso) => applyEnv(iso),
	connect: () => connect(),
});

type TestClient = Client;

async function startTask(
	client: TestClient,
	sessionId: string,
	command: string,
) {
	const created = await client.request(
		{
			method: "tools/call",
			params: {
				name: TOOLS.send,
				arguments: { sessionId, command },
				task: { ttl: 5000 },
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

describe("MCP in-process: schemas, errors and task mode", () => {
	let iso: Isolation;
	let restore: () => void;

	test.before(() => {
		iso = createIsolation();
		restore = applyEnv(iso);
	});

	test.after(async () => {
		restore();
		await iso.cleanup();
	});

	test("every tool is listed with an object input schema", async () => {
		const { client, close } = await connect();
		try {
			const { tools } = await client.listTools();
			const names = tools.map((t) => t.name);
			for (const name of Object.values(TOOLS)) {
				assert.ok(names.includes(name), `${name} is listed`);
			}
			for (const tool of tools) {
				assert.strictEqual(tool.inputSchema.type, "object");
			}
		} finally {
			await close();
		}
	});

	test("an invalid sessionId is rejected", async () => {
		const { client, close } = await connect();
		try {
			const result = await client.callTool({
				name: TOOLS.spawn,
				arguments: { sessionId: "../escape", cwd: iso.cwd },
			});
			assert.strictEqual(result.isError, true);
			assert.match(textOf(result), /Invalid sessionId/);
		} finally {
			await close();
		}
	});

	test("an unknown session is an error result, not a crash", async () => {
		const { client, close } = await connect();
		try {
			const result = await client.callTool({
				name: TOOLS.send,
				arguments: { sessionId: "nope", command: "hi" },
			});
			assert.strictEqual(result.isError, true);
			assert.match(textOf(result), /Session not found/);
			await callOk(client, TOOLS.list, {});
		} finally {
			await close();
		}
	});

	test("a spawn in a missing directory is refused", async () => {
		const { client, close } = await connect();
		try {
			const result = await client.callTool({
				name: TOOLS.spawn,
				arguments: { sessionId: "nodir", cwd: `${iso.cwd}/missing` },
			});
			assert.strictEqual(result.isError, true);
			assert.match(textOf(result), /does not exist/);
		} finally {
			await close();
		}
	});

	test("a task-augmented send completes its task with the output", async () => {
		const { client, close } = await connect();
		try {
			await callOk(client, TOOLS.spawn, { sessionId: "task-ok", cwd: iso.cwd });
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
			await close();
		}
	});

	test("cancelling a task-mode run aborts the worker and keeps the server alive", async () => {
		const { client, close, manager } = await connect();
		try {
			await callOk(client, TOOLS.spawn, {
				sessionId: "task-cancel",
				cwd: iso.cwd,
			});
			const taskId = await startTask(
				client,
				"task-cancel",
				"scenario:slow:60000",
			);
			await waitForTaskStatus(client, taskId, "working");

			await client.callTool({
				name: TOOLS.cancel,
				arguments: { sessionId: "task-cancel" },
			});
			await waitForTaskStatus(client, taskId, "cancelled");

			// The worker settles after the abort; storing a result for the now
			// cancelled task must not throw or crash the process.
			await waitUntil(
				() => manager.getSession("task-cancel").status === "IDLE",
				5000,
				"IDLE",
			);
			assert.strictEqual(
				iso.received().filter((type) => type === "abort").length,
				1,
				"exactly one abort reaches the worker",
			);
			await callOk(client, TOOLS.list, {});
		} finally {
			await close();
		}
	});

	test("a run that hits an approval keeps its task input_required until approved", async () => {
		const { client, close } = await connect();
		try {
			await callOk(client, TOOLS.spawn, {
				sessionId: "task-approve",
				cwd: iso.cwd,
			});
			const taskId = await startTask(
				client,
				"task-approve",
				`scenario:tool:bash:${JSON.stringify({ command: "rm -rf build" })}`,
			);
			await waitForTaskStatus(client, taskId, "input_required");
			// Give the stopped run time to (wrongly) complete the task.
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.strictEqual(
				(await client.experimental.tasks.getTask(taskId)).status,
				"input_required",
			);

			const pending = JSON.parse(
				await callOk(client, TOOLS.pending, { sessionId: "task-approve" }),
			);
			const approved = await callOk(client, TOOLS.approve, {
				sessionId: "task-approve",
				actionId: pending.actionId,
			});
			assert.match(approved, /^tool bash ran with /);
			await waitForTaskStatus(client, taskId, "completed");
		} finally {
			await close();
		}
	});

	test("the worker sees only what the server was given (isolation)", async () => {
		const { client, close } = await connect();
		try {
			const known = iso.starts().length;
			await callOk(client, TOOLS.spawn, { sessionId: "env", cwd: iso.cwd });
			const start = await iso.workerAfter(known);
			assert.strictEqual(start.env.HOME, iso.home);
			assert.ok(
				fs.existsSync(`${iso.home}/.config/worker-mcp/worker-mcp-gate.ts`),
				"the gate was deployed under the private HOME",
			);
		} finally {
			await close();
		}
	});
});
