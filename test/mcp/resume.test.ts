import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { loadConfig } from "../../src/config.js";
import { BootRegistry } from "../../src/core/boots.js";
import { WorkerStore } from "../../src/core/worker-store.js";
import { ToolError } from "../../src/errors.js";
import { RiskLevel } from "../../src/gate/risk.js";
import {
	SessionManager,
	type ManagerOptions,
} from "../../src/session/session-manager.js";
import type { Session } from "../../src/session/session.js";
import {
	createIsolation,
	type Isolation,
	waitUntil,
} from "../helpers/isolation.js";

const CODE_WORD = "CODEWORD-7QX";
/** A call the gate lets through on its own, so the kill hits a running tool. */
const SLEEP = "scenario:bash:sleep 30";
const NOTE_START = "[worker-mcp] This worker was resumed";

let iso: Isolation;
const managers: SessionManager[] = [];
beforeEach(() => {
	iso = createIsolation();
});
afterEach(async () => {
	for (const m of managers.splice(0)) await m.terminateAll();
	await iso.cleanup();
});

const stateDir = () => path.join(iso.env.XDG_STATE_HOME, "worker-mcp");
const workersDir = () => path.join(stateDir(), "workers");

/** One server process on the shared state directory. */
function manager(
	extraEnv: Record<string, string> = {},
	options: ManagerOptions = {},
): SessionManager {
	const env = { ...iso.env, ...extraEnv };
	const m = new SessionManager(
		loadConfig([], env).config,
		env,
		undefined,
		options,
	);
	m.start();
	managers.push(m);
	return m;
}

async function say(s: Session, prompt: string): Promise<string | null> {
	const run = await s.startRun(prompt, "test");
	return await s.waitText(run, { timeoutMs: 15_000 });
}

/** A worker that says a code word, then dies in the middle of a tool call. */
async function killedMidTool(
	opts: {
		cwd?: string;
		policy?: unknown;
		extraEnv?: Record<string, string>;
	} = {},
): Promise<{ m: SessionManager; id: string }> {
	const m = manager({
		FAKE_PI_SESSION_KILL: "after-gate",
		...opts.extraEnv,
	});
	const s = await m.createSession(
		undefined,
		opts.cwd ?? iso.cwd,
		"zai/glm-test",
		undefined,
		opts.policy,
	);
	await say(s, `remember ${CODE_WORD}`);
	const run = await s.startRun(SLEEP, "test");
	await assert.rejects(
		s.waitText(run, { timeoutMs: 15_000 }),
		/exited unexpectedly/,
	);
	await waitUntil(() => !s.isAlive(), 5000, "the worker to be gone");
	return { m, id: s.sessionId };
}

