import assert from "node:assert";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { digest } from "../../src/gate/audit.js";
import {
	inspectSession,
	inspectSessionText,
} from "../../src/providers/pi/session.js";
import {
	createIsolation,
	FAKE_PI,
	type Isolation,
} from "../helpers/isolation.js";

const FIXTURES = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"pi-sessions",
);
const fx = (name: string) => path.join(FIXTURES, `${name}.jsonl`);

describe("inspectSession on the fixtures", () => {
	test("a normal session", async () => {
		const r = await inspectSession(fx("normal"));
		assert.deepEqual(r.header, {
			version: 3,
			id: "s_example01",
			cwd: "/work/example",
			timestamp: "2026-01-01T10:00:00.000Z",
		});
		assert.deepEqual(r.model, {
			provider: "example",
			modelId: "example-model",
		});
		assert.equal(r.thinkingLevel, "high");
		assert.equal(r.entryCount, 14);
		assert.equal(r.messageCount, 12);
		assert.equal(r.activeBranch.length, 14);
		assert.deepEqual(r.danglingCalls, []);
		assert.deepEqual(r.damage, []);
		assert.equal(r.multipleBranches, false);
		assert.equal(r.analysed, true);
		assert.ok(r.bytes > 0);
	});

	test("a call without a result", async () => {
		const r = await inspectSession(fx("dangling-call"));
		assert.deepEqual(r.damage, []);
		assert.equal(r.danglingCalls.length, 1);
		const [c] = r.danglingCalls;
		assert.equal(c.name, "bash");
		assert.equal(c.callId, "call_a1");
		assert.equal(
			c.inputDigest,
			digest({
				command: "for i in 1 2 3; do echo $i >> out.txt; sleep 1; done",
			}),
		);
		assert.match(c.untrustedPreview, /echo \$i >> out\.txt/);
	});

	test("a torn last line", async () => {
		const r = await inspectSession(fx("torn-tail"));
		assert.deepEqual(r.damage, [{ kind: "torn_last_line", line: 16 }]);
		// the torn entry is dropped: same as the normal file
		assert.equal(r.messageCount, 12);
		assert.deepEqual(r.danglingCalls, []);
	});

	test("a damaged middle line breaks the chain and drops context", async () => {
		const r = await inspectSession(fx("damaged-middle"));
		assert.deepEqual(r.damage, [
			{ kind: "damaged_line", line: 6 },
			{ kind: "broken_chain", missingParent: "e0000005", droppedMessages: 2 },
		]);
		// 12 messages in the file, the damaged one is gone and two more fall out
		assert.equal(r.messageCount, 9);
	});

	test("garbage", async () => {
		const r = await inspectSession(fx("garbage"));
		assert.deepEqual(r.damage, [{ kind: "unreadable_header" }]);
		assert.equal(r.header, undefined);
		assert.equal(r.analysed, false);
		assert.equal(r.messageCount, 0);
	});

	for (const v of [2, 4]) {
		test(`format version ${v} is reported, not analysed`, async () => {
			const r = await inspectSession(fx(`format-v${v}`));
			assert.equal(r.header?.version, v);
			assert.deepEqual(r.damage, [
				{ kind: "unknown_version", found: v, supported: 3 },
			]);
			assert.equal(r.analysed, false);
			assert.deepEqual(r.danglingCalls, []);
		});
	}

	test("two branches off one parent", async () => {
		const r = await inspectSession(fx("two-branches"));
		assert.equal(r.multipleBranches, true);
		assert.deepEqual(r.forkPoints, ["e0000005"]);
		// the last writer wins: B's branch is the active one
		assert.equal(r.activeBranch.at(-1), "e0000b02");
		assert.ok(!r.activeBranch.includes("e0000a02"));
		assert.deepEqual(r.damage, []);
	});
});

