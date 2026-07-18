import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { SessionManager } from "../session/session-manager.js";

// SessionManager writes a registry and the gating extension under the home
// directory, so point HOME at a throwaway directory for these tests.
let tempHome: string;
let previousHome: string | undefined;

describe("SessionManager - Unit Tests", () => {
	before(() => {
		previousHome = process.env.HOME;
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "worker-mcp-test-"));
		process.env.HOME = tempHome;
	});

	after(() => {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		fs.rmSync(tempHome, { recursive: true, force: true });
	});

	test("a session that fails to start does not burn its id", async () => {
		const manager = new SessionManager();

		await assert.rejects(
			() => manager.createSession("wedged", "/nonexistent/path/xyz"),
			/Workspace directory does not exist/,
		);

		assert.strictEqual(
			manager.listSessions().some((s) => s.sessionId === "wedged"),
			false,
			"a session that never started must not stay registered",
		);

		// Previously the leftover entry sat in status IDLE, so every retry failed
		// with "already exists and is active" and the id was unusable forever.
		assert.throws(() => manager.getSession("wedged"), /Session not found/);
	});
});