const userMessages = (lineage: string): string[] => {
	const dir = path.join(workersDir(), lineage, "session");
	const [file] = fs.readdirSync(dir);
	return fs
		.readFileSync(path.join(dir, file), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.filter((e) => e.type === "message" && e.message?.role === "user")
		.map((e) =>
			e.message.content.map((c: { text: string }) => c.text).join(""),
		);
};

const record = (lineage: string) =>
	JSON.parse(
		fs.readFileSync(path.join(workersDir(), lineage, "worker.json"), "utf8"),
	);
const writeRecord = (lineage: string, rec: unknown) =>
	fs.writeFileSync(
		path.join(workersDir(), lineage, "worker.json"),
		JSON.stringify(rec),
	);
const sessionFile = (lineage: string) => {
	const dir = path.join(workersDir(), lineage, "session");
	return path.join(dir, fs.readdirSync(dir)[0]);
};
const auditEntries = (): Record<string, any>[] => {
	const file = loadConfig([], iso.env).config.audit.file;
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
};

/** Resume on a throwaway server and close it again (a clean close keeps the conversation). */
async function resumeAndClose(
	args: Parameters<SessionManager["resumeSession"]>[0],
	env: Record<string, string> = {},
): Promise<Session> {
	const m = manager(env);
	const r = await m.resumeSession(args);
	await m.terminateAll();
	return r;
}

/** The test process as a third server of the state directory. */
function third() {
	const bootId = "cccccccccccc";
	const boots = new BootRegistry(path.join(stateDir(), "boots"), bootId);
	boots.register();
	return new WorkerStore({ dir: workersDir(), bootId, boots });
}

async function refused(
	p: Promise<unknown>,
	code: string,
	re: RegExp,
): Promise<void> {
	await assert.rejects(p, (e: unknown) => {
		assert.ok(e instanceof ToolError, String(e));
		assert.strictEqual(e.code, code, e.message);
		assert.match(e.message, re);
		return true;
	});
}

describe("a worker killed in the middle of a tool call", () => {
	test("resumes by worker id: the note, the statuses, the context", async () => {
		const { id } = await killedMidTool();
		const b = manager();
		const r = await b.resumeSession({ resumeFrom: id });

		assert.notStrictEqual(r.sessionId, id, "a new worker id");
		assert.strictEqual(r.lineage, id);
		assert.strictEqual(r.resumed?.from, id);
		const calls = r.resumed?.interrupted ?? [];
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].tool, "bash");
		assert.strictEqual(calls[0].status, "approved_started");
		assert.match(calls[0].untrustedPreview, /sleep 30/);

		// nothing runs until the caller sends a prompt, and the old worker's
		// record now lists both ids
		assert.strictEqual(r.status, "IDLE");
		assert.deepStrictEqual(record(id).ids, [id, r.sessionId]);
		assert.strictEqual(record(id).lastBootId, b.boot.id);
		const owner = JSON.parse(
			fs.readFileSync(path.join(workersDir(), id, "owner"), "utf8"),
		);
		assert.strictEqual(owner.bootId, b.boot.id);

		// the first prompt has the note, the second does not
		assert.match(
			(await say(r, "scenario:recall")) ?? "",
			new RegExp(CODE_WORD),
			"the context came back",
		);
		await say(r, "scenario:recall");
		const said = userMessages(id);
		assert.strictEqual(said.length, 4);
		assert.ok(said[2].startsWith(NOTE_START), said[2]);
		assert.match(said[2], /bash \(approved, started\): result unknown/);
		assert.match(said[2], /Do not repeat a call that may have run/);
		assert.ok(said[2].endsWith("\n\nscenario:recall"));
		assert.ok(!said[3].startsWith("[worker-mcp]"), "only the first prompt");
		// pi got the recorded model again, and the same session
		const models = fs
			.readFileSync(iso.recordFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
			.filter((l) => l.kind === "recv" && l.type === "set_model");
		assert.strictEqual(models.length, 2);
		assert.strictEqual(models[1].modelId, "glm-test");
		const starts = iso.starts();
		const last = starts[starts.length - 1];
		assert.strictEqual(last.argv[last.argv.indexOf("--session-id") + 1], id);
		assert.ok(!last.argv.includes("--no-session"));
	});

	test("the audit log has a resume entry with metadata only", async () => {
		const { id } = await killedMidTool();
		const b = manager();
		const r = await b.resumeSession({ resumeFrom: id });
		const entry = auditEntries().find((e) => e.kind === "resume");
		assert.ok(entry);
		assert.strictEqual(entry.workerId, r.sessionId);
		assert.strictEqual(entry.resumedFrom, id);
		assert.strictEqual(entry.lineage, id);
		assert.strictEqual(entry.bootId, b.boot.id);
		assert.strictEqual(entry.interrupted.length, 1);
		assert.strictEqual(entry.interrupted[0].status, "approved_started");
		assert.match(entry.interrupted[0].digest, /^[0-9a-f]{64}$/);
		assert.ok(!JSON.stringify(entry).includes("sleep 30"));
	});
});

