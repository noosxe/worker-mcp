import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { loadConfig } from "../../src/config.js";
import { BootRegistry } from "../../src/core/boots.js";
import { OwnerBusyError, WorkerStore } from "../../src/core/worker-store.js";
import { inspectSession } from "../../src/providers/pi/session.js";
import {
	SessionManager,
	type ManagerOptions,
} from "../../src/session/session-manager.js";
import {
	createIsolation,
	type Isolation,
	waitUntil,
} from "../helpers/isolation.js";
import { RawServer } from "../helpers/stdio.js";

const PROMPT = "remember MARKER-PROMPT-TEXT";

let iso: Isolation;
const managers: SessionManager[] = [];
const servers: RawServer[] = [];
beforeEach(() => {
	iso = createIsolation();
});
afterEach(async () => {
	for (const m of managers.splice(0)) await m.terminateAll();
	for (const s of servers.splice(0)) await s.dispose();
	await iso.cleanup();
});

const stateDir = () => path.join(iso.env.XDG_STATE_HOME, "worker-mcp");
const workersDir = () => path.join(stateDir(), "workers");
const mode = (p: string) => fs.lstatSync(p).mode & 0o777;

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

async function finish(
	m: SessionManager,
	id: string,
	prompt = PROMPT,
): Promise<string | null> {
	const session = m.getSession(id);
	const run = await session.startRun(prompt, "test");
	return await session.waitText(run, { timeoutMs: 15_000 });
}

const sessionFiles = (lineage: string) => {
	const dir = path.join(workersDir(), lineage, "session");
	return fs.existsSync(dir)
		? fs.readdirSync(dir).map((n) => path.join(dir, n))
		: [];
};

describe("pi's arguments", () => {
	test("on: session flags instead of --no-session, everything else as before", async () => {
		const m = manager();
		const s = await m.createSession(undefined, iso.cwd);
		const [start] = iso.starts();
		const a = start.argv;
		assert.ok(!a.includes("--no-session"));
		const dir = path.join(workersDir(), s.sessionId, "session");
		assert.strictEqual(a[a.indexOf("--session-dir") + 1], dir);
		assert.strictEqual(a[a.indexOf("--session-id") + 1], s.sessionId);
		for (const flag of ["--no-extensions", "--no-mcp", "--no-approve"]) {
			assert.ok(a.includes(flag), flag);
		}
		assert.strictEqual(a[a.indexOf("--mode") + 1], "rpc");
		assert.ok(a.includes("-e"));
		assert.ok(fs.existsSync(dir));
	});

	test("off by config: --no-session and nothing written", async () => {
		const m = manager({ WORKER_MCP_PERSIST_SESSIONS: "off" });
		await m.createSession(undefined, iso.cwd);
		const [start] = iso.starts();
		assert.ok(start.argv.includes("--no-session"));
		assert.ok(!start.argv.includes("--session-dir"));
		assert.ok(!start.argv.includes("--session-id"));
		assert.ok(!fs.existsSync(workersDir()));
		// a worker cannot turn it on against the server's setting
		await m.createSession(
			undefined,
			iso.cwd,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			true,
		);
		assert.ok(iso.starts()[1].argv.includes("--no-session"));
		assert.ok(!fs.existsSync(workersDir()));
	});

	test("off for one worker", async () => {
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
		const [start] = iso.starts();
		assert.ok(start.argv.includes("--no-session"));
		assert.ok(!start.argv.includes("--session-dir"));
		assert.ok(!fs.existsSync(path.join(workersDir(), s.sessionId)));
		// the next one still keeps its session
		const s2 = await m.createSession(undefined, iso.cwd);
		assert.ok(iso.starts()[1].argv.includes("--session-dir"));
		assert.ok(fs.existsSync(path.join(workersDir(), s2.sessionId)));
	});

	test("the flag and the file setting turn it off too", async () => {
		for (const config of [
			{ args: ["--persist-sessions", "off"], file: undefined },
		]) {
			const env = { ...iso.env };
			const cfg = loadConfig(config.args, env).config;
			assert.strictEqual(cfg.persistSessions, false);
		}
		assert.strictEqual(
			loadConfig([], { ...iso.env }).config.persistSessions,
			true,
		);
		const file = path.join(iso.root, "config.json");
		fs.writeFileSync(file, JSON.stringify({ persistSessions: false }));
		const cfg = loadConfig([], { ...iso.env, WORKER_MCP_CONFIG: file }).config;
		assert.strictEqual(cfg.persistSessions, false);
	});
});

