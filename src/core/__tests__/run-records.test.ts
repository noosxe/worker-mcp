import assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import { BootRegistry } from "../boots.js";
import type { Logger } from "../log.js";
import {
	RunRecordStore,
	runFromRecord,
	runRecordSchema,
} from "../run-records.js";
import { RunStore } from "../run.js";

const OWN = "aaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbb";

// oxlint-disable-next-line unicorn/no-array-sort -- a copy is sorted
const sorted = (a: string[]) => [...a].sort();

let root: string;
before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-mcp-records-"));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

let counter = 0;
function fixture(
	over: { maxRecords?: number; retentionMs?: number; now?: () => number } = {},
) {
	const dir = path.join(root, `case${counter++}`);
	fs.mkdirSync(dir, { mode: 0o700 });
	const warnings: string[] = [];
	const log: Logger = {
		debug() {},
		info() {},
		warn: (m) => warnings.push(m),
		error: (m) => warnings.push(m),
	};
	const boots = new BootRegistry(
		path.join(dir, "boots"),
		OWN,
		process.pid,
		log,
	);
	boots.register();
	const records = new RunRecordStore({
		dir: path.join(dir, "runs"),
		bootId: OWN,
		boots,
		retentionMs: over.retentionMs ?? 7 * 86_400_000,
		maxRecords: over.maxRecords ?? 500,
		log,
		now: over.now,
	});
	const store = new RunStore({
		retentionMs: 1000,
		maxRetained: 100,
		maxWaitMs: 5000,
		outputBufferChars: 1_000_000,
		sink: records,
	});
	return { dir, boots, records, store, warnings };
}

/** The pid of a process that has exited. */
function deadPid(): number {
	const r = spawnSync(process.execPath, ["-e", "0"]);
	assert.ok(r.pid);
	return r.pid;
}

function foreignRecord(
	f: ReturnType<typeof fixture>,
	state: string,
	boot: string,
) {
	const run = f.store.create("w_aaaabbbb", "secret prompt", "intent");
	const file = path.join(f.records.dir, `${run.id}.json`);
	const rec = JSON.parse(fs.readFileSync(file, "utf8"));
	rec.bootId = boot;
	rec.state = state;
	fs.writeFileSync(file, JSON.stringify(rec), { mode: 0o600 });
	return { id: run.id, file };
}

