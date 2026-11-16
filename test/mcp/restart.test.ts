import assert from "node:assert";
import { describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadConfig } from "../../src/config.js";
import { Boot } from "../../src/ids.js";
import { stderrQuote } from "../../src/providers/pi/provider.js";
import { createServer } from "../../src/server.js";
import { SessionManager } from "../../src/session/session-manager.js";
import {
	call,
	gatedBash,
	sendAndWait,
	sendAwaiting,
	spawnWorker,
	textOf,
} from "../helpers/behaviour.js";
import { applyEnv, createIsolation } from "../helpers/isolation.js";
import { TOOLS } from "../helpers/tools.js";

interface Conn {
	client: Client;
	manager: SessionManager;
	close(): Promise<void>;
}

/** One server process: same state dir and environment each time it is made. */
async function boot(env: Record<string, string | undefined>): Promise<Conn> {
	const full = { ...process.env, ...env } as Record<string, string>;
	const manager = new SessionManager(loadConfig([], full).config, full);
	const server = createServer(manager, "0.0.0-test");
	const [c, s] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([server.connect(s), client.connect(c)]);
	return {
		client,
		manager,
		async close() {
			await manager.terminateAll();
			await client.close();
		},
	};
}

const structured = async (client: Client, tool: string, args = {}) => {
	const result = await call(client, tool, args);
	assert.notStrictEqual(result.isError, true, textOf(result));
	return (result as { structuredContent: any }).structuredContent;
};

const serverOf = async (client: Client, tool: string) =>
	(await structured(client, tool)).server;

describe("restart: ids from an earlier server", () => {
	const iso = createIsolation();
	const restore = applyEnv(iso);
	test.after(async () => {
		restore();
		await iso.cleanup();
	});

	test("every tool says an old id came from an earlier server", async () => {
		const first = await boot(iso.env);
		const old = {
			worker: "",
			run: "",
			approval: "",
			bootId: (await serverOf(first.client, TOOLS.list)).bootId,
		};
		try {
			const w = await spawnWorker(first.client, "keeper", { cwd: iso.cwd });
			old.worker = w.worker.workerId;
			const done = await sendAndWait(
				first.client,
				"keeper",
				"scenario:echo hi",
			);
			assert.strictEqual(done.state, "completed");
			old.run = done.runId;
			await spawnWorker(first.client, "asker", { cwd: iso.cwd });
			const awaiting = await sendAwaiting(
				first.client,
				"asker",
				gatedBash("rm -rf build"),
			);
			old.approval = awaiting.pendingApprovals[0].approvalId;
		} finally {
			await first.close();
		}

		const second = await boot(iso.env);
		try {
			const now = await serverOf(second.client, TOOLS.list);
			assert.notStrictEqual(now.bootId, old.bootId);
			assert.deepStrictEqual(
				await serverOf(second.client, "list_providers"),
				now,
			);
			assert.ok(!Number.isNaN(Date.parse(now.startedAt)));

			const notIssued = /not issued by the server running now/;
			const hint = /git status/;
			const cases: [string, string, Record<string, unknown>, string][] = [
				[
					"start_run by id",
					TOOLS.startRun,
					{ workerId: old.worker, prompt: "x" },
					"WORKER_NOT_FOUND",
				],
				[
					"start_run by name",
					TOOLS.startRun,
					{ workerId: "keeper", prompt: "x" },
					"WORKER_NOT_FOUND",
				],
				[
					"list gate log",
					"get_gate_log",
					{ workerId: old.worker },
					"WORKER_NOT_FOUND",
				],
				[
					"set policy by name",
					TOOLS.setPolicy,
					{ workerId: "asker", policy: {} },
					"WORKER_NOT_FOUND",
				],
				[
					"terminate",
					TOOLS.terminate,
					{ workerId: old.worker },
					"WORKER_NOT_FOUND",
				],
				[
					"pending by worker",
					TOOLS.pending,
					{ workerId: old.worker },
					"WORKER_NOT_FOUND",
				],
				[
					"wait_run",
					TOOLS.waitRun,
					{ runId: old.run, waitMs: 0 },
					"RUN_NOT_FOUND",
				],
				["get_run", TOOLS.getRun, { runId: old.run }, "RUN_NOT_FOUND"],
				["cancel_run", TOOLS.cancelRun, { runId: old.run }, "RUN_NOT_FOUND"],
				["pending by run", TOOLS.pending, { runId: old.run }, "RUN_NOT_FOUND"],
				[
					"approve",
					TOOLS.approve,
					{ approvalId: old.approval },
					"APPROVAL_NOT_FOUND",
				],
				[
					"reject",
					TOOLS.reject,
					{ approvalId: old.approval, reason: "no" },
					"APPROVAL_NOT_FOUND",
				],
			];
			for (const [label, tool, args, code] of cases) {
				const result = await call(second.client, tool, args);
				assert.strictEqual(result.isError, true, label);
				const text = textOf(result);
				assert.ok(text.startsWith(`${code}: `), `${label}: ${text}`);
				assert.match(text, hint, label);
				assert.match(text, new RegExp(now.bootId), label);
				// Names carry no tag, so they get the "may have" wording.
				if (args.workerId === "keeper" || args.workerId === "asker") {
					assert.match(text, /spawned before the server restarted/, label);
				} else {
					assert.match(text, notIssued, label);
					assert.doesNotMatch(text, /expired/, label);
				}
			}
		} finally {
			await second.close();
		}
	});

	test("an id that expired in this process still says expired", async () => {
		const conn = await boot(iso.env);
		try {
			await spawnWorker(conn.client, "w", { cwd: iso.cwd });
			const done = await sendAndWait(conn.client, "w", "scenario:echo hi");
			// Same tag as this server, but unknown: as if the result was pruned.
			const own = done.runId.slice(0, 6) + "zzzzzzzzzzzz";
			const result = await call(conn.client, TOOLS.getRun, { runId: own });
			assert.strictEqual(result.isError, true);
			assert.match(textOf(result), /^RUN_NOT_FOUND: .*expired/);
			assert.doesNotMatch(textOf(result), /not issued/);
			const approval = await call(conn.client, TOOLS.approve, {
				approvalId: "a_" + done.runId.slice(2, 6) + "zzzzzz",
			});
			assert.match(textOf(approval), /^APPROVAL_NOT_FOUND: /);
			assert.doesNotMatch(textOf(approval), /not issued/);
		} finally {
			await conn.close();
		}
	});

	test("ids keep the documented patterns and carry the server's tag", () => {
		const a = new Boot();
		const b = new Boot();
		for (let i = 0; i < 50; i++) {
			assert.match(a.workerId(), /^w_[a-z0-9]{8}$/);
			assert.match(a.approvalId(), /^a_[a-z0-9]{10}$/);
			assert.match(a.runId(), /^r_[A-Za-z0-9]{10,32}$/);
		}
		assert.strictEqual(a.madeByEarlierServer("worker", a.workerId()), false);
		assert.strictEqual(a.madeByEarlierServer("worker", b.workerId()), true);
		assert.strictEqual(a.madeByEarlierServer("run", b.runId()), true);
		assert.strictEqual(a.madeByEarlierServer("approval", b.approvalId()), true);
	});
});

