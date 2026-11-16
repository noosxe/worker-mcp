import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import { gatedBash } from "../helpers/behaviour.js";
import {
	createIsolation,
	type Isolation,
	waitUntil,
} from "../helpers/isolation.js";
import { RawServer } from "../helpers/stdio.js";
import { TOOLS } from "../helpers/tools.js";

const data = async (server: RawServer, tool: string, args: object) => {
	const res = await server.callTool(tool, args);
	assert.ok(res.result, JSON.stringify(res));
	return res.result as {
		isError?: boolean;
		structuredContent?: any;
		content: { text: string }[];
	};
};

const kill = async (server: RawServer) => {
	server.child.kill("SIGKILL");
	await server.exited;
};

const call = async (s: RawServer, tool: string, args: object) =>
	(await s.callTool(tool, args)).result;

const ok = async (server: RawServer, tool: string, args: object) => {
	const r = await data(server, tool, args);
	assert.notStrictEqual(r.isError, true, r.content[0]?.text);
	return r.structuredContent;
};

/** Run a prompt until it ends or asks; returns the view. */
async function run(server: RawServer, worker: string, prompt: string) {
	let view = await ok(server, TOOLS.startRun, {
		workerId: worker,
		prompt,
		waitMs: 3000,
	});
	const deadline = Date.now() + 20_000;
	while (
		view.state !== "completed" &&
		view.state !== "awaiting_approval" &&
		view.state !== "running" &&
		Date.now() < deadline
	) {
		view = await ok(server, TOOLS.waitRun, {
			runId: view.runId,
			waitMs: 3000,
			sinceSeq: view.seq,
		});
	}
	return view;
}

/**
 * Real server processes sharing one state directory, killed with SIGKILL so
 * nothing is cleaned up, like a crash or a client that restarts its server.
 */