describe("run records: what is written", () => {
	test("a record is made at the start and follows the run, without the prompt", () => {
		const f = fixture();
		const run = f.store.create("w_aaaabbbb", "my secret prompt", "do a thing", {
			workerName: "n",
			provider: "pi",
			model: "m",
			cwd: "/work",
		});
		const file = path.join(f.records.dir, `${run.id}.json`);
		assert.strictEqual(
			JSON.parse(fs.readFileSync(file, "utf8")).state,
			"starting",
		);
		f.store.setState(run, "running");
		f.store.addOutput(run, "hello world");
		f.store.addApproval(
			run,
			{
				actionId: "a_aaaa111111",
				tool: "bash",
				kind: "shell",
				command: "cat /etc/passwd",
				paths: [{ path: "/etc/passwd", inWorkspace: false, protected: false }],
				riskLabel: "HIGH",
				expiresAt: Date.now() + 1000,
			},
			"awaiting",
		);
		f.store.removeApproval(run, "a_aaaa111111", false, {
			decision: "approved",
			by: "coordinator",
		});
		f.store.settle(run, "completed", { usage: { inputTokens: 3 } });
		const text = fs.readFileSync(file, "utf8");
		const rec = runRecordSchema.parse(JSON.parse(text));
		assert.strictEqual(rec.state, "completed");
		assert.strictEqual(rec.bootId, OWN);
		assert.strictEqual(rec.workerId, "w_aaaabbbb");
		assert.strictEqual(rec.workerName, "n");
		assert.strictEqual(rec.provider, "pi");
		assert.strictEqual(rec.cwd, "/work");
		assert.strictEqual(rec.intent, "do a thing");
		assert.strictEqual(rec.finalText, "hello world");
		assert.deepStrictEqual(rec.usage, { inputTokens: 3 });
		assert.strictEqual(rec.promptChars, "my secret prompt".length);
		assert.match(rec.promptSha256, /^[0-9a-f]{64}$/);
		assert.deepStrictEqual(
			rec.approvals.map((a) => [a.tool, a.riskLabel, a.decision, a.decidedBy]),
			[["bash", "HIGH", "approved", "coordinator"]],
		);
		// Neither the prompt nor the call's command or paths are in the file.
		assert.doesNotMatch(text, /secret prompt|passwd/);
	});

	test("a run settled with a call still pending records it as cancelled", () => {
		const f = fixture();
		const run = f.store.create("w_aaaabbbb", "p");
		f.store.addApproval(
			run,
			{
				actionId: "a_aaaa222222",
				tool: "write",
				kind: "write",
				paths: [],
				expiresAt: 1,
			},
			"m",
		);
		f.store.settle(run, "cancelled", {});
		const rec = f.records.load(run.id)?.record;
		assert.strictEqual(rec?.approvals[0].decision, "cancelled");
		assert.strictEqual(rec?.approvals[0].decidedBy, "cancel");
	});

	test("the directory is 0700, files 0600, and no temporary file is left", () => {
		const f = fixture();
		const run = f.store.create("w_aaaabbbb", "p");
		f.store.settle(run, "completed", {});
		assert.strictEqual(fs.statSync(f.records.dir).mode & 0o777, 0o700);
		assert.strictEqual(fs.statSync(f.boots.dir).mode & 0o777, 0o700);
		const names = fs.readdirSync(f.records.dir);
		assert.deepStrictEqual(names, [`${run.id}.json`]);
		assert.strictEqual(
			fs.statSync(path.join(f.records.dir, names[0])).mode & 0o777,
			0o600,
		);
		assert.strictEqual(
			fs.statSync(path.join(f.boots.dir, OWN)).mode & 0o777,
			0o600,
		);
	});

	test("a symbolic link in place of the directory is refused, and the run goes on", () => {
		const f = fixture();
		const elsewhere = path.join(f.dir, "elsewhere");
		fs.mkdirSync(elsewhere, { mode: 0o700 });
		fs.symlinkSync(elsewhere, f.records.dir);
		const run = f.store.create("w_aaaabbbb", "p");
		f.store.settle(run, "completed", {});
		assert.strictEqual(run.state, "completed");
		assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
		assert.strictEqual(f.records.degraded, true);
	});

	test("a directory that is too open is refused", () => {
		const f = fixture();
		fs.mkdirSync(f.records.dir, { mode: 0o755 });
		fs.chmodSync(f.records.dir, 0o755);
		f.store.create("w_aaaabbbb", "p");
		assert.deepStrictEqual(fs.readdirSync(f.records.dir), []);
		assert.strictEqual(f.records.degraded, true);
	});
});

describe("run records: reading", () => {
	test("a record is read back as a run, marked as from this server", () => {
		const f = fixture();
		const run = f.store.create("w_aaaabbbb", "p", "i");
		f.store.addOutput(run, "abcdef");
		f.store.settle(run, "failed", { error: "boom" });
		const loaded = f.records.load(run.id);
		assert.ok(loaded);
		assert.strictEqual(loaded.fromEarlierServer, false);
		const back = runFromRecord(loaded.record);
		assert.strictEqual(back.state, "failed");
		assert.strictEqual(back.error, "boom");
		assert.strictEqual(back.output.all, "abcdef");
		assert.strictEqual(back.terminal, true);
	});

	test("an id that is not a run id never touches the disk", () => {
		const f = fixture();
		assert.strictEqual(f.records.load("../../etc/passwd"), null);
		assert.strictEqual(f.records.load("r_short"), null);
	});

	test("a corrupt record is skipped with one metadata-only warning", () => {
		const f = fixture();
		const run = f.store.create("w_aaaabbbb", "p");
		f.store.settle(run, "completed", {});
		const bad = "r_AAAAAAAAAAAA";
		fs.writeFileSync(
			path.join(f.records.dir, `${bad}.json`),
			'{"version":1,"finalText":"TOPSECRETCONTENT',
			{ mode: 0o600 },
		);
		fs.writeFileSync(
			path.join(f.records.dir, "r_BBBBBBBBBBBB.json"),
			JSON.stringify({ version: 1, runId: "r_BBBBBBBBBBBB", state: "weird" }),
			{ mode: 0o600 },
		);
		assert.strictEqual(f.records.load(bad), null);
		assert.strictEqual(f.records.load(bad), null);
		assert.strictEqual(f.records.load("r_BBBBBBBBBBBB"), null);
		f.records.recoverInterrupted();
		f.records.prune();
		assert.strictEqual(f.records.load(run.id)?.record.state, "completed");
		assert.strictEqual(f.warnings.length, 2, f.warnings.join("\n"));
		assert.doesNotMatch(f.warnings.join("\n"), /TOPSECRETCONTENT/);
		assert.match(f.warnings[0], /r_AAAAAAAAAAAA\.json/);
	});

	test("a record that is a symbolic link is not followed", () => {
		const f = fixture();
		const run = f.store.create("w_aaaabbbb", "p");
		const secret = path.join(f.dir, "outside.json");
		fs.writeFileSync(secret, "{}", { mode: 0o600 });
		const link = path.join(f.records.dir, "r_CCCCCCCCCCCC.json");
		fs.symlinkSync(secret, link);
		assert.strictEqual(f.records.load("r_CCCCCCCCCCCC"), null);
		assert.ok(run);
	});
});

