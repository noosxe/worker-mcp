import assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { BootRegistry } from "../boots.js";
import {
	OwnerBusyError,
	type NewWorker,
	WorkerStore,
	processStartTime,
	workerRecordSchema,
} from "../worker-store.js";

let root: string;
let dir: string;
beforeEach(() => {
	root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "worker-mcp-wstore-")),
	);
	dir = path.join(root, "workers");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const mode = (p: string) => fs.lstatSync(p).mode & 0o777;

/** A pid that is certainly not running. */
function deadPid(): number {
	const r = spawnSync(process.execPath, ["-e", "0"]);
	assert.ok(r.pid);
	return r.pid;
}

/** A server of its own: a boot id, registered in the shared boots directory. */
function server(
	bootId: string,
	opts: {
		pid?: number;
		retentionMs?: number;
		maxBytes?: number;
		now?: () => number;
		register?: boolean;
	} = {},
) {
	const boots = new BootRegistry(
		path.join(root, "boots"),
		bootId,
		opts.pid ?? process.pid,
	);
	if (opts.register !== false) boots.register();
	const store = new WorkerStore({
		dir,
		bootId,
		boots,
		retentionMs: opts.retentionMs,
		maxBytes: opts.maxBytes,
		now: opts.now,
	});
	return { boots, store };
}

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";

const worker = (lineage: string, over: Partial<NewWorker> = {}): NewWorker => ({
	lineage,
	provider: "pi",
	providerVersion: "1.4.0",
	model: "example/model",
	cwd: "/work/example",
	sandbox: { requested: undefined, applied: "none" },
	toolIsolation: false,
	...over,
});

/** Put a session file of `bytes` into a lineage, last touched `ageMs` ago. */
function addSession(lineage: string, bytes: number, ageMs: number) {
	const file = path.join(dir, lineage, "session", "x.jsonl");
	fs.writeFileSync(file, "x".repeat(bytes));
	const t = new Date(Date.now() - ageMs);
	fs.utimesSync(file, t, t);
	fs.utimesSync(path.join(dir, lineage, "worker.json"), t, t);
	fs.utimesSync(path.join(dir, lineage, "session"), t, t);
	fs.utimesSync(path.join(dir, lineage), t, t);
}

