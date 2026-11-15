import assert from "node:assert";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { gatedBash, textOf } from "../helpers/behaviour.js";
import { createIsolation, type Isolation } from "../helpers/isolation.js";
import { DIST_ENTRY, RUNTIME } from "../helpers/stdio.js";

const TOKEN = "e2e-jev-test-token";

interface Seen {
	path: string;
	authorization?: string;
	body: any;
}

/** A fake System One server: `maybe` in the command makes jev unsure. */
function startSystemOne(seen: Seen[]) {
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			seen.push({
				path: req.url ?? "",
				authorization: req.headers.authorization,
				body,
			});
			const unsure = String(body.state).includes("maybe");
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					model: "jev-fake",
					answers: {
						risk: { type: "score", score: unsure ? 1.8 : 0.3, confidence: 0.9 },
						approval: { type: "noul", noul: unsure ? 0.5 : 0.02 },
						user_requested: { type: "noul", noul: unsure ? 0.3 : 0.95 },
						from_untrusted: { type: "noul", noul: 0.01 },
					},
				}),
			);
		});
	});
	return new Promise<{ server: http.Server; url: string }>((resolve) =>
		server.listen(0, "127.0.0.1", () =>
			resolve({
				server,
				url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			}),
		),
	);
}

describe(`auto mode with jev end to end (${RUNTIME})`, () => {
	let iso: Isolation;
	let fake: Awaited<ReturnType<typeof startSystemOne>>;
	let client: Client;
	const seen: Seen[] = [];

	const data = async (name: string, args: Record<string, unknown>) => {
		const r = (await client.callTool({ name, arguments: args })) as any;
		assert.notStrictEqual(r.isError, true, textOf(r));
		return r.structuredContent;
	};

	before(async () => {
		iso = createIsolation();
		fake = await startSystemOne(seen);
		const tokenFile = path.join(iso.root, "jev-token");
		fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
		const configFile = path.join(iso.root, "config.json");
		fs.writeFileSync(
			configFile,
			JSON.stringify({
				gate: {
					mode: "auto",
					classifiers: [
						{
							name: "jev",
							dialect: "jev",
							backend: "custom",
							url: fake.url,
							model: "jev-fake",
							tokenFile,
						},
					],
				},
			}),
			{ mode: 0o600 },
		);
		const transport = new StdioClientTransport({
			command: RUNTIME,
			args: [DIST_ENTRY],
			env: { ...iso.env, WORKER_MCP_CONFIG: configFile },
			stderr: "ignore",
		});
		client = new Client({ name: "auto-mode-jev-test", version: "0.0.0" });
		await client.connect(transport);
		await client.listTools();
		await data("spawn_worker", { cwd: iso.cwd, name: "auto" });
	});
	after(async () => {
		await client.close().catch(() => {});
		await new Promise((r) => {
			fake.server.closeAllConnections();
			fake.server.close(r);
		});
		await iso.cleanup();
	});

	const runOnce = (command: string) =>
		data("start_run", {
			workerId: "auto",
			prompt: gatedBash(command),
			intent: "clean up the build output",
			waitMs: 10_000,
		});

	test("a confident low-risk answer runs the call without an approval", async () => {
		const view = await runOnce("rm -rf build");
		assert.strictEqual(view.state, "completed");
		assert.strictEqual(view.gate.autoAllowed, 1);
		assert.strictEqual(view.gate.escalated, 0);
		const { entries } = await data("get_gate_log", {
			workerId: "auto",
			decidedBy: "http:jev",
		});
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0].decision, "allow");
		const last = seen.at(-1)!;
		assert.strictEqual(last.path, "/v1/systemone");
		assert.strictEqual(last.authorization, `Bearer ${TOKEN}`);
		assert.strictEqual(last.body.model, "jev-fake");
		assert.ok(last.body.state.includes("Intent: clean up the build output"));
		assert.ok(!JSON.stringify(last.body).includes(TOKEN));
	});

	test("an uncertain answer goes to the coordinator, with jev's answers shown", async () => {
		const view = await runOnce("rm -rf maybe");
		assert.strictEqual(view.state, "awaiting_approval");
		const [pending] = view.pendingApprovals;
		assert.strictEqual(pending.escalatedBecause, "low_confidence");
		const jev = pending.consulted.find((c: any) => c.by === "http:jev");
		assert.ok(jev, "jev is in consulted");
		assert.strictEqual(jev.verdict, "escalate");
		assert.ok(
			jev.untrustedReason.includes("approval 0.5"),
			jev.untrustedReason,
		);
		assert.ok(
			jev.untrustedReason.includes("user_requested 0.3"),
			jev.untrustedReason,
		);
		await data("reject_action", { approvalId: pending.approvalId });
	});
});
