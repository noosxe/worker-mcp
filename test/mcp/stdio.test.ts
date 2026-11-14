import assert from "node:assert";
import { after, before, describe, test } from "node:test";

import { behaviourTests, textOf } from "../helpers/behaviour.js";
import {
	createIsolation,
	type Isolation,
	pidGone,
	waitUntil,
} from "../helpers/isolation.js";
import { connectStdio, RawServer, RUNTIME } from "../helpers/stdio.js";
import { TOOLS } from "../helpers/tools.js";

// The same behaviour tests as in-process, now against dist/index.js through a
// real stdio transport, under the runtime named by WORKER_MCP_TEST_RUNTIME.
behaviourTests(`MCP stdio (${RUNTIME}): behaviour`, {
	connect: connectStdio,
});

describe(`MCP stdio (${RUNTIME}): process lifecycle`, () => {
	let iso: Isolation;
	const servers: RawServer[] = [];

	before(() => {
		iso = createIsolation();
	});
	after(async () => {
		for (const server of servers) await server.dispose();
		await iso.cleanup();
	});

	async function start(): Promise<RawServer> {
		const server = new RawServer(iso);
		servers.push(server);
		await server.initialize();
		return server;
	}

	async function spawnWorker(server: RawServer, sessionId: string) {
		const known = iso.starts().length;
		const res = await server.callTool(TOOLS.spawn, {
			sessionId,
			cwd: iso.cwd,
		});
		assert.notStrictEqual(res.result.isError, true, textOf(res.result));
		return (await iso.workerAfter(known)).pid;
	}

	test("stdout carries nothing but JSON-RPC", async () => {
		const server = await start();
		await spawnWorker(server, "pure");
		await server.callTool(TOOLS.send, { sessionId: "pure", command: "hi" });
		await server.callTool(TOOLS.send, { sessionId: "nope", command: "hi" });
		server.child.stdin!.end();
		await server.exited;
		assert.ok(server.stdoutLines.length >= 4);
		for (const line of server.stdoutLines) {
			const msg = JSON.parse(line);
			assert.strictEqual(msg.jsonrpc, "2.0", `not JSON-RPC: ${line}`);
		}
	});

	test("stdin EOF: the server exits within 5 s and the worker is gone", async () => {
		const server = await start();
		const pid = await spawnWorker(server, "eof");
		assert.ok(!pidGone(pid));
		const began = Date.now();
		server.child.stdin!.end();
		await Promise.race([
			server.exited,
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("server did not exit")), 5000),
			),
		]);
		assert.ok(Date.now() - began < 5000);
		await waitUntil(() => pidGone(pid), 3000, "fake-pi to exit");
	});

	test("SIGTERM to the server kills its workers", async () => {
		const server = await start();
		const pid = await spawnWorker(server, "sigterm");
		server.child.kill("SIGTERM");
		await Promise.race([
			server.exited,
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("server did not exit")), 5000),
			),
		]);
		await waitUntil(() => pidGone(pid), 3000, "fake-pi to exit");
	});

	test(
		"terminate kills a worker that ignores SIGTERM",
		{
			todo: "only SIGTERM is sent today; the provider-split phase adds the SIGKILL escalation",
		},
		async () => {
			const server = await start();
			const pid = await spawnWorker(server, "stubborn");
			iso.allowLeak(pid); // cleanup kills it if the assertion below fails
			// The send never answers; the request is abandoned with the server.
			server
				.callTool(TOOLS.send, {
					sessionId: "stubborn",
					command: "scenario:ignore-sigterm",
				})
				.catch(() => {});
			await waitUntil(
				() => iso.runs().includes("ignore-sigterm"),
				5000,
				"the scenario to start",
			);
			await server.callTool(TOOLS.terminate, { sessionId: "stubborn" });
			await waitUntil(() => pidGone(pid), 3000, "fake-pi to exit");
		},
	);

	test(
		"terminate kills the worker's detached grandchild",
		{
			todo: "leaks today: pi's bash children run in their own process group and only pi is signalled; fixed by the tree kill in the provider-split phase",
		},
		async () => {
			const server = await start();
			await spawnWorker(server, "grand");
			const res = await server.callTool(TOOLS.send, {
				sessionId: "grand",
				command: "scenario:grandchild",
			});
			const grandchild = Number(
				textOf(res.result).match(/grandchild pid: (\d+)/)?.[1],
			);
			assert.ok(grandchild > 0);
			await server.callTool(TOOLS.terminate, { sessionId: "grand" });
			await waitUntil(() => pidGone(grandchild), 2000, "grandchild to exit");
		},
	);
});