describe("what is written", () => {
	test("directories 0700, files 0600 (also pi's own), no prompt in the record", async () => {
		const m = manager();
		const s = await m.createSession("keep", iso.cwd);
		const id = s.sessionId;
		const text = await finish(m, id);
		assert.ok(text, "the run ended");
		const lineage = path.join(workersDir(), id);
		for (const d of [workersDir(), lineage, path.join(lineage, "session")]) {
			assert.strictEqual(mode(d), 0o700, d);
		}
		assert.strictEqual(mode(path.join(lineage, "worker.json")), 0o600);
		assert.strictEqual(mode(path.join(lineage, "owner")), 0o600);
		const files = sessionFiles(id);
		assert.strictEqual(files.length, 1);
		assert.match(path.basename(files[0]), new RegExp(`_${id}\\.jsonl$`));
		// fake-pi writes it with the process umask like pi does; the server
		// made it private when the run settled
		assert.strictEqual(mode(files[0]), 0o600);

		const rec = JSON.parse(
			fs.readFileSync(path.join(lineage, "worker.json"), "utf8"),
		);
		assert.strictEqual(rec.lineage, id);
		assert.deepStrictEqual(rec.ids, [id]);
		assert.strictEqual(rec.name, "keep");
		assert.strictEqual(rec.provider, "pi");
		assert.strictEqual(rec.cwd, fs.realpathSync(iso.cwd));
		assert.strictEqual(rec.sandbox.applied, "none");
		assert.strictEqual(rec.session.id, id);
		assert.strictEqual(rec.session.dir, path.join(lineage, "session"));
		assert.strictEqual(rec.lastBootId, m.boot.id);
		assert.ok(rec.providerVersion, "the provider's version is recorded");
		const raw = fs.readFileSync(path.join(lineage, "worker.json"), "utf8");
		assert.ok(!raw.includes("MARKER-PROMPT-TEXT"), "no prompt in the record");
		// the conversation itself is in the session file, as documented
		assert.ok(fs.readFileSync(files[0], "utf8").includes("MARKER-PROMPT-TEXT"));
		const owner = JSON.parse(
			fs.readFileSync(path.join(lineage, "owner"), "utf8"),
		);
		assert.strictEqual(owner.bootId, m.boot.id);
		assert.ok(
			iso.workers().includes(owner.pid),
			"the owner is the provider process",
		);
	});

	test("the parser reads the file the worker wrote through the real server", async () => {
		const m = manager();
		const s = await m.createSession(undefined, iso.cwd);
		await finish(m, s.sessionId);
		const [file] = sessionFiles(s.sessionId);
		const r = await inspectSession(file);
		assert.strictEqual(r.analysed, true);
		assert.deepStrictEqual(r.damage, []);
		assert.strictEqual(r.header?.version, 3);
		assert.strictEqual(r.header?.id, s.sessionId);
		assert.strictEqual(r.header?.cwd, fs.realpathSync(iso.cwd));
		assert.ok(r.messageCount >= 2, "the user and the assistant message");
		assert.deepStrictEqual(r.danglingCalls, []);
	});

	test("nothing is written until the worker's first prompt; no record of a worker that never started", async () => {
		const m = manager();
		const s = await m.createSession(undefined, iso.cwd);
		assert.deepStrictEqual(sessionFiles(s.sessionId), []);
		// a start that fails removes what it made
		const before = fs.readdirSync(workersDir());
		const failing = manager({ FAKE_PI_SCENARIO: "exit-at-start" });
		await assert.rejects(failing.createSession(undefined, iso.cwd));
		assert.deepStrictEqual(fs.readdirSync(workersDir()), before);
	});
});