describe("run records across a restart", () => {
	let iso: Isolation;
	const servers: RawServer[] = [];

	before(() => {
		iso = createIsolation();
	});
	after(async () => {
		for (const s of servers) await s.dispose();
		await iso.cleanup();
	});

	const stateDir = () => path.join(iso.env.XDG_STATE_HOME, "worker-mcp");
	const auditEntries = (): Record<string, any>[] => {
		const file = path.join(stateDir(), "audit.jsonl");
		return fs.existsSync(file)
			? fs
					.readFileSync(file, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l))
			: [];
	};

	async function start(env: Record<string, string> = {}): Promise<RawServer> {
		const server = new RawServer({ ...iso, env: { ...iso.env, ...env } });
		servers.push(server);
		await server.initialize();
		return server;
	}

	async function spawn(server: RawServer, name: string) {
		return (await ok(server, TOOLS.spawn, { name, cwd: iso.cwd })).worker
			.workerId as string;
	}

	test("a finished run is readable, an unfinished one is interrupted, a pending approval is abandoned", async () => {
		const first = await start();
		const done = await run(
			first,
			await spawn(first, "done"),
			"scenario:echo hi there",
		);
		assert.strictEqual(done.state, "completed");
		const mid = await run(
			first,
			await spawn(first, "mid"),
			"scenario:slow:60000 long task",
		);
		assert.strictEqual(mid.state, "running");
		const asking = await run(
			first,
			await spawn(first, "asking"),
			gatedBash("rm -rf build"),
		);
		assert.strictEqual(asking.state, "awaiting_approval");
		const approvalId = asking.pendingApprovals[0].approvalId;
		const oldBoot = (await ok(first, "list_providers", {})).server.bootId;
		await kill(first);

		const unresolved = auditEntries().filter(
			(e) => e.decision === "escalate" && e.approvalId === approvalId,
		);
		assert.strictEqual(unresolved.length, 1);

		const second = await start();
		const newBoot = (await ok(second, "list_providers", {})).server.bootId;
		assert.notStrictEqual(newBoot, oldBoot);

		// A completed run: its text, marked as from an earlier server.
		const read = await ok(second, TOOLS.getRun, { runId: done.runId });
		assert.strictEqual(read.state, "completed");
		assert.match(read.untrustedFinalText, /fake-pi reply: hi there/);
		assert.strictEqual(read.persisted.fromEarlierServer, true);
		assert.strictEqual(read.persisted.bootId, oldBoot);
		assert.strictEqual(read.persisted.serverRunning, false);
		assert.deepStrictEqual(read.pendingApprovals, []);
		assert.strictEqual(read.output.more, false);

		// wait_run on it returns at once, with the same state.
		const began = Date.now();
		const waited = await ok(second, TOOLS.waitRun, {
			runId: done.runId,
			waitMs: 30_000,
		});
		assert.ok(Date.now() - began < 5000);
		assert.strictEqual(waited.state, "completed");

		// A run cut off mid-way.
		const cut = await ok(second, TOOLS.getRun, { runId: mid.runId });
		assert.strictEqual(cut.state, "interrupted");
		assert.match(
			cut.error,
			new RegExp(
				`^the server stopped while this run was in progress \\(boot ${oldBoot}\\); what the worker did before that is in the workspace$`,
			),
		);
		assert.strictEqual(
			(await ok(second, TOOLS.waitRun, { runId: mid.runId, waitMs: 30_000 }))
				.state,
			"interrupted",
		);

		// A run that was waiting for an approval: interrupted, the approval abandoned.
		const asked = await ok(second, TOOLS.getRun, { runId: asking.runId });
		assert.strictEqual(asked.state, "interrupted");
		assert.deepStrictEqual(
			asked.persisted.untrustedApprovals.map((a: any) => [
				a.approvalId,
				a.decision,
			]),
			[[approvalId, "abandoned"]],
		);
		assert.deepStrictEqual(asked.pendingApprovals, []);

		// The audit log closes the escalation, once, and says which boot.
		const closed = auditEntries().filter(
			(e) =>
				e.requestId === unresolved[0].requestId && e.decision !== "escalate",
		);
		assert.strictEqual(closed.length, 1);
		assert.strictEqual(closed[0].decision, "deny");
		assert.strictEqual(closed[0].decidedBy, "abandoned");
		assert.strictEqual(closed[0].bootId, oldBoot);
		assert.strictEqual(closed[0].closedByBootId, newBoot);
		assert.match(closed[0].reason, new RegExp(oldBoot));

		// Writes need the server that made the id: these still refuse it.
		for (const [tool, args, code] of [
			[TOOLS.approve, { approvalId }, "APPROVAL_NOT_FOUND"],
			[TOOLS.reject, { approvalId, reason: "no" }, "APPROVAL_NOT_FOUND"],
			[TOOLS.cancelRun, { runId: mid.runId }, "RUN_NOT_FOUND"],
			[TOOLS.pending, { runId: mid.runId }, "RUN_NOT_FOUND"],
			[
				TOOLS.startRun,
				{ workerId: done.workerId, prompt: "x" },
				"WORKER_NOT_FOUND",
			],
		] as const) {
			const r = await data(second, tool, args);
			assert.strictEqual(r.isError, true, tool);
			assert.ok(r.content[0].text.startsWith(`${code}: `), r.content[0].text);
			assert.match(r.content[0].text, /not issued by the server running now/);
		}
		const cancel = await data(second, TOOLS.cancelRun, { runId: mid.runId });
		assert.match(cancel.content[0].text, /get_run/);

		// list_workers stays about live workers.
		assert.deepStrictEqual((await ok(second, TOOLS.list, {})).workers, []);

		// A restart again changes nothing: the abandoned entry is not doubled.
		await kill(second);
		const third = await start();
		await ok(third, "list_providers", {});
		assert.strictEqual(
			auditEntries().filter(
				(e) =>
					e.requestId === unresolved[0].requestId && e.decision !== "escalate",
			).length,
			1,
		);
		assert.strictEqual(
			(await ok(third, TOOLS.getRun, { runId: mid.runId })).state,
			"interrupted",
		);
		await kill(third);
	});

	test("the files are private", () => {
		const dirs = [
			path.join(stateDir(), "runs"),
			path.join(stateDir(), "boots"),
		];
		for (const dir of dirs) {
			assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700, dir);
		}
		const files = fs.readdirSync(dirs[0]);
		assert.ok(files.length >= 3);
		for (const f of files) {
			assert.match(f, /^r_[A-Za-z0-9]+\.json$/);
			assert.strictEqual(
				fs.statSync(path.join(dirs[0], f)).mode & 0o777,
				0o600,
			);
		}
		// The prompt is not in any of them.
		for (const f of files) {
			const text = fs.readFileSync(path.join(dirs[0], f), "utf8");
			assert.doesNotMatch(text, /rm -rf build|long task/);
		}
	});

	test("two live servers on one state directory do not touch each other", async () => {
		const a = await start();
		const worker = await spawn(a, "a-worker");
		const long = await run(a, worker, "scenario:slow:60000 still going");
		assert.strictEqual(long.state, "running");
		const askerWorker = await spawn(a, "a-asker");
		const asking = await run(a, askerWorker, gatedBash("rm -rf other"));
		assert.strictEqual(asking.state, "awaiting_approval");
		const approvalId = asking.pendingApprovals[0].approvalId;

		const b = await start();
		await ok(b, "list_providers", {});
		// B starting did not close what A is doing.
		const seen = await ok(b, TOOLS.getRun, { runId: long.runId });
		assert.strictEqual(seen.state, "running");
		assert.strictEqual(seen.persisted.serverRunning, true);
		assert.strictEqual(seen.persisted.fromEarlierServer, true);
		const aView = await ok(a, TOOLS.getRun, { runId: long.runId });
		assert.strictEqual(aView.state, "running");
		assert.strictEqual(aView.persisted, undefined);
		assert.ok(
			!auditEntries().some(
				(e) => e.approvalId === approvalId && e.decidedBy === "abandoned",
			),
		);
		// A's approval still works on A.
		const answered = await ok(a, TOOLS.reject, { approvalId, reason: "no" });
		assert.strictEqual(answered.outcome, "rejected");

		// When A dies, a server that starts afterwards sees it as gone.
		await kill(a);
		const c = await start();
		await ok(c, "list_providers", {});
		assert.strictEqual(
			(await ok(c, TOOLS.getRun, { runId: long.runId })).state,
			"interrupted",
		);
		await kill(b);
		await kill(c);
	});
});

