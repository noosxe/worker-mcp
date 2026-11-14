import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { defaultConfig, loadConfig } from "../../src/config.js";
import { RuntimeDir } from "../../src/session/runtime-dir.js";
import { SessionManager } from "../../src/session/session-manager.js";
import { createIsolation, type Isolation } from "../helpers/isolation.js";

let iso: Isolation;

beforeEach(() => {
	iso = createIsolation();
});

afterEach(async () => {
	await iso.cleanup();
});

function managerFor(env: Record<string, string> = iso.env) {
	const { config } = loadConfig([], env);
	return new SessionManager(config, env);
}

const runtimeBase = () => iso.env.XDG_RUNTIME_DIR;

describe("SessionManager", () => {
	test("construction does no I/O", async () => {
		const missing = path.join(iso.root, "nonexistent");
		const env = {
			...iso.env,
			HOME: path.join(missing, "home"),
			XDG_CONFIG_HOME: path.join(missing, "config"),
			XDG_STATE_HOME: path.join(missing, "state"),
			XDG_RUNTIME_DIR: path.join(missing, "runtime"),
		};
		const manager = managerFor(env);
		assert.strictEqual(manager.listSessions().length, 0);
		assert.ok(!fs.existsSync(missing), "nothing may be created");
		// Nor does a manager that is shut down without ever spawning.
		await manager.terminateAll();
		assert.ok(!fs.existsSync(missing));
	});

	test("construction works with a read-only runtime parent", () => {
		const readonly = path.join(iso.root, "readonly");
		fs.mkdirSync(readonly, { mode: 0o500 });
		try {
			const manager = new SessionManager(
				{ ...defaultConfig(), runtimeDir: path.join(readonly, "run") },
				iso.env,
			);
			assert.strictEqual(manager.listSessions().length, 0);
		} finally {
			fs.chmodSync(readonly, 0o700);
		}
	});

	test("sessions.json is neither read nor written", async () => {
		const dir = path.join(iso.home, ".config", "worker-mcp");
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "sessions.json");
		const old = JSON.stringify([{ sessionId: "old", cwd: "/tmp" }]);
		fs.writeFileSync(file, old);

		const manager = managerFor();
		assert.strictEqual(
			manager.listSessions().length,
			0,
			"an old registry must not bring sessions back",
		);
		await manager.createSession("fresh", iso.cwd);
		manager.setRiskPolicy("fresh", {
			...manager.getSession("fresh").riskPolicy,
		});
		await manager.terminateSession("fresh");
		await manager.terminateAll();

		assert.strictEqual(fs.readFileSync(file, "utf8"), old, "left untouched");
		fs.rmSync(file);
		const second = managerFor();
		await second.createSession("again", iso.cwd);
		await second.terminateAll();
		assert.ok(!fs.existsSync(file), "never created");
	});

	test("the runtime dir appears on first spawn and goes on shutdown", async () => {
		const manager = managerFor();
		const instance = path.join(runtimeBase(), `worker-mcp-${process.pid}`);
		assert.ok(!fs.existsSync(instance), "not created by the constructor");

		await manager.createSession("rt", iso.cwd);
		assert.strictEqual(fs.statSync(instance).mode & 0o777, 0o700);
		assert.strictEqual(fs.readdirSync(instance).length, 1, "one gate dir");

		await manager.terminateAll();
		assert.ok(!fs.existsSync(instance), "removed on shutdown");
	});

	test("a failed start does not burn its id", async () => {
		const manager = managerFor();
		await assert.rejects(
			() => manager.createSession("wedged", "/nonexistent/path/xyz"),
			/Workspace directory does not exist/,
		);
		assert.strictEqual(
			manager.listSessions().some((s) => s.sessionId === "wedged"),
			false,
		);
		assert.throws(() => manager.getSession("wedged"), /Session not found/);
	});

	test("a finished session's id can be reused", async () => {
		const manager = managerFor();
		try {
			const first = await manager.createSession("reuse", iso.cwd);
			first.terminate();
			await manager.createSession("reuse", iso.cwd);
			assert.strictEqual(manager.getSession("reuse").isAlive(), true);
		} finally {
			await manager.terminateAll();
		}
	});

	test("terminateSession frees the id", async () => {
		const manager = managerFor();
		await manager.createSession("doomed", iso.cwd);
		await manager.terminateSession("doomed");
		assert.strictEqual(manager.listSessions().length, 0);
		assert.throws(() => manager.getSession("doomed"), /Session not found/);
		await manager.terminateAll();
	});

	test("two managers do not share sessions", async () => {
		const a = managerFor();
		const b = managerFor();
		try {
			await a.createSession("mine", iso.cwd);
			assert.strictEqual(b.listSessions().length, 0);
		} finally {
			await a.terminateAll();
			await b.terminateAll();
		}
	});

	test("runs live in the manager's store and outlive their session", async () => {
		const manager = managerFor();
		try {
			const session = await manager.createSession("keeps", iso.cwd);
			// A long run stays in flight until cancelled, so the checks cannot race.
			const run = await session.startRun("scenario:slow:60000");
			assert.strictEqual(manager.listSessions()[0].currentRunId, run.id);
			assert.strictEqual(manager.findSessionByWorker("keeps"), session);
			session.cancelRun();
			await session.waitText(run);
			assert.strictEqual(manager.runs.get(run.id)?.state, "cancelled");
			await manager.terminateSession("keeps");
			assert.strictEqual(manager.findSessionByWorker("keeps"), null);
			assert.strictEqual(manager.runs.get(run.id)?.state, "cancelled");
		} finally {
			await manager.terminateAll();
		}
	});
});

describe("RuntimeDir", () => {
	test("sweeps instance dirs of dead pids and nothing else", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "worker-mcp-rt-"));
		try {
			// A pid that is certainly not running: a child that has exited.
			const dead = 2 ** 22 + 12345;
			const stale = path.join(base, `worker-mcp-${dead}`);
			fs.mkdirSync(path.join(stale, "worker-x"), { recursive: true });
			const live = path.join(base, `worker-mcp-${process.ppid}`);
			fs.mkdirSync(live);
			const other = path.join(base, "unrelated");
			fs.mkdirSync(other);
			const notDir = path.join(base, `worker-mcp-${dead + 1}`);
			fs.writeFileSync(notDir, "x");

			const runtime = new RuntimeDir(base);
			assert.ok(fs.existsSync(stale), "constructor sweeps nothing");
			runtime.ensure();

			assert.ok(!fs.existsSync(stale), "dead pid's dir swept");
			assert.ok(fs.existsSync(live), "a running pid's dir kept");
			assert.ok(fs.existsSync(other));
			assert.ok(fs.existsSync(notDir), "only directories are removed");
			runtime.dispose();
			assert.ok(!fs.existsSync(runtime.dir));
		} finally {
			fs.rmSync(base, { recursive: true, force: true });
		}
	});
});
