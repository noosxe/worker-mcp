import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import { gatedBash } from "../helpers/behaviour.js";
import { createIsolation, type Isolation } from "../helpers/isolation.js";
import { RawServer } from "../helpers/stdio.js";
import { TOOLS } from "../helpers/tools.js";

const CMD_MARKER = "MARKER-CMD-7f3a91";
const BODY_MARKER = "MARKER-BODY-c20d58";
const PATH_MARKER = "marker-path-9be41d";
const REASON_MARKER = "MARKER-REASON-5d77e0";
const ALLOW_MARKER = "MARKER-ALLOW-31c8aa";
const DENY_MARKER = "MARKER-DENY-e94b07";

const ALL_MARKERS = [
	CMD_MARKER,
	BODY_MARKER,
	PATH_MARKER,
	REASON_MARKER,
	ALLOW_MARKER,
	DENY_MARKER,
];

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);

/** The structured view of a tool result; fails with the error text if it is an error. */
function viewOf(result: any, what: string): any {
	const text = JSON.stringify(result.result?.content ?? result);
	assert.notStrictEqual(
		result.result?.isError,
		true,
		`${what} failed: ${text}`,
	);
	assert.ok(result.result?.structuredContent, `${what} has no view: ${text}`);
	return result.result.structuredContent;
}

/**
 * Follow a run to a terminal state. A wait without a cursor returns early
 * while an approval is still reported, so keep waiting from the returned seq.
 */
async function settle(
	server: RawServer,
	view: any,
	deadlineMs = 30_000,
): Promise<any> {
	const deadline = Date.now() + deadlineMs;
	let current = view;
	while (!TERMINAL.has(current.state)) {
		assert.ok(
			Date.now() < deadline,
			`run ${view.runId} not terminal, last state ${current.state}`,
		);
		current = viewOf(
			await server.callTool(TOOLS.waitRun, {
				runId: view.runId,
				sinceSeq: current.seq,
				waitMs: 5_000,
			}),
			"wait_run",
		);
	}
	return current;
}

/**
 * Drives an escalated bash call (approved) and an escalated write call
 * (rejected, with a reason) through the server over stdio, and returns what
 * the server wrote to stderr.
 */
async function drive(
	iso: Isolation,
	level?: string,
	args: string[] = [],
): Promise<{ stderr: string; workerLog: string }> {
	const env = { ...iso.env };
	if (level) env.WORKER_MCP_LOG_LEVEL = level;
	const server = new RawServer({ ...iso, env }, args);
	let workerLog = "";
	try {
		await server.initialize();
		const name = `w-${level ?? "default"}`;
		// Rules decide two calls by themselves: echo is allowed, curl is denied.
		const spawned = await server.callTool(TOOLS.spawn, {
			name,
			cwd: iso.cwd,
			policy: {
				autoApproveUpTo: 0,
				overrides: [
					{ match: { command: "echo *" }, action: "allow" },
					{ match: { command: "curl *" }, action: "deny" },
				],
			},
		});
		assert.notStrictEqual(spawned.result.isError, true);
		const sessionId = spawned.result.structuredContent.worker.workerId;

		for (const command of [
			`echo ${ALLOW_MARKER}`,
			`curl https://example.invalid/${DENY_MARKER}`,
		]) {
			const auto = await server.callTool(TOOLS.startRun, {
				workerId: name,
				prompt: gatedBash(command),
				waitMs: 10_000,
			});
			const autoView = viewOf(auto, "auto-decided start_run");
			assert.notStrictEqual(autoView.state, "awaiting_approval");
			await settle(server, autoView);
		}

		const bash = await server.callTool(TOOLS.startRun, {
			workerId: name,
			prompt: gatedBash(`rm -rf build # ${CMD_MARKER}`),
			waitMs: 10_000,
		});
		const bashView = viewOf(bash, "bash start_run");
		assert.strictEqual(bashView.state, "awaiting_approval");
		const approved = await server.callTool(TOOLS.approve, {
			approvalId: bashView.pendingApprovals[0].approvalId,
		});
		viewOf(approved, "approve_action");
		await settle(server, bashView);

		// A write outside the workspace is escalated.
		const write = await server.callTool(TOOLS.startRun, {
			workerId: name,
			prompt: `scenario:tool:write:${JSON.stringify({
				path: `/etc/${PATH_MARKER}`,
				content: BODY_MARKER,
			})}`,
			waitMs: 10_000,
		});
		const writeView = viewOf(write, "write start_run");
		assert.strictEqual(writeView.state, "awaiting_approval");
		const rejected = await server.callTool(TOOLS.reject, {
			approvalId: writeView.pendingApprovals[0].approvalId,
			reason: REASON_MARKER,
		});
		viewOf(rejected, "reject_action");
		await settle(server, writeView);
		const log = await server.request("resources/read", {
			uri: `worker-mcp://workers/${sessionId}/log`,
		});
		workerLog = log.result.contents
			.map((c: { text: string }) => c.text)
			.join("");
		await server.callTool(TOOLS.terminate, { workerId: name });
	} finally {
		server.child.stdin!.end();
		await server.exited;
		await server.dispose();
	}
	return { stderr: server.stderr.join(""), workerLog };
}

describe("stderr carries metadata only", () => {
	let iso: Isolation;
	before(() => {
		iso = createIsolation();
	});
	after(() => iso.cleanup());

	test("default level: no tool input, file content, path or reason", async () => {
		const { stderr, workerLog } = await drive(iso);
		assert.match(stderr, /\[INTERCEPTED\]/, "the escalation is still logged");
		assert.match(stderr, /\[AUTO-APPROVED\]/);
		assert.match(stderr, /\[AUTO-DENIED\]/);
		assert.match(
			workerLog,
			/\[INTERCEPTED\]/,
			"the log resource has the metadata",
		);
		assert.match(stderr, /bash action a_/);
		for (const marker of [
			CMD_MARKER,
			BODY_MARKER,
			PATH_MARKER,
			REASON_MARKER,
		]) {
			assert.ok(!stderr.includes(marker), `stderr leaks ${marker}:\n${stderr}`);
		}
	});

	test("info level behaves like the default", async () => {
		const { stderr } = await drive(iso, "info");
		for (const marker of ALL_MARKERS) {
			assert.ok(!stderr.includes(marker), `stderr leaks ${marker}`);
		}
	});

	test("debug level shows the payloads", async () => {
		const { stderr } = await drive(iso, "debug");
		assert.ok(stderr.includes(CMD_MARKER), "the command shows at debug");
		assert.ok(stderr.includes(ALLOW_MARKER));
		assert.ok(stderr.includes(DENY_MARKER));
		assert.ok(stderr.includes(BODY_MARKER), "the content shows at debug");
	});

	test("the config file sets the level, and the environment overrides it", async () => {
		const file = path.join(iso.root, "log-config.json");
		fs.writeFileSync(file, JSON.stringify({ logLevel: "debug" }));
		const viaFile = await drive(iso, undefined, ["--config", file]);
		assert.ok(viaFile.stderr.includes(CMD_MARKER), "the file turns debug on");
		const overridden = await drive(iso, "info", ["--config", file]);
		assert.ok(!overridden.stderr.includes(CMD_MARKER), "the env wins");
	});
});
