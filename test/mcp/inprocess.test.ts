import assert from "node:assert";
import * as fs from "node:fs";
import { describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";
import { SessionManager } from "../../src/session/session-manager.js";
import {
	behaviourTests,
	callOk,
	callView,
	viewOf,
	gatedBash,
	type Connection,
	textOf,
} from "../helpers/behaviour.js";
import {
	applyEnv,
	createIsolation,
	type Isolation,
} from "../helpers/isolation.js";
import { TOOLS } from "../helpers/tools.js";

async function connect(
	extraEnv: Record<string, string> = {},
): Promise<Connection & { manager: SessionManager }> {
	const env = { ...process.env, ...extraEnv };
	const manager = new SessionManager(loadConfig([], env).config, env);
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
			await manager.terminateAll();
			await client.close();
		},
	};
}

// The behaviour shared with the stdio layer.
behaviourTests("MCP in-process: behaviour", {
	setup: (iso) => applyEnv(iso),
	connect: () => connect(),
});

describe("MCP in-process: schemas and errors", () => {
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

	test("an invalid worker name is rejected", async () => {
		const { client, close } = await connect();
		try {
			const result = await client.callTool({
				name: TOOLS.spawn,
				arguments: { name: "../escape", cwd: iso.cwd },
			});
			assert.strictEqual(result.isError, true);
			assert.match(textOf(result), /^INVALID_ARGUMENT: /);
		} finally {
			await close();
		}
	});

	test("an unknown session is an error result, not a crash", async () => {
		const { client, close } = await connect();
		try {
			const result = await client.callTool({
				name: TOOLS.startRun,
				arguments: { workerId: "nope", prompt: "hi" },
			});
			assert.strictEqual(result.isError, true);
			assert.match(textOf(result), /^WORKER_NOT_FOUND: /);
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
				arguments: { name: "nodir", cwd: `${iso.cwd}/missing` },
			});
			assert.strictEqual(result.isError, true);
			assert.match(textOf(result), /^CWD_NOT_ALLOWED: .*does not exist/);
		} finally {
			await close();
		}
	});

	test("MCP tasks are not advertised and a task request gets a plain result", async () => {
		const { client, close } = await connect();
		try {
			assert.strictEqual(client.getServerCapabilities()?.tasks, undefined);
			await callOk(client, TOOLS.spawn, { name: "no-task", cwd: iso.cwd });
			const result = await client.callTool({
				name: TOOLS.startRun,
				arguments: { workerId: "no-task", prompt: "hello", waitMs: 5000 },
			});
			assert.strictEqual("task" in result, false);
			assert.strictEqual(viewOf(result).output.text, "fake-pi reply: hello");
		} finally {
			await close();
		}
	});

	test("a wait is clamped to limits.maxWaitMs, whatever is asked", async () => {
		const { client, close } = await connect({
			WORKER_MCP_MAX_WAIT_MS: "300",
		});
		try {
			await callOk(client, TOOLS.spawn, { name: "clamp", cwd: iso.cwd });
			const started = await callView(client, TOOLS.startRun, {
				workerId: "clamp",
				prompt: "scenario:slow:60000",
			});
			const t0 = Date.now();
			const view = await callView(client, TOOLS.waitRun, {
				runId: started.runId,
				waitMs: 50_000,
			});
			assert.ok(Date.now() - t0 < 5000, "returned near the 300 ms bound");
			assert.strictEqual(view.state, "running");
			await callView(client, TOOLS.cancelRun, { runId: started.runId });
		} finally {
			await close();
		}
	});

	test("an approval nobody answers is denied after the approval timeout", async () => {
		const { client, close } = await connect({
			WORKER_MCP_APPROVAL_TIMEOUT_MS: "300",
		});
		try {
			await callOk(client, TOOLS.spawn, { name: "expire", cwd: iso.cwd });
			const started = await callView(client, TOOLS.startRun, {
				workerId: "expire",
				prompt: gatedBash("rm -rf build"),
			});
			const waiting = await callView(client, TOOLS.waitRun, {
				runId: started.runId,
				waitMs: 10_000,
			});
			assert.strictEqual(waiting.state, "awaiting_approval");
			// The expiry wakes a caller that already saw the approval.
			const done = await callView(client, TOOLS.waitRun, {
				runId: started.runId,
				waitMs: 10_000,
				sinceSeq: waiting.seq,
			});
			assert.notStrictEqual(done.state, "awaiting_approval");
			const final = await callView(client, TOOLS.waitRun, {
				runId: started.runId,
				waitMs: 10_000,
				sinceSeq: done.seq,
			});
			assert.strictEqual(final.state, "completed");
			assert.match(final.output.text, /^tool bash blocked: approval timed out/);
		} finally {
			await close();
		}
	});

	test("the worker sees only what the server was given (isolation)", async () => {
		const { client, close } = await connect();
		try {
			const known = iso.starts().length;
			await callOk(client, TOOLS.spawn, { name: "env", cwd: iso.cwd });
			const start = await iso.workerAfter(known);
			assert.strictEqual(start.env.HOME, iso.home);
			assert.ok(
				!fs.existsSync(`${iso.home}/.config/worker-mcp/worker-mcp-gate.ts`),
				"no persistent gate copy is written",
			);
			assert.ok(!fs.existsSync(`${iso.home}/.pi`), "~/.pi is never touched");
		} finally {
			await close();
		}
	});
});