describe("inspectSession on bad input", () => {
	let iso: Isolation;
	beforeEach(() => {
		iso = createIsolation();
	});
	afterEach(async () => {
		await iso.cleanup();
	});

	test("a missing file, a directory and a symlink do not throw", async () => {
		const missing = await inspectSession(path.join(iso.root, "nope.jsonl"));
		assert.equal(missing.damage[0].kind, "unreadable_file");
		const dir = await inspectSession(iso.root);
		assert.deepEqual(dir.damage, [
			{ kind: "unreadable_file", reason: "not a regular file" },
		]);
		const link = path.join(iso.root, "link.jsonl");
		fs.symlinkSync(fx("normal"), link);
		assert.equal(
			(await inspectSession(link)).damage[0].kind,
			"unreadable_file",
		);
	});

	test("a file above the size limit is not read", async () => {
		const r = await inspectSession(fx("normal"), { maxBytes: 100 });
		assert.equal(r.damage[0].kind, "too_large");
		assert.equal(r.analysed, false);
		assert.equal(r.header, undefined);
	});

	test("odd shapes do not throw", () => {
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "s",
			cwd: "/w",
		});
		const odd = [
			"",
			header,
			header + "\n[]\nnull\n42\n",
			`${header}\n{"type":"message","id":"a","parentId":"a","message":null}\n`,
			// a cycle
			`${header}\n{"type":"message","id":"a","parentId":"b"}\n{"type":"message","id":"b","parentId":"a"}\n`,
			// a call whose arguments are not JSON-able shapes
			`${header}\n${JSON.stringify({ type: "message", id: "a", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: 5 }, 7, null] } })}\n`,
			"\u0000".repeat(1000),
		];
		for (const text of odd) {
			const r = inspectSessionText(text);
			assert.ok(Array.isArray(r.damage));
		}
		const last = inspectSessionText(odd[5]);
		assert.equal(last.danglingCalls[0].name, "unknown");
	});

	test("the preview is flat and short", () => {
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "s",
			cwd: "/w",
		});
		const m = {
			type: "message",
			id: "a",
			parentId: null,
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "c",
						name: "bash",
						arguments: { command: `x\u001b[2J\n${"y".repeat(1000)}` },
					},
				],
			},
		};
		const r = inspectSessionText(`${header}\n${JSON.stringify(m)}\n`);
		const p = r.danglingCalls[0].untrustedPreview;
		assert.ok(p.length <= 201);
		// oxlint-disable-next-line no-control-regex -- checks control characters are gone
		assert.ok(!/[\u0000-\u001f]/.test(p));
	});
});

// ---- fake-pi round trip ------------------------------------------------------

/** Drive fake-pi over its RPC stdin/stdout, like the provider does. */
function startFake(
	iso: Isolation,
	args: string[],
	env: Record<string, string> = {},
) {
	const child: ChildProcess = spawn(process.execPath, [FAKE_PI, ...args], {
		cwd: iso.cwd,
		env: { ...iso.env, ...env },
		stdio: ["pipe", "pipe", "ignore"],
	});
	let buf = "";
	const lines: any[] = [];
	child.stdout!.setEncoding("utf8");
	child.stdout!.on("data", (d: string) => {
		buf += d;
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			lines.push(JSON.parse(buf.slice(0, i)));
			buf = buf.slice(i + 1);
		}
	});
	const exited = new Promise<{ code: number | null; signal: string | null }>(
		(resolve) => child.on("exit", (code, signal) => resolve({ code, signal })),
	);
	let n = 0;
	return {
		child,
		exited,
		events: lines,
		prompt(message: string) {
			child.stdin!.write(
				`${JSON.stringify({ id: `p${n++}`, type: "prompt", message })}\n`,
			);
		},
		async settled() {
			const deadline = Date.now() + 5000;
			while (!lines.some((l) => l.type === "agent_settled")) {
				if (Date.now() > deadline) throw new Error("no agent_settled");
				await new Promise((r) => setTimeout(r, 20));
			}
		},
		lastText() {
			return lines.filter((l) => l.type === "message_end").at(-1)?.message
				.content[0].text as string;
		},
		async stop() {
			child.stdin!.end();
			await exited;
		},
	};
}

