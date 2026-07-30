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
		// Tests that seed a registry write it before any SessionManager exists.
		fs.mkdirSync(path.join(tempHome, ".config", "worker-mcp"), {
			recursive: true,
		});
	});

	after(() => {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		fs.rmSync(tempHome, { recursive: true, force: true });
	});

	test("a session restored from the registry can be respawned", async () => {
		// Sessions reloaded at startup hold their id but have no subprocess.
		fs.writeFileSync(
			path.join(tempHome, ".config", "worker-mcp", "sessions.json"),
			JSON.stringify([{ sessionId: "restored", cwd: "/tmp" }]),
		);
		const manager = new SessionManager();
		assert.strictEqual(
			manager.listSessions().some((s) => s.sessionId === "restored"),
			true,
		);

		// The wedge: a coordinator tries the session first, and that failed
		// attempt used to flip the dead session to IDLE — which then read as
		// "active" and blocked every respawn of the id, permanently.
		assert.throws(() => manager.getSession("restored").sendCommand("hi"));
		assert.notStrictEqual(
			manager.getSession("restored").status,
			"IDLE",
			"a failed send must not make a process-less session look healthy",
		);

		// Reaching the spawn step at all proves the id was not treated as active.
		const previous = process.env.WORKER_MCP_PI_PATH;
		process.env.WORKER_MCP_PI_PATH = "worker-mcp-nonexistent-binary-xyz";
		try {
			await assert.rejects(
				() => manager.createSession("restored", "/tmp"),
				/Failed to start pi/,
				"a dead session must be replaceable, not rejected as active",
			);
		} finally {
			if (previous === undefined) delete process.env.WORKER_MCP_PI_PATH;
			else process.env.WORKER_MCP_PI_PATH = previous;
		}
	});

	test("terminateSession frees the id and drops it from the registry", () => {
		fs.writeFileSync(
			path.join(tempHome, ".config", "worker-mcp", "sessions.json"),
			JSON.stringify([{ sessionId: "doomed", cwd: "/tmp" }]),
		);
		const manager = new SessionManager();

		manager.terminateSession("doomed");

		assert.strictEqual(manager.listSessions().length, 0);
		assert.throws(() => manager.getSession("doomed"), /Session not found/);
		const onDisk = JSON.parse(
			fs.readFileSync(
				path.join(tempHome, ".config", "worker-mcp", "sessions.json"),
				"utf8",
			),
		);
		assert.deepStrictEqual(onDisk, [], "must not come back after a restart");
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

	test("onSessionStatusChange bubbles up from sessions and active task IDs can be queried", () => {
		fs.writeFileSync(
			path.join(tempHome, ".config", "worker-mcp", "sessions.json"),
			JSON.stringify([{ sessionId: "test-events", cwd: "/tmp" }]),
		);
		const manager = new SessionManager();

		let lastEvent: { sessionId: string; status: string; message?: string } | undefined;
		manager.onSessionStatusChange = (sessionId, status, message) => {
			lastEvent = { sessionId, status, message };
		};

		const session = manager.getSession("test-events");
		session.setActiveTaskId("task-123");

		assert.strictEqual(
			manager.findSessionByTaskId("task-123")?.sessionId,
			"test-events",
			"Manager should be able to locate session by active task ID"
		);

		// Trigger an event manually to test wiring
		if (session.onStatusChange) {
			session.onStatusChange("test-events", "CRASHED", "Test crash");
		}
		
		assert.deepStrictEqual(lastEvent, {
			sessionId: "test-events",
			status: "CRASHED",
			message: "Test crash"
		}, "Event should bubble up through onSessionStatusChange");
	});
});
