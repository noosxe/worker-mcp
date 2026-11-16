import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";
import { SessionManager } from "../../src/session/session-manager.js";
import { call, textOf } from "../helpers/behaviour.js";
import {
	createIsolation,
	type Isolation,
	waitUntil,
} from "../helpers/isolation.js";
import { RawServer } from "../helpers/stdio.js";

let iso: Isolation;
const closers: (() => Promise<void>)[] = [];
beforeEach(() => {
	iso = createIsolation();
});
afterEach(async () => {
	// last opened, first closed
	while (closers.length > 0) await closers.pop()?.();
	await iso.cleanup();
});

const stateDir = () => path.join(iso.env.XDG_STATE_HOME, "worker-mcp");

/** One server process in this test process: same state dir each time. */
async function boot(): Promise<{ client: Client; manager: SessionManager }> {
	const manager = new SessionManager(loadConfig([], iso.env).config, iso.env);
	manager.start();
	const server = createServer(manager, "0.0.0-test");
	const [c, s] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([server.connect(s), client.connect(c)]);
	closers.push(async () => {
		await manager.terminateAll();
		await client.close();
	});
	return { client, manager };
}

const data = async (client: Client, tool: string, args = {}) => {
	const result = await call(client, tool, args);
	assert.notStrictEqual(result.isError, true, textOf(result));
	return (result as { structuredContent: any }).structuredContent;
};
const failed = async (client: Client, tool: string, args = {}) => {
	const result = await call(client, tool, args);
	assert.strictEqual(result.isError, true, "expected an error");
	return textOf(result);
};

async function finishRun(client: Client, workerId: string, prompt: string) {
	let view = await data(client, "start_run", {
		workerId,
		prompt,
		intent: "test",
		waitMs: 10_000,
	});
	for (let i = 0; i < 20 && view.state !== "completed"; i++) {
		assert.ok(
			!["failed", "cancelled", "timed_out"].includes(view.state),
			view.error,
		);
		view = await data(client, "wait_run", { runId: view.runId, waitMs: 5000 });
	}
	assert.strictEqual(view.state, "completed");
	return view;
}

describe("spawn_worker with resumeFrom, through the tools", () => {
	test("old ids say they can be resumed; get_run says so; the result has a resumed block", async () => {
		const first = await boot();
		const w = await data(first.client, "spawn_worker", {
			cwd: iso.cwd,
			name: "keeper",
		});
		const oldId = w.worker.workerId;
		const done = await finishRun(first.client, oldId, "remember CODEWORD-9");
		await first.manager.terminateAll();

		const second = await boot();
		// S4: the old id is not valid here, and the error says what can be done
		const err = await failed(second.client, "start_run", {
			workerId: oldId,
			prompt: "hello",
		});
		assert.match(err, /not issued by the server running now/);
		assert.match(err, new RegExp(`resumeFrom: "${oldId}"`));
		// the saved run says whether its worker can be resumed
		const saved = await data(second.client, "get_run", { runId: done.runId });
		assert.deepStrictEqual(saved.resume, { from: oldId, available: true });

		// no cwd is needed, and the old name is taken again
		const r = await data(second.client, "spawn_worker", { resumeFrom: oldId });
		assert.notStrictEqual(r.worker.workerId, oldId);
		assert.strictEqual(r.worker.resumedFrom, oldId);
		assert.strictEqual(r.worker.name, "keeper");
		assert.strictEqual(r.worker.cwd, fs.realpathSync(iso.cwd));
		assert.strictEqual(r.resumed.from, oldId);
		assert.strictEqual(r.resumed.lineage, oldId);
		assert.ok(r.resumed.sessionBytes > 0);
		assert.deepStrictEqual(r.resumed.interrupted.calls, []);
		assert.strictEqual(r.resumed.providerVersion.changed, false);
		assert.deepStrictEqual(r.resumed.clamped, []);
		assert.match(
			r.resumed.firstPromptNote,
			/^\[worker-mcp\] This worker was resumed/,
		);
		assert.match(r.resumed.firstPromptNote, /not cut off/);

		// the old run's record now points at a live worker
		const live = await data(second.client, "get_run", { runId: done.runId });
		assert.strictEqual(live.resume.available, false);
		assert.match(
			live.resume.reason,
			new RegExp(`live as ${r.worker.workerId}`),
		);

		const view = await finishRun(
			second.client,
			r.worker.workerId,
			"scenario:recall",
		);
		assert.match(view.untrustedFinalText, /CODEWORD-9/);

		// terminating deletes the conversation
		await data(second.client, "terminate_worker", {
			workerId: r.worker.workerId,
		});
		const gone = await data(second.client, "get_run", { runId: done.runId });
		assert.strictEqual(gone.resume.available, false);
		assert.match(gone.resume.reason, /not kept/);
	});

	test("the arguments", async () => {
		const { client } = await boot();
		assert.match(
			await failed(client, "spawn_worker", {}),
			/INVALID_ARGUMENT: cwd: required/,
		);
		assert.match(
			await failed(client, "spawn_worker", { resumeFrom: "keeper" }),
			/INVALID_ARGUMENT: resumeFrom: must be a worker id/,
		);
		assert.match(
			await failed(client, "spawn_worker", {
				resumeFrom: "w_abcd1234",
				persistSession: false,
			}),
			/INVALID_ARGUMENT: persistSession: false cannot be combined|WORKER_NOT_FOUND/,
		);
		assert.match(
			await failed(client, "spawn_worker", { resumeFrom: "w_abcd1234" }),
			/WORKER_NOT_FOUND: Nothing to resume/,
		);
	});
});

