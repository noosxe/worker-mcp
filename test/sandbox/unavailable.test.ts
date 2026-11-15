import assert from "node:assert";
import { after, before, describe, test } from "node:test";

import { textOf } from "../helpers/behaviour.js";
import { createIsolation, type Isolation } from "../helpers/isolation.js";
import { RawServer, RUNTIME } from "../helpers/stdio.js";

/** The server with a bubblewrap that cannot work: runs everywhere. */
describe(`sandbox unavailable (${RUNTIME})`, () => {
	let iso: Isolation;
	const servers: RawServer[] = [];

	before(() => {
		iso = createIsolation();
		delete iso.env.WORKER_MCP_SANDBOX_DEFAULT;
		iso.env.WORKER_MCP_BWRAP = "/nonexistent/bwrap";
	});
	after(async () => {
		for (const s of servers) await s.dispose();
		await iso.cleanup();
	});

	async function start(): Promise<RawServer> {
		const server = new RawServer(iso);
		servers.push(server);
		await server.initialize();
		return server;
	}

	test("list_providers says why", async () => {
		const server = await start();
		const res = await server.callTool("list_providers", {});
		const sandbox = res.result.structuredContent.sandbox;
		assert.strictEqual(sandbox.available, false);
		assert.match(sandbox.reason, /bubblewrap/);
		assert.strictEqual(sandbox.default, "none");
		assert.strictEqual(sandbox.minimum, "none");
	});

	test("with minimum none the worker runs unsandboxed and the result warns", async () => {
		const server = await start();
		const res = await server.callTool("spawn_worker", { cwd: iso.cwd });
		assert.notStrictEqual(res.result.isError, true, textOf(res.result));
		const s = res.result.structuredContent;
		assert.strictEqual(s.worker.sandbox, "none");
		assert.match(s.notes.join(" "), /WITHOUT a sandbox/);
		await server.callTool("terminate_worker", {
			workerId: s.worker.workerId,
		});
	});

	test("asking for none on purpose is not a warning", async () => {
		const server = await start();
		const res = await server.callTool("spawn_worker", {
			cwd: iso.cwd,
			sandbox: "none",
		});
		assert.deepStrictEqual(res.result.structuredContent.notes, []);
		await server.callTool("terminate_worker", {
			workerId: res.result.structuredContent.worker.workerId,
		});
	});

	test("with minimum workspace the spawn fails with SANDBOX_UNAVAILABLE", async () => {
		iso.env.WORKER_MCP_SANDBOX_MINIMUM = "workspace";
		try {
			const server = await start();
			for (const args of [{}, { sandbox: "none" }]) {
				const res = await server.callTool("spawn_worker", {
					cwd: iso.cwd,
					...args,
				});
				assert.strictEqual(res.result.isError, true);
				assert.match(textOf(res.result), /^SANDBOX_UNAVAILABLE: .+\. .+/);
			}
		} finally {
			delete iso.env.WORKER_MCP_SANDBOX_MINIMUM;
		}
	});
});