describe("the layout", () => {
	test("directories are 0700, files 0600, and the record holds what it should", () => {
		const { store } = server(A);
		const layout = store.create(
			worker("w_aaaa1111", {
				name: "n1",
				policy: { maxAutoApprove: "LOW" },
				sandbox: { requested: "workspace", applied: "workspace" },
				toolIsolation: true,
				systemPromptChars: 12,
			}),
		);
		assert.strictEqual(
			layout.sessionDir,
			path.join(dir, "w_aaaa1111", "session"),
		);
		for (const d of [dir, layout.dir, layout.sessionDir]) {
			assert.strictEqual(mode(d), 0o700, d);
		}
		for (const f of ["worker.json", "owner"]) {
			assert.strictEqual(mode(path.join(layout.dir, f)), 0o600, f);
		}
		const rec = store.read("w_aaaa1111");
		assert.ok(rec);
		assert.deepStrictEqual(rec.ids, ["w_aaaa1111"]);
		assert.strictEqual(rec.provider, "pi");
		assert.strictEqual(rec.providerVersion, "1.4.0");
		assert.strictEqual(rec.model, "example/model");
		assert.strictEqual(rec.cwd, "/work/example");
		assert.deepStrictEqual(rec.sandbox, {
			requested: "workspace",
			applied: "workspace",
		});
		assert.strictEqual(rec.toolIsolation, true);
		assert.deepStrictEqual(rec.policy, { maxAutoApprove: "LOW" });
		assert.deepStrictEqual(rec.session, {
			id: "w_aaaa1111",
			dir: layout.sessionDir,
		});
		assert.strictEqual(rec.lastBootId, A);
		assert.ok(workerRecordSchema.safeParse(rec).success);
		// no temporary file is left
		assert.deepStrictEqual(
			new Set(fs.readdirSync(layout.dir)),
			new Set(["owner", "session", "worker.json"]),
		);
	});

	test("a symbolic link or a loose directory is refused, not followed", () => {
		const { store } = server(A);
		const elsewhere = path.join(root, "elsewhere");
		fs.mkdirSync(elsewhere);
		fs.symlinkSync(elsewhere, dir);
		assert.throws(() => store.create(worker("w_aaaa1111")), /symbolic link/);
		assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
		fs.rmSync(dir);

		fs.mkdirSync(dir, { mode: 0o755 });
		fs.chmodSync(dir, 0o755);
		assert.throws(
			() => store.create(worker("w_aaaa1111")),
			/unsafe permissions/,
		);
	});

	test("a lineage that is not a worker id is refused", () => {
		const { store } = server(A);
		for (const bad of ["../x", "w_short", "w_AAAA1111", ""]) {
			assert.throws(() => store.create(worker(bad)), /unexpected shape/, bad);
		}
	});

	test("a failed create leaves nothing behind, and never removes a live worker", () => {
		const { store } = server(A);
		store.create(worker("w_aaaa1111"));
		assert.throws(() => store.create(worker("w_aaaa1111")), OwnerBusyError);
		assert.ok(store.read("w_aaaa1111"), "the live worker is untouched");
		// a record that cannot be written removes the directory it made
		const bad = worker("w_bbbb2222", { cwd: "x".repeat(5000) });
		store.create(bad); // too long for the schema, but writing does not check
		store.remove("w_bbbb2222");
		fs.chmodSync(path.join(dir), 0o500);
		try {
			assert.throws(() => store.create(worker("w_cccc3333")));
		} finally {
			fs.chmodSync(dir, 0o700);
		}
		assert.ok(!fs.existsSync(path.join(dir, "w_cccc3333")));
	});

	test("tighten makes the agent's 0644 file 0600 and leaves other things alone", () => {
		const { store } = server(A);
		const { sessionDir } = store.create(worker("w_aaaa1111"));
		const file = path.join(sessionDir, "2026_w_aaaa1111.jsonl");
		fs.writeFileSync(file, "{}\n", { mode: 0o644 });
		fs.chmodSync(file, 0o644);
		const target = path.join(root, "target");
		fs.writeFileSync(target, "t", { mode: 0o644 });
		fs.chmodSync(target, 0o644);
		fs.symlinkSync(target, path.join(sessionDir, "link"));
		store.tighten("w_aaaa1111");
		assert.strictEqual(mode(file), 0o600);
		assert.strictEqual(
			mode(target),
			0o644,
			"a symlink's target is not touched",
		);
		store.tighten("w_nothere1"); // never throws
	});

	test("touch notes activity and keeps the rest", () => {
		let t = Date.parse("2026-01-01T00:00:00Z");
		const { store } = server(A, { now: () => t });
		store.create(worker("w_aaaa1111"));
		t += 60_000;
		store.touch("w_aaaa1111");
		const rec = store.read("w_aaaa1111");
		assert.strictEqual(rec?.lastActiveAt, "2026-01-01T00:01:00.000Z");
		assert.strictEqual(rec?.createdAt, "2026-01-01T00:00:00.000Z");
	});

	test("a record that is not in the format reads as missing", () => {
		const { store } = server(A);
		store.create(worker("w_aaaa1111"));
		fs.writeFileSync(path.join(dir, "w_aaaa1111", "worker.json"), "{}");
		assert.strictEqual(store.read("w_aaaa1111"), null);
		fs.writeFileSync(path.join(dir, "w_aaaa1111", "worker.json"), "nope");
		assert.strictEqual(store.read("w_aaaa1111"), null);
	});
});