describe("what the current server decides", () => {
	test("the policy is clamped to today's ceiling, and the result says so", async () => {
		const { id } = await killedMidTool({
			extraEnv: { WORKER_MCP_MAX_AUTO_APPROVE: "HIGH" },
			policy: { autoApproveUpTo: "HIGH" },
		});
		assert.deepStrictEqual(record(id).policy, { autoApproveUpTo: "HIGH" });
		// the default ceiling is MEDIUM
		const b = manager();
		const r = await b.resumeSession({ resumeFrom: id });
		assert.strictEqual(RiskLevel[r.riskPolicy.autoApproveUpTo], "MEDIUM");
		assert.ok(
			(r.policyReport?.clamped ?? []).some((c) => /HIGH/.test(c)),
			JSON.stringify(r.policyReport),
		);
		// a policy given again is clamped the same way, and wins over the record
		await b.terminateAll();
		const r2 = await manager().resumeSession({
			resumeFrom: id,
			riskPolicy: { autoApproveUpTo: "LOW" },
		});
		assert.strictEqual(RiskLevel[r2.riskPolicy.autoApproveUpTo], "LOW");
	});

	test("a resume never runs with a weaker sandbox than the worker had, unless asked and allowed", async () => {
		const { id } = await killedMidTool();
		// the worker had the workspace sandbox
		const rec = record(id);
		rec.sandbox = { requested: "workspace", applied: "workspace" };
		writeRecord(id, rec);
		const nobwrap = { WORKER_MCP_BWRAP: "/nonexistent/bwrap" };
		const b = manager(nobwrap);
		await refused(
			b.resumeSession({ resumeFrom: id }),
			"SANDBOX_UNAVAILABLE",
			/sandbox/i,
		);
		// the failed attempt did not keep the claim
		const weaker = await b.resumeSession({ resumeFrom: id, sandbox: "none" });
		assert.strictEqual(weaker.sandbox, "none");
		// a server that requires the sandbox refuses even that
		await b.terminateAll();
		const strict = manager({
			...nobwrap,
			WORKER_MCP_SANDBOX_DEFAULT: "workspace",
			WORKER_MCP_SANDBOX_MINIMUM: "workspace",
		});
		await refused(
			strict.resumeSession({ resumeFrom: id, sandbox: "none" }),
			"SANDBOX_UNAVAILABLE",
			/sandbox/i,
		);
	});

	test("a raised sandbox minimum applies to a worker that had none", async () => {
		const { id } = await killedMidTool();
		assert.strictEqual(record(id).sandbox.applied, "none");
		const strict = manager({
			WORKER_MCP_BWRAP: "/nonexistent/bwrap",
			WORKER_MCP_SANDBOX_DEFAULT: "workspace",
			WORKER_MCP_SANDBOX_MINIMUM: "workspace",
		});
		await refused(
			strict.resumeSession({ resumeFrom: id }),
			"SANDBOX_UNAVAILABLE",
			/minimum is workspace/,
		);
		// and nothing was started or left claimed
		assert.strictEqual(iso.starts().length, 1);
		const ok = await manager().resumeSession({ resumeFrom: id });
		assert.strictEqual(ok.status, "IDLE");
	});

	test("no old approval and no remembered decision comes back", async () => {
		const { id } = await killedMidTool();
		const b = manager();
		const r = await b.resumeSession({ resumeFrom: id });
		assert.strictEqual(r.pendingActions.length, 0);
		assert.strictEqual(r.getGateLog().length, 0);
		assert.strictEqual(r.getAutoApprovedLog().length, 0);
		const text = fs.readFileSync(
			path.join(workersDir(), id, "worker.json"),
			"utf8",
		);
		assert.ok(
			!/remember|approval/i.test(text),
			"the record holds no approvals",
		);
	});
});

describe("the workspace", () => {
	test("a moved or different directory is refused", async () => {
		const { id } = await killedMidTool();
		const elsewhere = path.join(iso.root, "elsewhere");
		fs.mkdirSync(elsewhere);
		await refused(
			manager().resumeSession({ resumeFrom: id, cwd: elsewhere }),
			"CWD_NOT_ALLOWED",
			/was started in/,
		);
		// the record and the session header must both agree with the directory
		const rec = record(id);
		rec.cwd = fs.realpathSync(elsewhere);
		writeRecord(id, rec);
		await refused(
			manager().resumeSession({ resumeFrom: id, cwd: elsewhere }),
			"CWD_NOT_ALLOWED",
			/another directory/,
		);
	});

	test("a workspace that is gone, or outside the allowed roots, is refused", async () => {
		const { id } = await killedMidTool();
		const other = path.join(iso.root, "other-root");
		fs.mkdirSync(other);
		await refused(
			manager({ WORKER_MCP_ALLOWED_ROOTS: other }).resumeSession({
				resumeFrom: id,
			}),
			"CWD_NOT_ALLOWED",
			/outside the directories/,
		);
		fs.rmSync(iso.cwd, { recursive: true });
		await refused(
			manager().resumeSession({ resumeFrom: id }),
			"CWD_NOT_ALLOWED",
			/does not exist/,
		);
	});

	test("the directory may be given when it is the same one", async () => {
		const { id } = await killedMidTool();
		const r = await manager().resumeSession({ resumeFrom: id, cwd: iso.cwd });
		assert.strictEqual(r.cwd, fs.realpathSync(iso.cwd));
	});
});

