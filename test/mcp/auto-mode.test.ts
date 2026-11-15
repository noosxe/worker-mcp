import assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { gatedBash, textOf } from "../helpers/behaviour.js";
import {
	createIsolation,
	type Isolation,
	waitUntil,
} from "../helpers/isolation.js";
import { DIST_ENTRY, RUNTIME } from "../helpers/stdio.js";

const TOKEN = "e2e-test-token-value";

interface Seen {
	authorization?: string;
	body: any;
}

/**
 * A classifier on a free loopback port: `rm -rf build` is allowed with
 * confidence, `rm -rf maybe` is an allow it is not sure about.
 */
function startClassifier(seen: Seen[]) {
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			seen.push({ authorization: req.headers.authorization, body });
			const unsure = String(body.action.command).includes("maybe");
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					requestId: body.requestId,
					verdict: "allow",
					confidence: unsure ? 0.4 : 0.95,
					reason: unsure ? "not sure" : "a build cleanup",
				}),
			);
		});
	});
	return new Promise<{ server: http.Server; url: string }>((resolve) =>
		server.listen(0, "127.0.0.1", () =>
			resolve({
				server,
				url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/c`,
			}),
		),
	);
}

describe(`auto mode end to end (${RUNTIME})`, () => {
	let iso: Isolation;
	let classifier: Awaited<ReturnType<typeof startClassifier>>;
	let client: Client;
	let transport: StdioClientTransport;
	let tokenFile: string;
	const seen: Seen[] = [];

	const call = async (name: string, args: Record<string, unknown>) =>
		(await client.callTool({ name, arguments: args })) as any;
	const data = async (name: string, args: Record<string, unknown>) => {
		const r = await call(name, args);
		assert.notStrictEqual(r.isError, true, textOf(r));
		return r.structuredContent;
	};

	before(async () => {
		iso = createIsolation();
		classifier = await startClassifier(seen);
		tokenFile = path.join(iso.root, "classifier-token");
		fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
		const configFile = path.join(iso.root, "config.json");
		fs.writeFileSync(
			configFile,
			JSON.stringify({
				gate: {
					mode: "auto",
					classifiers: [{ name: "local", url: classifier.url, tokenFile }],
				},
			}),
			{ mode: 0o600 },
		);
		transport = new StdioClientTransport({
			command: RUNTIME,
			args: [DIST_ENTRY],
			env: { ...iso.env, WORKER_MCP_CONFIG: configFile },
			stderr: "ignore",
		});
		client = new Client({ name: "auto-mode-test", version: "0.0.0" });
		await client.connect(transport);
		await client.listTools();
		await data("spawn_worker", { cwd: iso.cwd, name: "auto" });
	});
	after(async () => {
		await client.close().catch(() => {});
		await new Promise((r) => {
			classifier.server.closeAllConnections();
			classifier.server.close(r);
		});
		await iso.cleanup();
	});

	const runOnce = async (command: string) => {
		const view = await data("start_run", {
			workerId: "auto",
			prompt: gatedBash(command),
			intent: "clean up the build output",
			waitMs: 10_000,
		});
		return view;
	};

	test("an allowed call runs without an approval, and the log says who decided", async () => {
		const view = await runOnce("rm -rf build");
		assert.strictEqual(view.state, "completed");
		assert.strictEqual(view.gate.autoAllowed, 1);
		assert.strictEqual(view.gate.escalated, 0);
		const { entries } = await data("get_gate_log", {
			workerId: "auto",
			decidedBy: "http:local",
		});
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0].decision, "allow");
		assert.deepStrictEqual(
			entries[0].consulted.map((c: any) => c.by),
			["rules", "http:local"],
		);
		assert.strictEqual(seen.at(-1)?.authorization, `Bearer ${TOKEN}`);
		assert.strictEqual(
			seen.at(-1)?.body.context.intent,
			"clean up the build output",
		);
		assert.strictEqual(seen.at(-1)?.body.version, "1-provisional");
	});

	test("an uncertain call goes to the coordinator; remember: worker then covers it", async () => {
		const first = await runOnce("rm -rf maybe");
		assert.strictEqual(first.state, "awaiting_approval");
		const [pending] = first.pendingApprovals;
		assert.strictEqual(pending.escalatedBecause, "low_confidence");
		assert.strictEqual(pending.consulted[0].by, "http:local");
		assert.strictEqual(pending.consulted[0].confidence, 0.4);
		const answered = await data("approve_action", {
			approvalId: pending.approvalId,
			remember: "worker",
		});
		assert.strictEqual(answered.remembered, true);
		const done = await data("wait_run", {
			runId: first.runId,
			waitMs: 10_000,
			sinceSeq: first.seq,
		});
		assert.strictEqual(done.state, "completed");

		const asked = seen.length;
		const again = await runOnce("rm -rf maybe");
		assert.strictEqual(again.state, "completed");
		assert.strictEqual(seen.length, asked, "the classifier was not asked");
		const { entries } = await data("get_gate_log", {
			workerId: "auto",
			decidedBy: "cache",
		});
		assert.strictEqual(entries.length, 1);
	});

	test("the audit file holds metadata only, mode 0600, never the token", async () => {
		const file = path.join(iso.env.XDG_STATE_HOME, "worker-mcp", "audit.jsonl");
		await waitUntil(() => fs.existsSync(file), 3000, "the audit file");
		assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
		const text = fs.readFileSync(file, "utf8");
		assert.ok(!text.includes(TOKEN));
		const lines = text
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		assert.ok(lines.length >= 3);
		for (const line of lines) {
			assert.ok(line.argsDigest && line.requestId && line.decidedBy);
			assert.strictEqual(line.arguments, undefined);
			assert.strictEqual(line.input, undefined);
		}
		const list = await data("list_workers", {});
		assert.strictEqual(list.auditDegraded, false);
	});

	test("SIGHUP re-reads the token file", async () => {
		fs.writeFileSync(tokenFile, "rotated-token\n", { mode: 0o600 });
		process.kill(transport.pid as number, "SIGHUP");
		// Give the handler a moment, then a fresh call carries the new token.
		let last: string | undefined;
		await waitUntil(
			async () => {
				await runOnce(`rm -rf rotate-${Date.now()}`);
				last = seen.at(-1)?.authorization;
				return last === "Bearer rotated-token";
			},
			8000,
			"the rotated token",
		);
		assert.strictEqual(last, "Bearer rotated-token");
	});
});

describe(`classifier config at startup (${RUNTIME})`, () => {
	let iso: Isolation;
	before(() => {
		iso = createIsolation();
	});
	after(async () => {
		await iso.cleanup();
	});

	const write = (name: string, settings: unknown, mode = 0o600) => {
		const file = path.join(iso.root, name);
		fs.writeFileSync(file, JSON.stringify(settings), { mode });
		return file;
	};
	const run = (args: string[], env: Record<string, string> = {}) =>
		spawnSync(RUNTIME, [DIST_ENTRY, ...args], {
			env: { ...iso.env, ...env },
			encoding: "utf8",
			input: "",
			timeout: 20_000,
		});
	const classifierConfig = (tokenFile: string) =>
		write("c.json", {
			gate: {
				mode: "auto",
				classifiers: [{ name: "x", url: "https://example.com/c", tokenFile }],
			},
		});

	test("--print-config shows the token file path, never a token, and needs no file", () => {
		const missing = path.join(iso.root, "not-there");
		const r = run(["--print-config", "--config", classifierConfig(missing)]);
		assert.strictEqual(r.status, 0, r.stderr);
		const config = JSON.parse(r.stdout);
		assert.strictEqual(config.gate.mode, "auto");
		assert.strictEqual(config.gate.classifiers[0].tokenFile, missing);
		assert.strictEqual(config.gate.classifiers[0].timeoutMs, 3000);
		assert.strictEqual(config.gate.httpAllowCeiling, "HIGH");
		assert.ok(config.audit.file.endsWith("audit.jsonl"));
	});

	test("a missing token file is a clear startup error", () => {
		const missing = path.join(iso.root, "not-there");
		const r = run(["--config", classifierConfig(missing)]);
		assert.strictEqual(r.status, 1);
		assert.match(r.stderr, /classifiers x\.tokenFile.*cannot read token file/);
	});

	test("a group-readable token file is refused, without printing it", () => {
		const file = path.join(iso.root, "loose");
		fs.writeFileSync(file, "loose-secret-value", { mode: 0o640 });
		fs.chmodSync(file, 0o640);
		const r = run(["--config", classifierConfig(file)]);
		assert.strictEqual(r.status, 1);
		assert.match(r.stderr, /accessible to group or others/);
		assert.ok(!r.stderr.includes("loose-secret-value"));
	});

	test("auto mode with no classifier is a config error", () => {
		const r = run(["--config", write("a.json", { gate: { mode: "auto" } })]);
		assert.strictEqual(r.status, 1);
		assert.match(r.stderr, /gate\.mode is auto but gate\.classifiers is empty/);
		const viaEnv = run([], { WORKER_MCP_GATE_MODE: "auto" });
		assert.strictEqual(viaEnv.status, 1);
	});

	test("a plain http URL to another host is a config error", () => {
		const r = run([
			"--config",
			write("h.json", {
				gate: { classifiers: [{ name: "x", url: "http://example.com/c" }] },
			}),
		]);
		assert.strictEqual(r.status, 1);
		assert.match(r.stderr, /only localhost, 127\.0\.0\.1 and \[::1\] may/);
	});

	test("the new settings layer from env and flags", () => {
		const c = classifierConfig(path.join(iso.root, "t"));
		const r = run(
			["--print-config", "--config", c, "--http-allow-ceiling", "medium"],
			{ WORKER_MCP_ON_CLASSIFIER_FAILURE: "deny", WORKER_MCP_AUDIT: "0" },
		);
		assert.strictEqual(r.status, 0, r.stderr);
		const config = JSON.parse(r.stdout);
		assert.strictEqual(config.gate.httpAllowCeiling, "MEDIUM");
		assert.strictEqual(config.gate.onClassifierFailure, "deny");
		assert.strictEqual(config.audit.enabled, false);
		const bad = run(["--print-config", "--gate-mode", "sometimes"]);
		assert.strictEqual(bad.status, 1);
		assert.match(bad.stderr, /flag --gate-mode/);
	});
});