describe("a server killed while a call waited for approval", () => {
	test("the old approval is dead, the call is not replayed, the note says it never ran", async () => {
		const marker = path.join(iso.cwd, "marker");
		const a = new RawServer(iso);
		closers.push(async () => {
			await a.dispose();
		});
		await a.initialize();
		const spawned = await a.callTool("spawn_worker", { cwd: iso.cwd });
		const workerId = spawned.result.structuredContent.worker.workerId;
		// the first run completes, so there is a checkpoint
		const first = await a.callTool("start_run", {
			workerId,
			prompt: "remember CODEWORD-3",
			intent: "t",
			waitMs: 10_000,
		});
		assert.strictEqual(first.result.structuredContent.state, "completed");
		const run = await a.callTool("start_run", {
			workerId,
			prompt: `scenario:bash:touch ${marker}`,
			intent: "t",
			waitMs: 10_000,
		});
		const view = run.result.structuredContent;
		assert.strictEqual(view.state, "awaiting_approval", JSON.stringify(view));
		const oldApproval = view.pendingApprovals[0].approvalId;
		a.child.kill("SIGKILL");
		await a.exited;

		const b = await boot();
		// the run is now interrupted, and says its worker can be resumed
		const saved = await data(b.client, "get_run", { runId: view.runId });
		assert.strictEqual(saved.state, "interrupted");
		assert.strictEqual(saved.resume.available, true);
		assert.strictEqual(saved.resume.from, workerId);
		// the previous provider process may take a moment to exit
		let resumed: any;
		await waitUntil(
			async () => {
				const res = await call(b.client, "spawn_worker", {
					resumeFrom: view.runId,
				});
				if (!res.isError) {
					resumed = (res as any).structuredContent;
					return true;
				}
				assert.match(textOf(res), /WORKER_BUSY.*still exiting/);
				return false;
			},
			10_000,
			"the old process to exit",
		);
		const calls = resumed.resumed.interrupted.calls;
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].tool, "bash");
		assert.strictEqual(calls[0].status, "awaiting_approval");
		assert.strictEqual(calls[0].approvalId, oldApproval);
		assert.match(calls[0].untrustedPreview, /touch/);
		assert.strictEqual(resumed.resumed.interrupted.runId, view.runId);
		assert.match(
			resumed.resumed.firstPromptNote,
			/never approved\): it did not run/,
		);

		// the old approval is dead
		const dead = await failed(b.client, "approve_action", {
			approvalId: oldApproval,
		});
		assert.match(dead, /APPROVAL_NOT_FOUND/);
		assert.match(dead, /not issued by the server running now/);

		// nothing is replayed: a new run asks nothing, and the call never ran
		const next = await finishRun(
			b.client,
			resumed.worker.workerId,
			"scenario:recall",
		);
		assert.match(next.untrustedFinalText, /CODEWORD-3/);
		assert.ok(!fs.existsSync(marker), "the cut-off call must not run");
		const log = await data(b.client, "get_gate_log", {
			workerId: resumed.worker.workerId,
		});
		assert.deepStrictEqual(log.entries, []);

		// the audit log: the escalation was closed as abandoned, then the resume
		const audit = fs
			.readFileSync(path.join(stateDir(), "audit.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		const abandoned = audit.find((e) => e.decidedBy === "abandoned");
		assert.ok(abandoned);
		assert.strictEqual(abandoned.approvalId, oldApproval);
		const entry = audit.find((e) => e.kind === "resume");
		assert.strictEqual(entry.interrupted[0].status, "awaiting_approval");
		assert.strictEqual(entry.interrupted[0].approvalId, oldApproval);
		assert.ok(audit.indexOf(abandoned) < audit.indexOf(entry));
	});
});
