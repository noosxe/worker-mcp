import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadConfig } from "../../src/config.js";
import { BootRegistry } from "../../src/core/boots.js";
import { WorkerStore } from "../../src/core/worker-store.js";
import { ToolError } from "../../src/errors.js";
import { REPEAT_GUARD_RULE_ID } from "../../src/gate/gate.js";
import { createServer } from "../../src/server.js";
import {
	SessionManager,
	type ManagerOptions,
} from "../../src/session/session-manager.js";
import type { Session } from "../../src/session/session.js";
import { call, textOf } from "../helpers/behaviour.js";
import {
	createIsolation,
	type Isolation,
	waitUntil,
} from "../helpers/isolation.js";

const WRITE = { path: "marker.txt", content: "x" };
const WRITE_PROMPT = `scenario:tool:write:${JSON.stringify(WRITE)}`;
/** Lets a MEDIUM write through unasked, as a coordinator's policy may. */
const ALLOW_WRITE = {
	autoApproveUpTo: "MEDIUM",
	overrides: [{ match: { tool: "write" }, action: "allow" }],
};

let iso: Isolation;
const managers: SessionManager[] = [];
const closers: (() => Promise<void>)[] = [];
beforeEach(() => {
	iso = createIsolation();
});
afterEach(async () => {
	while (closers.length > 0) await closers.pop()?.();
	for (const m of managers.splice(0)) await m.terminateAll();
	await iso.cleanup();
});

const stateDir = () => path.join(iso.env.XDG_STATE_HOME, "worker-mcp");
const workersDir = () => path.join(stateDir(), "workers");

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

/**
 * A worker that finishes one run, then dies in the middle of `prompt`.
 * Returns its id.
 */
async function killedDuring(
	prompt: string,
	opts: { policy?: unknown; env?: Record<string, string> } = {},
): Promise<string> {
	const m = manager({ FAKE_PI_SESSION_KILL: "after-gate", ...opts.env });
	const s = await m.createSession(
		undefined,
		iso.cwd,
		"zai/glm-test",
		undefined,
		opts.policy,
	);
	await say(s, "hello");
	const run = await s.startRun(prompt, "test");
	await assert.rejects(
		s.waitText(run, { timeoutMs: 15_000 }),
		/exited unexpectedly/,
	);
	await waitUntil(() => !s.isAlive(), 5000, "the worker to be gone");
	return s.sessionId;
}

const sessionFile = (lineage: string) => {
	const dir = path.join(workersDir(), lineage, "session");
	return path.join(dir, fs.readdirSync(dir)[0]);
};
const auditEntries = (): Record<string, any>[] =>
	fs
		.readFileSync(loadConfig([], iso.env).config.audit.file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));

async function refused(p: Promise<unknown>, re: RegExp): Promise<void> {
	await assert.rejects(p, (e: unknown) => {
		assert.ok(e instanceof ToolError, String(e));
		assert.match(e.message, re);
		return true;
	});
}

/** The context size a resume of `id` reports, on a server with this cap. */
async function resumeWith(id: string, cap: number) {
	const b = manager({
		WORKER_MCP_RESUME_MAX_CONTEXT_TOKENS: String(cap),
	});
	const s = await b.resumeSession({ resumeFrom: id });
	await b.terminateAll();
	return s;
}

async function mixed() {
	const good = await killedDuring("scenario:bash:sleep 30");
	const live = await killedDuring("scenario:bash:sleep 30");
	const damaged = await killedDuring("scenario:bash:sleep 30");
	const big = await killedDuring("scenario:bash:sleep 30", {
		env: { FAKE_PI_USAGE: "90000" },
	});
	otherServer().claim(live);
	// a damaged line in the middle of the file
	const file = sessionFile(damaged);
	const lines = fs.readFileSync(file, "utf8").split("\n");
	lines[3] = "{ not json";
	fs.writeFileSync(file, lines.join("\n"));
	return { good, live, damaged, big };
}

const byId = (items: any[], id: string) => items.find((i) => i.lineage === id);