describe("the owner claim", () => {
	test("it holds this server's boot and the provider's pid, and a release frees it", () => {
		const a = server(A);
		a.store.create(worker("w_aaaa1111"));
		const ownerFile = path.join(dir, "w_aaaa1111", "owner");
		let owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
		assert.strictEqual(owner.bootId, A);
		assert.strictEqual(owner.pid, process.pid);
		a.store.setOwnerPid("w_aaaa1111", 4242);
		owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
		assert.strictEqual(owner.pid, 4242);
		assert.strictEqual(mode(ownerFile), 0o600);
		a.store.release("w_aaaa1111");
		assert.ok(!fs.existsSync(ownerFile));
		// the record and the session stay
		assert.ok(a.store.read("w_aaaa1111"));
		assert.ok(fs.existsSync(path.join(dir, "w_aaaa1111", "session")));
	});

	test("a live owner cannot be taken, from another server or from the same one", () => {
		const a = server(A);
		const b = server(B);
		a.store.create(worker("w_aaaa1111"));
		for (const s of [b.store, a.store]) {
			assert.throws(
				() => s.claim("w_aaaa1111"),
				(e: unknown) =>
					e instanceof OwnerBusyError &&
					e.reason === "live" &&
					/live/.test(e.message),
			);
		}
		// and the owner file is still A's
		const owner = JSON.parse(
			fs.readFileSync(path.join(dir, "w_aaaa1111", "owner"), "utf8"),
		);
		assert.strictEqual(owner.bootId, A);
	});

	test("a release by another server does nothing", () => {
		const a = server(A);
		const b = server(B);
		a.store.create(worker("w_aaaa1111"));
		b.store.release("w_aaaa1111");
		assert.ok(fs.existsSync(path.join(dir, "w_aaaa1111", "owner")));
	});

	test("once the owner is released the other server can take the worker", () => {
		const a = server(A);
		const b = server(B);
		a.store.create(worker("w_aaaa1111"));
		a.store.release("w_aaaa1111");
		b.store.claim("w_aaaa1111");
		const owner = JSON.parse(
			fs.readFileSync(path.join(dir, "w_aaaa1111", "owner"), "utf8"),
		);
		assert.strictEqual(owner.bootId, B);
	});

	test("a stale owner, whose boot and process are gone, is taken over", () => {
		const dead = deadPid();
		const a = server(A, { pid: dead });
		a.store.create(worker("w_aaaa1111"));
		// the owner says the provider ran as the dead pid
		a.store.setOwnerPid("w_aaaa1111", dead);
		// A's boot marker names a dead pid, so A is not live
		const b = server(B);
		assert.strictEqual(b.boots.isLive(A), false);
		b.store.claim("w_aaaa1111");
		const owner = JSON.parse(
			fs.readFileSync(path.join(dir, "w_aaaa1111", "owner"), "utf8"),
		);
		assert.strictEqual(owner.bootId, B);
		assert.ok(!fs.existsSync(path.join(dir, "w_aaaa1111", "owner.breaking")));
	});

	test("a dead boot whose provider process still runs is not taken over", () => {
		const dead = deadPid();
		const a = server(A, { pid: dead });
		a.store.create(worker("w_aaaa1111"));
		// this very process stands for a provider that is still exiting
		a.store.setOwnerPid("w_aaaa1111", process.pid);
		const b = server(B);
		assert.strictEqual(b.boots.isLive(A), false);
		assert.throws(
			() => b.store.claim("w_aaaa1111"),
			(e: unknown) => e instanceof OwnerBusyError && e.reason === "exiting",
		);
		// a reused pid (another start time) is not the same process
		const file = path.join(dir, "w_aaaa1111", "owner");
		const owner = JSON.parse(fs.readFileSync(file, "utf8"));
		if (processStartTime(process.pid) !== undefined) {
			fs.writeFileSync(file, JSON.stringify({ ...owner, startedAt: "1" }));
			b.store.claim("w_aaaa1111");
			assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).bootId, B);
		}
	});

	test("two breakers: only one wins, and a stale breaking directory is cleared", () => {
		const dead = deadPid();
		const a = server(A, { pid: dead });
		a.store.create(worker("w_aaaa1111"));
		a.store.setOwnerPid("w_aaaa1111", dead);
		const lineageDir = path.join(dir, "w_aaaa1111");
		let t = Date.now();
		const b = server(B, { now: () => t });
		// another breaker is mid-way
		fs.mkdirSync(path.join(lineageDir, "owner.breaking"));
		assert.throws(
			() => b.store.claim("w_aaaa1111"),
			(e: unknown) => e instanceof OwnerBusyError && e.reason === "contended",
		);
		// it died: after a minute the directory is stale
		t += 61_000;
		b.store.claim("w_aaaa1111");
		assert.ok(!fs.existsSync(path.join(lineageDir, "owner.breaking")));
		assert.strictEqual(
			JSON.parse(fs.readFileSync(path.join(lineageDir, "owner"), "utf8"))
				.bootId,
			B,
		);
	});

	test("an owner file that cannot be read is waited for, then taken", () => {
		const a = server(A);
		a.store.create(worker("w_aaaa1111"));
		const file = path.join(dir, "w_aaaa1111", "owner");
		fs.writeFileSync(file, "garbage");
		let t = Date.now();
		const b = server(B, { now: () => t });
		assert.throws(
			() => b.store.claim("w_aaaa1111"),
			(e: unknown) => e instanceof OwnerBusyError && e.reason === "contended",
		);
		t += 10_000;
		b.store.claim("w_aaaa1111");
		assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).bootId, B);
	});
});

