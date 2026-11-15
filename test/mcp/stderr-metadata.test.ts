import assert from "node:assert";
import { after, before, describe, test } from "node:test";

import { gatedBash } from "../helpers/behaviour.js";
import { createIsolation, type Isolation } from "../helpers/isolation.js";
import { RawServer } from "../helpers/stdio.js";
import { TOOLS } from "../helpers/tools.js";

const CMD_MARKER = "MARKER-CMD-7f3a91";
const BODY_MARKER = "MARKER-BODY-c20d58";
const PATH_MARKER = "marker-path-9be41d";
const REASON_MARKER = "MARKER-REASON-5d77e0";

/**
 * Drives an escalated bash call (approved) and an escalated write call
 * (rejected, with a reason) through the server over stdio, and returns what
 * the server wrote to stderr.
 */
async function drive(iso: Isolation, level?: string): Promise<string> {
	const env = { ...iso.env };
	if (level) env.WORKER_MCP_LOG_LEVEL = level;
	const server = new RawServer({ ...iso, env });
	try {
		await server.initialize();
		const name = `w-${level ?? "default"}`;
		const spawned = await server.callTool(TOOLS.spawn, { name, cwd: iso.cwd });
		assert.notStrictEqual(spawned.result.isError, true);

		const bash = await server.callTool(TOOLS.startRun, {
			workerId: name,
			prompt: gatedBash(`rm -rf build # ${CMD_MARKER}`),
			waitMs: 10_000,
		});
		const bashView = bash.result.structuredContent;
		assert.strictEqual(bashView.state, "awaiting_approval");
		await server.callTool(TOOLS.approve, {
			approvalId: bashView.pendingApprovals[0].approvalId,
		});
		await server.callTool(TOOLS.waitRun, {
			workerId: name,
			runId: bashView.runId,
			waitMs: 10_000,
		});

		// A write outside the workspace is escalated.
		const write = await server.callTool(TOOLS.startRun, {
			workerId: name,
			prompt: `scenario:tool:write:${JSON.stringify({
				path: `/etc/${PATH_MARKER}`,
				content: BODY_MARKER,
			})}`,
			waitMs: 10_000,
		});
		const writeView = write.result.structuredContent;
		assert.strictEqual(writeView.state, "awaiting_approval");
		await server.callTool(TOOLS.reject, {
			approvalId: writeView.pendingApprovals[0].approvalId,
			reason: REASON_MARKER,
		});
		await server.callTool(TOOLS.waitRun, {
			workerId: name,
			runId: writeView.runId,
			waitMs: 10_000,
		});
		await server.callTool(TOOLS.terminate, { workerId: name });
	} finally {
		server.child.stdin!.end();
		await server.exited;
		await server.dispose();
	}
	return server.stderr.join("");
}

describe("stderr carries metadata only", () => {
	let iso: Isolation;
	before(() => {
		iso = createIsolation();
	});
	after(() => iso.cleanup());

	test("default level: no tool input, file content, path or reason", async () => {
		const stderr = await drive(iso);
		assert.match(stderr, /\[INTERCEPTED\]/, "the escalation is still logged");
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
		const stderr = await drive(iso, "info");
		for (const marker of [CMD_MARKER, BODY_MARKER, REASON_MARKER]) {
			assert.ok(!stderr.includes(marker), `stderr leaks ${marker}`);
		}
	});

	test("debug level shows the payloads", async () => {
		const stderr = await drive(iso, "debug");
		assert.ok(stderr.includes(CMD_MARKER), "the command shows at debug");
		assert.ok(stderr.includes(BODY_MARKER), "the content shows at debug");
	});
});