describe("the repeat guard", () => {
	test("escalates the repeated call in the first resumed run only, and says why in the log and the audit", async () => {
		const id = await killedDuring(WRITE_PROMPT, { policy: ALLOW_WRITE });
		const b = manager();
		const s = await b.resumeSession({
			resumeFrom: id,
			riskPolicy: ALLOW_WRITE,
		});
		assert.strictEqual(s.resumed?.interrupted[0].status, "approved_started");

		// first run: the same call, though the policy allows it, goes to the coordinator
		const run = await s.startRun(WRITE_PROMPT, "test");
		await waitUntil(() => s.pendingActions.length === 1, 10_000, "an approval");
		const pending = s.pendingActions[0];
		assert.strictEqual(pending.tool, "write");
		assert.strictEqual(pending.hardLimit, true);
		assert.match(pending.reason ?? "", /cut off before the restart/);
		assert.match(pending.reason ?? "", /result is unknown/);
		s.approveAction(pending.actionId);
		await s.waitText(run, { timeoutMs: 15_000 });

		const log = s.getGateLog().filter((e) => e.tool === "write");
		assert.strictEqual(log[0].rule.ruleId, REPEAT_GUARD_RULE_ID);
		assert.strictEqual(log[0].decision, "escalate");
		assert.strictEqual(log[0].escalatedBecause, "repeat_cut_off");
		assert.strictEqual(log.at(-1)?.decidedBy, "coordinator");
		const audit = auditEntries().filter(
			(e) => e.rule?.ruleId === REPEAT_GUARD_RULE_ID,
		);
		assert.ok(audit.length >= 1);
		assert.strictEqual(audit[0].workerId, s.sessionId);
		assert.strictEqual(audit[0].decision, "escalate");

		// second run: the same call is allowed by the policy, unasked
		const second = await s.startRun(WRITE_PROMPT, "test");
		await s.waitText(second, { timeoutMs: 15_000 });
		assert.strictEqual(s.pendingActions.length, 0);
		const last = s
			.getGateLog()
			.filter((e) => e.tool === "write")
			.at(-1);
		assert.strictEqual(last?.decision, "allow");
		assert.notStrictEqual(last?.rule.ruleId, REPEAT_GUARD_RULE_ID);
	});

	test("a different call and a call that never ran are not held back", async () => {
		const id = await killedDuring(WRITE_PROMPT, { policy: ALLOW_WRITE });
		const b = manager();
		const s = await b.resumeSession({
			resumeFrom: id,
			riskPolicy: ALLOW_WRITE,
		});
		const other = { path: "other.txt", content: "y" };
		await say(s, `scenario:tool:write:${JSON.stringify(other)}`);
		assert.strictEqual(s.pendingActions.length, 0);
		assert.strictEqual(
			s.getGateLog().filter((e) => e.rule.ruleId === REPEAT_GUARD_RULE_ID)
				.length,
			0,
		);
	});
});

describe("the context cap", () => {
	test("from the reported usage: refused above the cap, allowed below it", async () => {
		const id = await killedDuring("scenario:bash:sleep 30", {
			env: { FAKE_PI_USAGE: "5000" },
		});
		await refused(
			manager({ WORKER_MCP_RESUME_MAX_CONTEXT_TOKENS: "4999" }).resumeSession({
				resumeFrom: id,
			}),
			/too large to resume: about 5000 tokens.*last reply's usage.*4999 \(resume\.maxContextTokens\).*new worker with a (short )?summary/,
		);
		const s = await resumeWith(id, 5000);
		assert.strictEqual(s.resumed?.contextTokens, 5000);
		assert.strictEqual(s.resumed?.contextEstimate, "usage");
	});

	test("from the file size when there is no usage: a quarter of the bytes", async () => {
		const id = await killedDuring("scenario:bash:sleep 30");
		const bytes = fs.statSync(sessionFile(id)).size;
		const tokens = Math.ceil(bytes / 4);
		await refused(
			manager({
				WORKER_MCP_RESUME_MAX_CONTEXT_TOKENS: String(tokens - 1),
			}).resumeSession({ resumeFrom: id }),
			/estimated from the file size/,
		);
		const s = await resumeWith(id, tokens);
		assert.strictEqual(s.resumed?.contextTokens, tokens);
		assert.strictEqual(s.resumed?.contextEstimate, "bytes");
	});

	test("a usage far below what the file's size allows is not believed", async () => {
		const id = await killedDuring("scenario:bash:sleep 30", {
			env: { FAKE_PI_USAGE: "1" },
		});
		const s = await resumeWith(id, 1_000_000);
		assert.strictEqual(s.resumed?.contextEstimate, "bytes");
		assert.ok((s.resumed?.contextTokens ?? 0) > 1);
	});

	test("a refused resume leaves the conversation free for another try", async () => {
		const id = await killedDuring("scenario:bash:sleep 30", {
			env: { FAKE_PI_USAGE: "5000" },
		});
		await refused(
			manager({ WORKER_MCP_RESUME_MAX_CONTEXT_TOKENS: "10" }).resumeSession({
				resumeFrom: id,
			}),
			/too large/,
		);
		const s = await resumeWith(id, 10_000);
		assert.strictEqual(s.resumed?.contextTokens, 5000);
	});
});

/** The test process as a second server of the state directory. */
function otherServer() {
	const bootId = "cccccccccccc";
	const boots = new BootRegistry(path.join(stateDir(), "boots"), bootId);
	boots.register();
	return new WorkerStore({ dir: workersDir(), bootId, boots });
}

async function connect(m: SessionManager): Promise<Client> {
	const server = createServer(m, "0.0.0-test");
	const [c, s] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([server.connect(s), client.connect(c)]);
	closers.push(() => client.close());
	return client;
}