describe("run records: servers that stopped", () => {
	test("a run left in progress by a dead server becomes interrupted", () => {
		const f = fixture();
		fs.writeFileSync(path.join(f.boots.dir, OTHER), `${deadPid()}\n`, {
			mode: 0o600,
		});
		const { id, file } = foreignRecord(f, "running", OTHER);
		assert.strictEqual(f.records.recoverInterrupted(), 1);
		const rec = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.strictEqual(rec.state, "interrupted");
		assert.match(
			rec.error,
			/^the server stopped while this run was in progress \(boot bbbbbbbbbbbb\); what the worker did before that is in the workspace$/,
		);
		const loaded = f.records.load(id);
		assert.strictEqual(loaded?.fromEarlierServer, true);
		assert.strictEqual(loaded?.serverRunning, false);
		assert.strictEqual(f.records.recoverInterrupted(), 0);
	});

	test("a run of a boot with no marker is interrupted too, and pending approvals are abandoned", () => {
		const f = fixture();
		const { id, file } = foreignRecord(f, "awaiting_approval", OTHER);
		const rec = JSON.parse(fs.readFileSync(file, "utf8"));
		rec.approvals = [
			{
				approvalId: "a_x",
				tool: "bash",
				decision: "pending",
				askedAt: new Date().toISOString(),
			},
		];
		fs.writeFileSync(file, JSON.stringify(rec), { mode: 0o600 });
		const loaded = f.records.load(id);
		assert.strictEqual(loaded?.record.state, "interrupted");
		assert.strictEqual(loaded?.record.approvals[0].decision, "abandoned");
	});

	test("a run of a live server is left alone", () => {
		const f = fixture();
		// The marker holds the pid of this test process: alive.
		fs.writeFileSync(path.join(f.boots.dir, OTHER), `${process.pid}\n`, {
			mode: 0o600,
		});
		const { id, file } = foreignRecord(f, "running", OTHER);
		assert.strictEqual(f.records.recoverInterrupted(), 0);
		assert.strictEqual(
			JSON.parse(fs.readFileSync(file, "utf8")).state,
			"running",
		);
		const loaded = f.records.load(id);
		assert.strictEqual(loaded?.record.state, "running");
		assert.strictEqual(loaded?.serverRunning, true);
		// Nor is it pruned, however old or many.
		assert.strictEqual(f.records.prune(), 0);
		assert.ok(fs.existsSync(file));
	});

	test("a finished record of a dead server is kept as it is", () => {
		const f = fixture();
		const { id } = foreignRecord(f, "completed", OTHER);
		assert.strictEqual(f.records.recoverInterrupted(), 0);
		assert.strictEqual(f.records.load(id)?.record.state, "completed");
	});

	test("boot markers of dead servers are swept, live ones kept", () => {
		const f = fixture();
		fs.writeFileSync(path.join(f.boots.dir, OTHER), `${deadPid()}\n`);
		fs.writeFileSync(
			path.join(f.boots.dir, "cccccccccccc"),
			`${process.pid}\n`,
		);
		f.boots.sweep();
		assert.deepStrictEqual(sorted(fs.readdirSync(f.boots.dir)), [
			OWN,
			"cccccccccccc",
		]);
		assert.strictEqual(f.boots.isLive("cccccccccccc"), true);
		assert.strictEqual(f.boots.isLive(OTHER), false);
		assert.strictEqual(f.boots.isLive("not a boot id"), false);
		f.boots.unregister();
		assert.ok(!fs.existsSync(path.join(f.boots.dir, OWN)));
	});
});