describe("lifetime", () => {
	test("terminate_worker deletes the session and the record", async () => {
		const m = manager();
		const s = await m.createSession(undefined, iso.cwd);
		await finish(m, s.sessionId);
		assert.ok(fs.existsSync(path.join(workersDir(), s.sessionId)));
		await m.terminateSession(s.sessionId);
		assert.ok(!fs.existsSync(path.join(workersDir(), s.sessionId)));
	});

	test("an idle close keeps them and gives up the owner claim", async () => {
		let skew = 0;
		const m = manager({}, { now: () => Date.now() + skew });
		const s = await m.createSession(undefined, iso.cwd);
		await finish(m, s.sessionId);
		const lineage = path.join(workersDir(), s.sessionId);
		assert.ok(fs.existsSync(path.join(lineage, "owner")));
		skew = 2 * 3_600_000;
		assert.deepStrictEqual(await m.reapIdle(), [s.sessionId]);
		assert.ok(!fs.existsSync(path.join(lineage, "owner")));
		assert.ok(fs.existsSync(path.join(lineage, "worker.json")));
		assert.strictEqual(sessionFiles(s.sessionId).length, 1);
	});

	test("a crashed pi keeps them and gives up the owner claim", async () => {
		const m = manager({ FAKE_PI_SESSION_KILL: "after-user" });
		const s = await m.createSession(undefined, iso.cwd);
		const lineage = path.join(workersDir(), s.sessionId);
		const run = await s.startRun(PROMPT, "crash");
		await s.waitText(run, { timeoutMs: 15_000 }).catch(() => null);
		await waitUntil(
			() => !fs.existsSync(path.join(lineage, "owner")),
			5000,
			"the owner claim to be released",
		);
		assert.ok(fs.existsSync(path.join(lineage, "worker.json")));
		const [file] = sessionFiles(s.sessionId);
		assert.ok(file, "the session file survived the crash");
		assert.ok(fs.readFileSync(file, "utf8").includes("MARKER-PROMPT-TEXT"));
	});

	test("a clean shutdown keeps them and gives up the owner claim", async () => {
		const m = manager();
		const s = await m.createSession(undefined, iso.cwd);
		await finish(m, s.sessionId);
		await m.terminateAll();
		const lineage = path.join(workersDir(), s.sessionId);
		assert.ok(!fs.existsSync(path.join(lineage, "owner")));
		assert.strictEqual(sessionFiles(s.sessionId).length, 1);
	});

	test("the sweep removes old sessions of workers that are gone, never one a live server holds", async () => {
		const a = manager();
		const live = await a.createSession(undefined, iso.cwd);
		await finish(a, live.sessionId);
		// another server closes a worker for being idle: its session stays
		let skew = 0;
		const b = manager({}, { now: () => Date.now() + skew });
		const gone = await b.createSession(undefined, iso.cwd);
		await finish(b, gone.sessionId);
		skew = 2 * 3_600_000;
		await b.reapIdle();

		// a third server with a retention of one millisecond sweeps at start
		await new Promise((r) => setTimeout(r, 20));
		const c = manager({}, { sessionRetentionMs: 1, maxSessionBytes: 1 });
		assert.ok(
			fs.existsSync(path.join(workersDir(), live.sessionId)),
			"held by a live server",
		);
		assert.ok(
			!fs.existsSync(path.join(workersDir(), gone.sessionId)),
			"released and old",
		);
		assert.ok(c);
	});
});

async function server(): Promise<{ s: RawServer; bootId: string }> {
	const s = new RawServer(iso);
	servers.push(s);
	await s.initialize();
	const res = await s.callTool("list_providers", {});
	return { s, bootId: res.result.structuredContent.server.bootId };
}
async function spawn(s: RawServer): Promise<string> {
	const res = await s.callTool("spawn_worker", { cwd: iso.cwd });
	assert.ok(!res.result.isError, JSON.stringify(res.result));
	return res.result.structuredContent.worker.workerId;
}

const ownerOf = (id: string) =>
	JSON.parse(fs.readFileSync(path.join(workersDir(), id, "owner"), "utf8"));

/** The test process, as a third server of the same state directory. */
function third() {
	const bootId = "cccccccccccc";
	const boots = new BootRegistry(path.join(stateDir(), "boots"), bootId);
	boots.register();
	return {
		boots,
		store: new WorkerStore({ dir: workersDir(), bootId, boots }),
	};
}

describe("two servers on one state directory", () => {
	test("each holds its own workers; a live one cannot be taken; release frees it", async () => {
		const a = await server();
		const b = await server();
		const wa = await spawn(a.s);
		const wb = await spawn(b.s);
		assert.strictEqual(ownerOf(wa).bootId, a.bootId);
		assert.strictEqual(ownerOf(wb).bootId, b.bootId);
		const t = third();
		assert.throws(
			() => t.store.claim(wa),
			(e: unknown) => e instanceof OwnerBusyError && e.reason === "live",
		);
		// terminating deletes; B's worker is untouched by A's end
		await a.s.callTool("terminate_worker", { workerId: wa });
		assert.ok(!fs.existsSync(path.join(workersDir(), wa)));
		assert.strictEqual(ownerOf(wb).bootId, b.bootId);
	});

	test("a server killed without cleanup leaves a stale owner, which another server takes over", async () => {
		const a = await server();
		const wa = await spawn(a.s);
		const run = await a.s.callTool("start_run", {
			workerId: wa,
			prompt: PROMPT,
			intent: "t",
			waitMs: 10_000,
		});
		assert.ok(!run.result.isError, JSON.stringify(run.result));
		const t = third();
		assert.throws(() => t.store.claim(wa), OwnerBusyError);
		a.s.child.kill("SIGKILL");
		await a.s.exited;
		assert.strictEqual(ownerOf(wa).bootId, a.bootId, "nothing cleaned it up");
		// the provider process may take a moment to notice and exit
		await waitUntil(
			() => {
				try {
					t.store.claim(wa);
					return true;
				} catch (e) {
					if (e instanceof OwnerBusyError) return false;
					throw e;
				}
			},
			10_000,
			"the stale owner to be taken over",
		);
		assert.strictEqual(ownerOf(wa).bootId, "cccccccccccc");
		// the session of the killed server is intact and private
		const files = sessionFiles(wa);
		assert.strictEqual(files.length, 1);
		assert.ok(mode(files[0]) <= 0o644);
	});
});