describe("run records can be turned off", () => {
	let iso: Isolation;
	const servers: RawServer[] = [];
	before(() => {
		iso = createIsolation();
		iso.env.WORKER_MCP_PERSIST_RUNS = "off";
	});
	after(async () => {
		for (const s of servers) await s.dispose();
		await iso.cleanup();
	});

	test("nothing is written, old ids are not found, and abandoned approvals are still closed", async () => {
		const state = path.join(iso.env.XDG_STATE_HOME, "worker-mcp");
		const begin = async () => {
			const s = new RawServer(iso);
			servers.push(s);
			await s.initialize();
			return s;
		};
		const first = await begin();
		const w = await call(first, TOOLS.spawn, { name: "w", cwd: iso.cwd });
		let view = await call(first, TOOLS.startRun, {
			workerId: "w",
			prompt: gatedBash("rm -rf x"),
			waitMs: 3000,
		});
		await waitUntil(
			async () => {
				view = await call(first, TOOLS.waitRun, {
					runId: view.structuredContent.runId,
					waitMs: 1000,
				});
				return view.structuredContent.state === "awaiting_approval";
			},
			10_000,
			"approval",
		);
		const runId = view.structuredContent.runId;
		assert.ok(w.structuredContent);
		first.child.kill("SIGKILL");
		await first.exited;

		const second = await begin();
		const read = await call(second, TOOLS.getRun, { runId });
		assert.strictEqual(read.isError, true);
		assert.match(read.content[0].text, /^RUN_NOT_FOUND: /);
		assert.ok(!fs.existsSync(path.join(state, "runs")));
		const entries = fs
			.readFileSync(path.join(state, "audit.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		assert.ok(
			entries.some((e) => e.decidedBy === "abandoned" && e.decision === "deny"),
		);
		second.child.kill("SIGKILL");
		await second.exited;
	});
});