describe("retention", () => {
	const DAY = 24 * 3_600_000;

	test("sessions with no activity for the retention time are removed, newer ones kept", () => {
		const a = server(A, { retentionMs: 3 * DAY });
		for (const l of ["w_old00001", "w_new00001"]) a.store.create(worker(l));
		addSession("w_old00001", 10, 4 * DAY);
		addSession("w_new00001", 10, 2 * DAY);
		a.store.release("w_old00001");
		a.store.release("w_new00001");
		assert.strictEqual(a.store.prune(), 1);
		assert.ok(!fs.existsSync(path.join(dir, "w_old00001")));
		assert.ok(fs.existsSync(path.join(dir, "w_new00001")));
	});

	test("over the size cap the oldest go first, until the total fits", () => {
		const a = server(A, { retentionMs: 30 * DAY, maxBytes: 25_000 });
		const ages: [string, number][] = [
			["w_aaa00001", 3 * DAY],
			["w_bbb00001", 1 * DAY],
			["w_ccc00001", 2 * DAY],
		];
		for (const [l, age] of ages) {
			a.store.create(worker(l));
			addSession(l, 10_000, age);
			a.store.release(l);
		}
		// about 31 kB in all against a cap of 25 kB: the oldest goes, and only it
		a.store.prune();
		assert.deepStrictEqual(
			new Set(fs.readdirSync(dir)),
			new Set(["w_bbb00001", "w_ccc00001"]),
		);
	});

	test("a session held by a live server is never removed, by age or by size", () => {
		const a = server(A, { retentionMs: 1, maxBytes: 1 });
		const b = server(B, { retentionMs: 1, maxBytes: 1 });
		a.store.create(worker("w_live0001"));
		addSession("w_live0001", 500, 10 * DAY);
		// another server's sweep leaves it, and so does the holder's own
		assert.strictEqual(b.store.prune(), 0);
		assert.strictEqual(a.store.prune(), 0);
		assert.ok(
			fs.existsSync(path.join(dir, "w_live0001", "session", "x.jsonl")),
		);
		// released, it is fair game
		a.store.release("w_live0001");
		assert.strictEqual(b.store.prune(), 1);
		assert.ok(!fs.existsSync(path.join(dir, "w_live0001")));
	});

	test("a lineage whose server died is removed once old", () => {
		const dead = deadPid();
		const a = server(A, { pid: dead });
		a.store.create(worker("w_gone0001"));
		a.store.setOwnerPid("w_gone0001", dead);
		addSession("w_gone0001", 10, 5 * DAY);
		const b = server(B, { retentionMs: 3 * DAY });
		assert.strictEqual(b.store.prune(), 1);
	});

	test("a directory with no record is removed once it is an hour old, not before", () => {
		const a = server(A);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const orphan = path.join(dir, "w_orph0001");
		fs.mkdirSync(path.join(orphan, "session"), { recursive: true });
		assert.strictEqual(a.store.prune(), 0);
		const old = new Date(Date.now() - 2 * 3_600_000);
		fs.utimesSync(path.join(orphan, "session"), old, old);
		fs.utimesSync(orphan, old, old);
		assert.strictEqual(a.store.prune(), 1);
		// names that are not worker ids are never touched
		fs.mkdirSync(path.join(dir, "keep-me"));
		fs.utimesSync(path.join(dir, "keep-me"), old, old);
		a.store.prune();
		assert.ok(fs.existsSync(path.join(dir, "keep-me")));
	});

	test("remove deletes the whole lineage", () => {
		const a = server(A);
		a.store.create(worker("w_aaaa1111"));
		addSession("w_aaaa1111", 10, 0);
		a.store.remove("w_aaaa1111");
		assert.ok(!fs.existsSync(path.join(dir, "w_aaaa1111")));
		a.store.remove("w_aaaa1111"); // idempotent
	});
});