describe("run records: retention", () => {
	test("the oldest records past the count limit are deleted", () => {
		const f = fixture({ maxRecords: 3 });
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			const run = f.store.create("w_aaaabbbb", "p");
			f.store.settle(run, "completed", {});
			ids.push(run.id);
			const t = new Date(Date.now() - (5 - i) * 1000);
			fs.utimesSync(path.join(f.records.dir, `${run.id}.json`), t, t);
		}
		assert.strictEqual(f.records.prune(), 2);
		assert.deepStrictEqual(
			sorted(fs.readdirSync(f.records.dir)),
			sorted(ids.slice(2).map((i) => `${i}.json`)),
		);
	});

	test("records older than the age limit are deleted, and stray temporary files", () => {
		const f = fixture({ retentionMs: 60_000 });
		const old = f.store.create("w_aaaabbbb", "p");
		f.store.settle(old, "completed", {});
		const fresh = f.store.create("w_aaaabbbb", "p");
		f.store.settle(fresh, "completed", {});
		const t = new Date(Date.now() - 120_000);
		fs.utimesSync(path.join(f.records.dir, `${old.id}.json`), t, t);
		const tmp = path.join(f.records.dir, ".r_x.1234.tmp");
		fs.writeFileSync(tmp, "x");
		const longAgo = new Date(Date.now() - 2 * 3_600_000);
		fs.utimesSync(tmp, longAgo, longAgo);
		assert.strictEqual(f.records.prune(), 1);
		assert.deepStrictEqual(fs.readdirSync(f.records.dir), [`${fresh.id}.json`]);
	});

	test("a run of this server still in progress is never pruned", () => {
		const f = fixture({ maxRecords: 1, retentionMs: 1 });
		const live = f.store.create("w_aaaabbbb", "p");
		f.store.setState(live, "running");
		const t = new Date(Date.now() - 100_000);
		fs.utimesSync(path.join(f.records.dir, `${live.id}.json`), t, t);
		assert.strictEqual(f.records.prune(), 0);
		assert.ok(fs.existsSync(path.join(f.records.dir, `${live.id}.json`)));
	});
});

describe("run records: write failures", () => {
	test("a failed write warns once and never fails the run", () => {
		const f = fixture();
		const first = f.store.create("w_aaaabbbb", "p");
		assert.strictEqual(f.records.degraded, false);
		// Replace the directory with a file: every write now fails.
		fs.rmSync(f.records.dir, { recursive: true });
		fs.writeFileSync(f.records.dir, "not a directory");
		f.store.setState(first, "running");
		f.store.addOutput(first, "text");
		assert.doesNotThrow(() => f.store.settle(first, "completed", {}));
		const second = f.store.create("w_aaaabbbb", "p");
		f.store.settle(second, "failed", { error: "x" });
		assert.strictEqual(first.state, "completed");
		assert.strictEqual(second.state, "failed");
		assert.strictEqual(f.records.degraded, true);
		assert.strictEqual(
			f.warnings.filter((w) => /cannot write run records/.test(w)).length,
			1,
		);
	});

	test("writing resumes when the problem goes away", () => {
		const f = fixture();
		f.store.create("w_aaaabbbb", "p");
		fs.rmSync(f.records.dir, { recursive: true });
		fs.writeFileSync(f.records.dir, "x");
		const lost = f.store.create("w_aaaabbbb", "p");
		assert.strictEqual(f.records.degraded, true);
		fs.rmSync(f.records.dir);
		const kept = f.store.create("w_aaaabbbb", "p");
		assert.strictEqual(f.records.degraded, false);
		assert.ok(fs.existsSync(path.join(f.records.dir, `${kept.id}.json`)));
		assert.ok(!fs.existsSync(path.join(f.records.dir, `${lost.id}.json`)));
	});

	test("a store whose sink throws does not break the run", () => {
		const store = new RunStore({
			retentionMs: 1000,
			maxRetained: 100,
			maxWaitMs: 5000,
			outputBufferChars: 1000,
			sink: {
				save() {
					throw new Error("disk on fire");
				},
			},
		});
		const run = store.create("w", "p");
		assert.doesNotThrow(() => store.settle(run, "completed", {}));
	});
});
