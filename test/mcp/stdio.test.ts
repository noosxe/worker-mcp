import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
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

/** The worker's text of a run result. */
const finalTextOf = (result: object) =>
	(result as { structuredContent: { untrustedFinalText: string } })
		.structuredContent.untrustedFinalText;

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

	async function spawnWorker(server: RawServer, name: string) {
		const known = iso.starts().length;
		const res = await server.callTool(TOOLS.spawn, {
			name,
			cwd: iso.cwd,
		});
		assert.notStrictEqual(res.result.isError, true, textOf(res.result));
		return (await iso.workerAfter(known)).pid;
	}

	test("stdout carries nothing but JSON-RPC", async () => {
		const server = await start();
		await spawnWorker(server, "pure");
		await server.callTool(TOOLS.startRun, {
			waitMs: 2000,
			workerId: "pure",
			prompt: "hi",
		});
		await server.callTool(TOOLS.startRun, { workerId: "nope", prompt: "hi" });
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

	test("terminate kills a worker that ignores SIGTERM", async () => {
		const server = await start();
		const pid = await spawnWorker(server, "stubborn");
		iso.allowLeak(pid); // cleanup kills it if the assertion below fails
		// The send never answers; the request is abandoned with the server.
		server
			.callTool(TOOLS.startRun, {
				workerId: "stubborn",
				prompt: "scenario:ignore-sigterm",
			})
			.catch(() => {});
		await waitUntil(
			() => iso.runs().includes("ignore-sigterm"),
			5000,
			"the scenario to start",
		);
		await server.callTool(TOOLS.terminate, { workerId: "stubborn" });
		await waitUntil(() => pidGone(pid), 3000, "fake-pi to exit");
	});

	test("terminate kills the worker's detached grandchild", async () => {
		const server = await start();
		await spawnWorker(server, "grand");
		const res = await server.callTool(TOOLS.startRun, {
			workerId: "grand",
			prompt: "scenario:grandchild",
			waitMs: 10_000,
		});
		const grandchild = Number(
			finalTextOf(res.result).match(/grandchild pid: (\d+)/)?.[1],
		);
		assert.ok(grandchild > 0);
		await server.callTool(TOOLS.terminate, { workerId: "grand" });
		await waitUntil(() => pidGone(grandchild), 2000, "grandchild to exit");
	});

	test("SIGTERM to the server kills a worker's grandchild and a worker that ignores SIGTERM", async () => {
		const server = await start();
		await spawnWorker(server, "tree");
		const res = await server.callTool(TOOLS.startRun, {
			workerId: "tree",
			prompt: "scenario:grandchild",
			waitMs: 10_000,
		});
		const grandchild = Number(
			finalTextOf(res.result).match(/grandchild pid: (\d+)/)?.[1],
		);
		assert.ok(grandchild > 0);
		const stubbornPid = await spawnWorker(server, "tree-stubborn");
		iso.allowLeak(stubbornPid); // cleanup kills it if the assertion below fails
		server
			.callTool(TOOLS.startRun, {
				workerId: "tree-stubborn",
				prompt: "scenario:ignore-sigterm",
			})
			.catch(() => {});
		await waitUntil(
			() => iso.runs().includes("ignore-sigterm"),
			5000,
			"the scenario to start",
		);
		server.child.kill("SIGTERM");
		await Promise.race([
			server.exited,
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("server did not exit")), 8000),
			),
		]);
		await waitUntil(() => pidGone(grandchild), 3000, "grandchild to exit");
		await waitUntil(
			() => pidGone(stubbornPid),
			3000,
			"stubborn worker to exit",
		);
	});
});

describe(`MCP stdio (${RUNTIME}): runtime directory recovery`, () => {
	let iso: Isolation;
	const servers: RawServer[] = [];

	before(() => {
		iso = createIsolation();
	});
	after(async () => {
		for (const server of servers) await server.dispose();
		await iso.cleanup();
	});

	async function start() {
		const server = new RawServer(iso);
		servers.push(server);
		await server.initialize();
		const dir = path.join(
			iso.env.XDG_RUNTIME_DIR as string,
			`worker-mcp-${server.child.pid}`,
		);
		return { server, dir };
	}

	const spawn = (server: RawServer, name: string) =>
		server.callTool(TOOLS.spawn, { name, cwd: iso.cwd });

	test("a deleted runtime dir is recreated at the next spawn", async () => {
		const { server, dir } = await start();
		assert.notStrictEqual((await spawn(server, "a")).result.isError, true);
		assert.ok(fs.existsSync(dir));
		fs.rmSync(dir, { recursive: true, force: true });

		const res = await spawn(server, "b");
		assert.notStrictEqual(res.result.isError, true, textOf(res.result));
		const st = fs.lstatSync(dir);
		assert.ok(st.isDirectory());
		assert.strictEqual(st.mode & 0o777, 0o700);
		assert.ok(server.stderr.join("").includes("recreated"));
	});

	test("a symlink or a wrong-mode dir in its place refuses the spawn", async () => {
		const { server, dir } = await start();
		assert.notStrictEqual((await spawn(server, "a")).result.isError, true);

		fs.rmSync(dir, { recursive: true, force: true });
		const target = path.join(iso.root, "planted");
		fs.mkdirSync(target, { mode: 0o700 });
		fs.symlinkSync(target, dir);
		let res = await spawn(server, "b");
		assert.strictEqual(res.result.isError, true);
		assert.match(textOf(res.result), /GATE_UNAVAILABLE/);
		assert.deepStrictEqual(
			fs.readdirSync(target),
			[],
			"nothing written through the link",
		);

		fs.unlinkSync(dir);
		fs.mkdirSync(dir, { mode: 0o755 });
		fs.chmodSync(dir, 0o755);
		res = await spawn(server, "c");
		assert.strictEqual(res.result.isError, true);
		assert.match(textOf(res.result), /GATE_UNAVAILABLE/);
	});

	test("terminating a worker after the dir was deleted does not fail", async () => {
		const { server, dir } = await start();
		assert.notStrictEqual((await spawn(server, "live")).result.isError, true);
		fs.rmSync(dir, { recursive: true, force: true });
		const res = await server.callTool(TOOLS.terminate, { workerId: "live" });
		assert.notStrictEqual(res.result.isError, true, textOf(res.result));
		assert.ok((await spawn(server, "after")).result.isError !== true);
	});
});