describe("list_workers with resumable", () => {
	test("says which are resumable and why the others are not", async () => {
		const { good, live, damaged, big } = await mixed();
		const m = manager({ WORKER_MCP_RESUME_MAX_CONTEXT_TOKENS: "50000" });
		const { items, total } = await m.listResumable(10);
		assert.strictEqual(total, 4);
		assert.strictEqual(items.length, 4);

		const g = byId(items, good);
		assert.strictEqual(g.resumable, true);
		assert.strictEqual(g.workerId, good);
		assert.strictEqual(g.cwd, fs.realpathSync(iso.cwd));
		assert.strictEqual(g.untrustedSession.cutOffCalls, 1);
		assert.deepStrictEqual(g.untrustedSession.cutOffTools, ["bash"]);
		assert.strictEqual(g.untrustedSession.contextEstimate, "bytes");
		assert.ok(g.untrustedSession.contextTokens > 0);
		assert.ok(g.lastActiveAt);

		assert.match(byId(items, live).notResumable, /another worker-mcp server/);
		assert.match(byId(items, damaged).notResumable, /^damaged: /);
		const b = byId(items, big);
		assert.strictEqual(b.resumable, false);
		assert.match(b.notResumable, /context too large.*90000.*50000/);
		assert.strictEqual(b.untrustedSession.contextEstimate, "usage");
	});

	test("newest first, bounded, and a session is read again only when it changed", async () => {
		const first = await killedDuring("scenario:bash:sleep 30");
		const second = await killedDuring("scenario:bash:sleep 30");
		const third = await killedDuring("scenario:bash:sleep 30");
		// whole seconds, so the time can be set back exactly
		const stamp = Math.floor(Date.now() / 1000) - 60;
		fs.utimesSync(sessionFile(third), stamp, stamp);
		const m = manager();
		const two = await m.listResumable(2);
		assert.strictEqual(two.total, 3);
		assert.deepStrictEqual(
			two.items.map((i) => i.lineage),
			[third, second],
		);
		assert.ok(!two.items.some((i) => i.lineage === first));

		// cached by size and modification time: damage the file without
		// changing either, and the list does not look again
		const file = sessionFile(third);
		const size = fs.statSync(file).size;
		const text = fs.readFileSync(file, "utf8").split("\n");
		text[3] = "x".repeat(text[3].length);
		fs.writeFileSync(file, text.join("\n"));
		fs.utimesSync(file, stamp, stamp);
		assert.strictEqual(fs.statSync(file).size, size);
		const cached = await m.listResumable(2);
		assert.strictEqual(cached.items[0].resumable, true, "served from cache");
		// a change in size is seen
		fs.appendFileSync(file, "\n");
		const seen = await m.listResumable(2);
		assert.match(seen.items[0].notResumable ?? "", /^damaged: /);
	});

	test("a huge session is not read: its size gives the estimate", async () => {
		const id = await killedDuring("scenario:bash:sleep 30");
		fs.appendFileSync(sessionFile(id), `${" ".repeat(5 * 1024 * 1024)}\n`);
		const m = manager({ WORKER_MCP_RESUME_MAX_CONTEXT_TOKENS: "100000000" });
		const { items } = await m.listResumable(5);
		const item = items[0];
		assert.strictEqual(item.untrustedSession?.contextEstimate, "bytes");
		assert.strictEqual(item.untrustedSession?.cutOffCalls, undefined);
		assert.ok((item.untrustedSession?.contextTokens ?? 0) > 1_000_000);
	});

	test("through the tool: default off, limit bounded, worker-derived fields marked untrusted", async () => {
		await killedDuring("scenario:bash:sleep 30");
		const client = await connect(manager());
		const plain = await call(client, "list_workers", {});
		assert.notStrictEqual(plain.isError, true);
		assert.strictEqual(
			(plain as any).structuredContent.resumable,
			undefined,
			"off by default",
		);

		const result = await call(client, "list_workers", {
			resumable: true,
			limit: 5,
		});
		assert.notStrictEqual(result.isError, true, textOf(result));
		const data = (result as any).structuredContent;
		assert.strictEqual(data.resumable.total, 1);
		assert.strictEqual(data.resumable.items[0].resumable, true);
		assert.deepStrictEqual(
			data.resumable.items[0].untrustedSession.cutOffTools,
			["bash"],
		);
		// in the text block the strings under untrusted… keys are wrapped
		const text = textOf(result);
		assert.match(
			text,
			/"cutOffTools":\["<worker_output [^>]*trust=\\"untrusted\\">bash<\/worker_output>"\]/,
		);
		assert.match(text, /1 of 1 saved conversation\(s\) shown, 1 resumable/);

		for (const limit of [0, 51, 1.5]) {
			const bad = await call(client, "list_workers", {
				resumable: true,
				limit,
			});
			assert.strictEqual(bad.isError, true, `limit ${limit}`);
		}
	});

	test("there is nothing to list when sessions are not kept", async () => {
		await killedDuring("scenario:bash:sleep 30");
		const m = manager({ WORKER_MCP_PERSIST_SESSIONS: "off" });
		assert.deepStrictEqual(await m.listResumable(10), { items: [], total: 0 });
	});
});