describe("who holds the conversation", () => {
	test("a live owner is refused; once it lets go, the resume works", async () => {
		const { id } = await killedMidTool();
		const t = third();
		t.claim(id);
		await refused(
			manager().resumeSession({ resumeFrom: id }),
			"WORKER_BUSY",
			/live in another worker-mcp server/,
		);
		t.release(id);
		const r = await manager().resumeSession({ resumeFrom: id });
		assert.strictEqual(r.lineage, id);
	});

	test("a stale owner is taken over", async () => {
		const { id } = await killedMidTool();
		fs.writeFileSync(
			path.join(workersDir(), id, "owner"),
			`${JSON.stringify({ bootId: "dddddddddddd", pid: 4194000 })}\n`,
			{ mode: 0o600 },
		);
		const b = manager();
		const r = await b.resumeSession({ resumeFrom: id });
		assert.strictEqual(r.lineage, id);
		const owner = JSON.parse(
			fs.readFileSync(path.join(workersDir(), id, "owner"), "utf8"),
		);
		assert.strictEqual(owner.bootId, b.boot.id);
	});

	test("resuming twice in a row keeps the lineage; a live worker is not resumed again", async () => {
		const { id } = await killedMidTool();
		const b = manager();
		const r1 = await b.resumeSession({ resumeFrom: id });
		await say(r1, "scenario:echo first");
		// live here: use start_run
		await refused(
			b.resumeSession({ resumeFrom: id }),
			"WORKER_BUSY",
			new RegExp(`${r1.sessionId} is live`),
		);
		// live in another server
		await refused(
			manager().resumeSession({ resumeFrom: r1.sessionId }),
			"WORKER_BUSY",
			/live in another worker-mcp server/,
		);
		// closed (a clean shutdown keeps the session): resume again, from the
		// first id or the second
		await b.terminateAll();
		const c = manager();
		const r2 = await c.resumeSession({ resumeFrom: r1.sessionId });
		assert.strictEqual(r2.lineage, id);
		assert.strictEqual(r2.resumed?.from, r1.sessionId);
		// the last turn ended cleanly: nothing was cut off
		assert.deepStrictEqual(r2.resumed?.interrupted, []);
		assert.match(
			(await say(r2, "scenario:recall")) ?? "",
			new RegExp(CODE_WORD),
		);
		const said = userMessages(id);
		assert.ok(said.some((m) => m.startsWith(NOTE_START)));
		// the second resume's note says nothing was cut off: the first resumed
		// run completed, so the old call is dealt with
		assert.match(said.at(-1) ?? "", /^\[worker-mcp\] .*not cut off/);
		assert.match(said.at(-2) ?? "", /Your last turn was cut off/);
		assert.deepStrictEqual(record(id).ids, [id, r1.sessionId, r2.sessionId]);
		await c.terminateAll();
		const r3 = await manager().resumeSession({ resumeFrom: id });
		assert.strictEqual(r3.lineage, id);
		assert.deepStrictEqual(record(id).ids.length, 4);
	});
});

describe("a saved conversation that cannot be trusted", () => {
	test("a damaged line in the middle is refused, never left to be dropped silently", async () => {
		const { id } = await killedMidTool();
		const file = sessionFile(id);
		const lines = fs.readFileSync(file, "utf8").split("\n");
		lines[3] = "{ this is not json";
		fs.writeFileSync(file, lines.join("\n"));
		await refused(
			manager().resumeSession({ resumeFrom: id }),
			"INVALID_ARGUMENT",
			/line 4 of the session is damaged/,
		);
		// the refusal released the conversation
		fs.writeFileSync(file, fs.readFileSync(file, "utf8"));
		assert.strictEqual(iso.starts().length, 1, "nothing was started");
	});

	test("a torn last line is accepted, with a note", async () => {
		const { id } = await killedMidTool();
		fs.appendFileSync(sessionFile(id), '{"type":"message","id":"half');
		const r = await manager().resumeSession({ resumeFrom: id });
		assert.ok(
			(r.resumed?.notes ?? []).some((n) => /last line .* incomplete/.test(n)),
			JSON.stringify(r.resumed?.notes),
		);
		assert.strictEqual(r.resumed?.interrupted.length, 1);
	});

	test("an unreadable header, an unknown format, a missing file", async () => {
		const { id } = await killedMidTool();
		const file = sessionFile(id);
		const original = fs.readFileSync(file, "utf8");
		const lines = original.split("\n");
		const b = manager();

		fs.writeFileSync(file, `garbage\n${lines.slice(1).join("\n")}`);
		await refused(
			b.resumeSession({ resumeFrom: id }),
			"INVALID_ARGUMENT",
			/header cannot be read/,
		);
		const header = JSON.parse(lines[0]);
		fs.writeFileSync(
			file,
			`${JSON.stringify({ ...header, version: 2 })}\n${lines.slice(1).join("\n")}`,
		);
		await refused(
			b.resumeSession({ resumeFrom: id }),
			"INVALID_ARGUMENT",
			/format is 2, not 3/,
		);
		fs.rmSync(file);
		await refused(
			b.resumeSession({ resumeFrom: id }),
			"WORKER_NOT_FOUND",
			/Nothing to resume/,
		);
	});

	test("a rewritten start of the file fails the checkpoint", async () => {
		const { id } = await killedMidTool();
		assert.ok(record(id).checkpoint, "a settled run left a checkpoint");
		const file = sessionFile(id);
		const text = fs.readFileSync(file, "utf8");
		// still valid JSON, and still the same length
		fs.writeFileSync(file, text.replace(CODE_WORD, "CODEWORD-7QY"));
		await refused(
			manager().resumeSession({ resumeFrom: id }),
			"INVALID_ARGUMENT",
			/cannot be trusted: the start of the session file changed/,
		);
		// appended text (the interrupted run's tail) is not a change
		fs.writeFileSync(file, text);
		fs.appendFileSync(file, "");
		assert.ok(await manager().resumeSession({ resumeFrom: id }));
	});

	test("a different pi version is a warning, not a refusal", async () => {
		const { id } = await killedMidTool();
		const rec = record(id);
		assert.match(rec.providerVersion, /fake-pi/);
		writeRecord(id, { ...rec, providerVersion: "0.1.0" });
		const vm = manager();
		const r = await vm.resumeSession({ resumeFrom: id });
		assert.strictEqual(r.resumed?.providerVersion.changed, true);
		assert.strictEqual(r.resumed?.providerVersion.recorded, "0.1.0");
		assert.match(r.resumed?.providerVersion.now ?? "", /fake-pi/);
		assert.ok((r.resumed?.notes ?? []).some((n) => /0\.1\.0/.test(n)));
		// the same version: no warning
		await vm.terminateAll();
		const same = await manager().resumeSession({ resumeFrom: r.sessionId });
		assert.strictEqual(same.resumed?.providerVersion.changed, false);
	});
});

