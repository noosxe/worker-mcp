import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";

import { AuditFile } from "../audit.js";
import { decide, fixture, type Fixture } from "./helpers.js";

let dir: string;
let fx: Fixture;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-mcp-audit-"));
	fx = fixture();
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	fx.cleanup();
});

describe("audit file", () => {
	test("JSONL, appended, mode 0600, in a private directory it creates", () => {
		const file = path.join(dir, "state", "audit.jsonl");
		const audit = new AuditFile({ file });
		audit.write({ n: 1 });
		audit.write({ n: 2 });
		audit.close();
		assert.deepStrictEqual(
			fs
				.readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l)),
			[{ n: 1 }, { n: 2 }],
		);
		assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
		assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
		// A second writer appends: it does not truncate.
		const more = new AuditFile({ file });
		more.write({ n: 3 });
		more.close();
		assert.strictEqual(
			fs.readFileSync(file, "utf8").trim().split("\n").length,
			3,
		);
	});

	test("an existing file with wider rights is tightened", () => {
		const file = path.join(dir, "a.jsonl");
		fs.writeFileSync(file, "", { mode: 0o644 });
		fs.chmodSync(file, 0o644);
		const audit = new AuditFile({ file });
		audit.write({ n: 1 });
		audit.close();
		assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
	});

	test("it rotates at the size limit and keeps a fixed number of files", () => {
		const file = path.join(dir, "audit.jsonl");
		const audit = new AuditFile({ file, maxBytes: 100, keep: 3 });
		for (let i = 0; i < 40; i++) audit.write({ i, pad: "x".repeat(20) });
		audit.close();
		const names = fs.readdirSync(dir);
		assert.deepStrictEqual(
			new Set(names),
			new Set([
				"audit.jsonl",
				"audit.jsonl.1",
				"audit.jsonl.2",
				"audit.jsonl.3",
			]),
		);
		for (const n of names) {
			assert.ok(fs.statSync(path.join(dir, n)).size <= 100, n);
			assert.strictEqual(fs.statSync(path.join(dir, n)).mode & 0o777, 0o600);
		}
		// Newest entries in the live file, older ones further along.
		const last = (f: string) =>
			JSON.parse(
				fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").at(-1)!,
			).i;
		assert.strictEqual(last("audit.jsonl"), 39);
		assert.ok(last("audit.jsonl.1") < last("audit.jsonl"));
		assert.ok(last("audit.jsonl.3") < last("audit.jsonl.2"));
	});

	test("a write failure is reported once, never throws, and sets degraded", () => {
		const blocked = path.join(dir, "blocked");
		fs.writeFileSync(blocked, "a file where a directory should be");
		const errors: Error[] = [];
		const audit = new AuditFile({
			file: path.join(blocked, "audit.jsonl"),
			onError: (e) => errors.push(e),
		});
		assert.strictEqual(audit.degraded, false);
		audit.write({ n: 1 });
		audit.write({ n: 2 });
		assert.strictEqual(audit.degraded, true);
		assert.strictEqual(errors.length, 1);
		// Once the obstacle is gone it recovers.
		fs.rmSync(blocked);
		audit.write({ n: 3 });
		assert.strictEqual(audit.degraded, false);
		audit.close();
	});

	test("it will not follow a symlink at the file path", () => {
		const target = path.join(dir, "target");
		fs.writeFileSync(target, "");
		const file = path.join(dir, "audit.jsonl");
		fs.symlinkSync(target, file);
		const audit = new AuditFile({ file });
		audit.write({ n: 1 });
		assert.strictEqual(audit.degraded, true);
		assert.strictEqual(fs.readFileSync(target, "utf8"), "");
	});
});

describe("the gate writes metadata only", () => {
	test("entries carry digests and previews, never the arguments, and resolutions are logged", async () => {
		const file = path.join(dir, "audit.jsonl");
		const audit = new AuditFile({ file });
		const gate = fx.gate({ audit, workerId: "w_aaaaaaaa" });
		const content = "SECRET-FILE-CONTENT-".repeat(50);
		await decide(gate, "write", { path: "src/a.ts", content });
		const out = await gate.decide(
			{ provider: "pi", toolName: "bash", input: { command: "rm file" } },
			"call1",
			{ runId: "r_1" },
		);
		gate.recordResolution("call1", "allow", "coordinator", "approved");
		audit.close();
		const text = fs.readFileSync(file, "utf8");
		assert.ok(!text.includes("SECRET-FILE-CONTENT"));
		const lines = text
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		assert.strictEqual(lines.length, 3);
		assert.strictEqual(lines[0].workerId, "w_aaaaaaaa");
		assert.match(lines[0].argsDigest, /^[0-9a-f]{64}$/);
		assert.strictEqual(
			lines[1].requestId,
			(out as { requestId: string }).requestId,
		);
		assert.strictEqual(lines[1].runId, "r_1");
		assert.strictEqual(lines[1].escalatedBecause, "manual_mode");
		assert.strictEqual(lines[2].decidedBy, "coordinator");
		for (const l of lines) assert.ok(l.preview.length <= 200);
	});

	test("the audit file and the token file are protected from workers", async () => {
		const audit = new AuditFile({ file: path.join(dir, "audit.jsonl") });
		const gate = fx.gate({
			audit,
			secretFiles: [path.join(dir, "token")],
		});
		const read = await decide(gate, "read", { path: path.join(dir, "token") });
		assert.strictEqual(read.autoAllowable, false);
	});
});