describe("fake-pi session files", () => {
	let iso: Isolation;
	let dir: string;
	beforeEach(() => {
		iso = createIsolation();
		dir = path.join(iso.root, "sessions");
		fs.mkdirSync(dir);
	});
	afterEach(async () => {
		await iso.cleanup();
	});

	const files = () => fs.readdirSync(dir);

	test("nothing is written before the first user message, then everything at once", async () => {
		const f = startFake(iso, ["--session-dir", dir, "--session-id", "s_one"]);
		await new Promise((r) => setTimeout(r, 300));
		assert.deepEqual(files(), []);
		f.prompt("hello there");
		await f.settled();
		await f.stop();
		const [name] = files();
		assert.match(name, /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z_s_one\.jsonl$/);
		const r = await inspectSession(path.join(dir, name));
		assert.deepEqual(r.header?.id, "s_one");
		assert.equal(r.header?.version, 3);
		assert.equal(
			r.header?.cwd,
			process.platform === "linux" ? fs.realpathSync(iso.cwd) : iso.cwd,
		);
		assert.equal(r.model?.modelId, "fake-model");
		assert.equal(r.thinkingLevel, "high");
		// system, user, assistant
		assert.equal(r.messageCount, 3);
		assert.deepEqual(r.damage, []);
		assert.equal(r.multipleBranches, false);
	});

	test("a kill after the tool call is written leaves a dangling call; resume restores context", async () => {
		const a = startFake(iso, ["--session-dir", dir, "--session-id", "s_two"], {
			FAKE_PI_SESSION_KILL: "after-tool-call",
		});
		a.prompt("Remember the code word PELICAN-42.");
		await a.settled();
		assert.equal(
			a.lastText(),
			"fake-pi reply: Remember the code word PELICAN-42.",
		);
		a.prompt(
			'scenario:tool:bash:{"command":"for i in 1 2 3; do echo $i; sleep 1; done"}',
		);
		const exit = await a.exited;
		assert.equal(exit.signal, "SIGKILL");

		const file = path.join(dir, files()[0]);
		const r = await inspectSession(file);
		assert.deepEqual(r.damage, []);
		assert.equal(r.danglingCalls.length, 1);
		assert.equal(r.danglingCalls[0].name, "bash");
		assert.equal(
			r.danglingCalls[0].inputDigest,
			digest({ command: "for i in 1 2 3; do echo $i; sleep 1; done" }),
		);
		// system, user, assistant, user, assistant (the call)
		assert.equal(r.messageCount, 5);

		// resume: the same id and cwd find the file; the context comes back
		const b = startFake(iso, ["--session-dir", dir, "--session-id", "s_two"]);
		b.prompt("scenario:recall");
		await b.settled();
		assert.match(b.lastText(), /PELICAN-42/);
		await b.stop();
		assert.equal(files().length, 1);
		const after = await inspectSession(file);
		// the dangling call is still there: fake-pi, like pi, writes no result
		assert.equal(after.danglingCalls.length, 1);
		assert.deepEqual(after.damage, []);
		assert.equal(after.multipleBranches, false);
	});

	test("a kill after the gate leaves the call without a result too", async () => {
		const a = startFake(
			iso,
			["--session-dir", dir, "--session-id", "s_three"],
			{ FAKE_PI_SESSION_KILL: "after-gate" },
		);
		a.prompt("scenario:bash:echo hi");
		assert.equal((await a.exited).signal, "SIGKILL");
		const r = await inspectSession(path.join(dir, files()[0]));
		assert.equal(r.danglingCalls.length, 1);
	});

	test("a finished tool call has its result on disk", async () => {
		const f = startFake(iso, ["--session-dir", dir, "--session-id", "s_four"]);
		f.prompt("scenario:bash:echo hi");
		await f.settled();
		await f.stop();
		const r = await inspectSession(path.join(dir, files()[0]));
		assert.deepEqual(r.danglingCalls, []);
		// system, user, call, result, final answer
		assert.equal(r.messageCount, 5);
	});

	test("a session for another cwd is not picked up", async () => {
		const a = startFake(iso, ["--session-dir", dir, "--session-id", "s_five"]);
		a.prompt("first");
		await a.settled();
		await a.stop();
		const other = path.join(iso.root, "elsewhere");
		fs.mkdirSync(other);
		const b = spawn(
			process.execPath,
			[FAKE_PI, "--session-dir", dir, "--session-id", "s_five"],
			{
				cwd: other,
				env: iso.env,
				stdio: ["pipe", "pipe", "ignore"],
			},
		);
		b.stdin!.end();
		await new Promise((r) => b.on("exit", r));
		const started = fs
			.readFileSync(iso.recordFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
			.filter((l) => l.kind === "session");
		assert.deepEqual(
			started.map((s) => s.resumed),
			[false, false],
		);
	});

	test("without session flags nothing is written and no session is recorded", async () => {
		const f = startFake(iso, []);
		f.prompt("scenario:bash:echo hi");
		await f.settled();
		await f.stop();
		assert.deepEqual(files(), []);
		const recorded = fs.readFileSync(iso.recordFile, "utf8");
		assert.ok(!recorded.includes('"kind":"session"'));
		assert.match(f.lastText(), /^exit=0\nhi/);
	});
});