describe("what cannot be resumed", () => {
	test("persistence off for the server, or for the worker", async () => {
		const off = manager({ WORKER_MCP_PERSIST_SESSIONS: "off" });
		await refused(
			off.resumeSession({ resumeFrom: "w_abcd1234" }),
			"INVALID_ARGUMENT",
			/persistSessions is off/,
		);
		const m = manager();
		const s = await m.createSession(
			undefined,
			iso.cwd,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
		);
		await say(s, "hello");
		await s.terminate();
		await refused(
			manager().resumeSession({ resumeFrom: s.sessionId }),
			"WORKER_NOT_FOUND",
			/conversation was not kept/,
		);
		await refused(
			m.resumeSession({ resumeFrom: s.sessionId, persistSession: false }),
			"INVALID_ARGUMENT",
			/persistSession: false cannot be combined/,
		);
	});

	test("a terminated worker's conversation is gone; a worker that never had a prompt has none", async () => {
		const m = manager();
		const a = await m.createSession(undefined, iso.cwd);
		await say(a, "hello");
		await m.terminateSession(a.sessionId);
		await refused(
			m.resumeSession({ resumeFrom: a.sessionId }),
			"WORKER_NOT_FOUND",
			/terminating a worker deletes it/,
		);
		const idle = await m.createSession(undefined, iso.cwd);
		await m.terminateAll();
		await refused(
			manager().resumeSession({ resumeFrom: idle.sessionId }),
			"WORKER_NOT_FOUND",
			/Nothing to resume: the worker has no saved conversation/,
		);
		await refused(
			manager().resumeSession({ resumeFrom: "r_abcdefghij12" }),
			"RUN_NOT_FOUND",
			/nothing to resume it from|not issued/,
		);
	});
});

describe("by run id", () => {
	test("any run of the worker, from an earlier server", async () => {
		const { m, id } = await killedMidTool();
		const runs = m.runs.runsOf(id);
		assert.strictEqual(runs.length, 2);
		assert.strictEqual(record(id).lastRunId, runs[1].id);
		assert.deepStrictEqual(
			record(id).runIds,
			runs.map((r) => r.id),
		);
		for (const run of runs) {
			assert.strictEqual(
				(await resumeAndClose({ resumeFrom: run.id })).lineage,
				id,
			);
		}
	});

	test("an idle-closed worker of this server, by id and by run id", async () => {
		let skew = 0;
		const m = manager({}, { now: () => Date.now() + skew });
		const s = await m.createSession(undefined, iso.cwd);
		await say(s, `remember ${CODE_WORD}`);
		const runId = m.runs.runsOf(s.sessionId)[0].id;
		skew = 2 * 3_600_000;
		await m.reapIdle();
		assert.throws(() => m.getSession(s.sessionId), /resumeFrom: "w_/);
		const r = await m.resumeSession({ resumeFrom: runId });
		assert.strictEqual(r.resumed?.from, s.sessionId);
		assert.match(
			(await say(r, "scenario:recall")) ?? "",
			new RegExp(CODE_WORD),
		);
	});
});