describe("dead workers", () => {
	const iso = createIsolation();
	const restore = applyEnv(iso);
	test.after(async () => {
		restore();
		await iso.cleanup();
	});

	test("a crashed worker is dropped, its run stays readable and its id says what happened", async () => {
		const conn = await boot(iso.env);
		try {
			const w = await spawnWorker(conn.client, "doomed", { cwd: iso.cwd });
			const view = await sendAndWait(
				conn.client,
				"doomed",
				"scenario:crash-noisy",
			);
			assert.strictEqual(view.state, "failed");
			// Leads with the exit, then one short quote; noise is left out.
			const error = view.error ?? "";
			assert.match(
				error,
				/^worker exited unexpectedly \(code 1\)\. Last stderr/,
			);
			assert.match(error, /fatal: could not open the session file/);
			assert.doesNotMatch(error, /npm warn|punycode|trace-deprecation/);
			assert.ok(error.length < 300, error);
			// Dropped from the list at once...
			const deadline = Date.now() + 5000;
			let listed = true;
			while (listed && Date.now() < deadline) {
				const list = (await structured(conn.client, TOOLS.list)) as {
					workers: unknown[];
				};
				listed = list.workers.length > 0;
				if (listed) await new Promise((r) => setTimeout(r, 50));
			}
			assert.strictEqual(listed, false);
			// ...its runs are still readable...
			const read = await structured(conn.client, TOOLS.getRun, {
				runId: view.runId,
			});
			assert.strictEqual((read as { state: string }).state, "failed");
			// ...and using it says it died, by id and by name, not "restart".
			for (const ref of [w.worker.workerId, "doomed"]) {
				const r = await call(conn.client, TOOLS.startRun, {
					workerId: ref,
					prompt: "again",
				});
				const text = textOf(r);
				assert.match(text, /^WORKER_NOT_FOUND: .*no longer running/);
				assert.match(text, new RegExp(view.runId));
				assert.doesNotMatch(text, /restart/);
			}
		} finally {
			await conn.close();
		}
	});
});

describe("stderrQuote", () => {
	test("skips npm and runtime noise and keeps one short line", () => {
		assert.strictEqual(stderrQuote([]), "");
		assert.strictEqual(
			stderrQuote(["npm warn deprecated x@1", "(node:1) Warning: y", ""]),
			"",
		);
		const q = stderrQuote([
			"boom",
			"npm warn exec something",
			"npm notice new version",
			"    at foo (file.js:1:1)",
		]);
		assert.match(q, /"boom"/);
		assert.match(q, /untrusted/);
		const long = stderrQuote(["x".repeat(5000)]);
		assert.ok(long.length < 260);
	});
});
