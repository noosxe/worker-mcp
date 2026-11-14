import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const FAKE_PI = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"fake-pi.mjs",
);

export const REPO_ROOT = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

export interface Isolation {
	root: string;
	home: string;
	/** A workspace directory for sessions. */
	cwd: string;
	recordFile: string;
	/** Environment for a server process: private HOME and XDG dirs, fake pi. */
	env: Record<string, string>;
	/** Pids of every fake-pi (and grandchild) started under this isolation. */
	workers(): number[];
	grandchildren(): number[];
	/** Declare a leak this test knowingly provokes; it is killed in cleanup. */
	allowLeak(pid: number): void;
	/** Fail if a worker outlived its test; always kills what is left. */
	cleanup(): Promise<void>;
	/** The recorded argv/env of every fake-pi start, in order. */
	starts(): { pid: number; argv: string[]; env: Record<string, string> }[];
	/**
	 * The start record of the worker spawned after `count` earlier ones. A
	 * spawn call returns before the new fake-pi has written its record.
	 */
	workerAfter(
		count: number,
	): Promise<{ pid: number; argv: string[]; env: Record<string, string> }>;
	/** Scenario specs fake-pi has started running, in order. */
	runs(): string[];
	/** Command types fake-pi received, in order. */
	received(): string[];
}

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

export const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitUntil(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 5000,
	what = "condition",
) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await sleep(25);
	}
	throw new Error(`timed out waiting for ${what}`);
}

export const pidGone = (pid: number) => !isAlive(pid);

/**
 * Private HOME, XDG_STATE_HOME and XDG_RUNTIME_DIR: the server writes under
 * ~/.config/worker-mcp and must never touch ~/.pi.
 */
export function createIsolation(): Isolation {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-mcp-test-"));
	const home = path.join(root, "home");
	const state = path.join(root, "state");
	const runtime = path.join(root, "runtime");
	const cwd = path.join(root, "workspace");
	for (const dir of [home, state, runtime, cwd]) fs.mkdirSync(dir);
	fs.chmodSync(runtime, 0o700);
	const recordFile = path.join(root, "fake-pi.jsonl");

	const lines = (): Record<string, any>[] =>
		fs.existsSync(recordFile)
			? fs
					.readFileSync(recordFile, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l))
			: [];
	const leaks = new Set<number>();

	const iso: Isolation = {
		root,
		home,
		cwd,
		recordFile,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: home,
			XDG_STATE_HOME: state,
			XDG_RUNTIME_DIR: runtime,
			WORKER_MCP_PI_PATH: FAKE_PI,
			FAKE_PI_RECORD: recordFile,
			// Workers get a minimal environment; fake-pi's own settings and the
			// variable below are passed through explicitly.
			WORKER_MCP_ENV_PASSTHROUGH:
				"FAKE_PI_*,WM_TEST_PASSED,WM_TEST_PASSED_TOKEN",
			WM_TEST_PASSED: "passed-value",
			WM_TEST_PASSED_TOKEN: "force-dropped-value",
			WM_TEST_NOT_PASSED: "dropped-value",
			GITHUB_TOKEN: "ghp_test_not_a_real_token",
			AWS_SECRET_ACCESS_KEY: "test-not-a-real-secret",
			MY_API_KEY: "test-not-a-real-key",
			SSH_AUTH_SOCK: "/nonexistent/agent.sock",
		},
		workers: () =>
			lines()
				.filter((l) => l.kind === "start")
				.map((l) => l.pid),
		grandchildren: () =>
			lines()
				.filter((l) => l.kind === "grandchild")
				.map((l) => l.pid),
		starts: () => lines().filter((l) => l.kind === "start") as never,
		workerAfter: async (count) => {
			await waitUntil(
				() => iso.starts().length > count,
				5000,
				"fake-pi to start",
			);
			return iso.starts()[count];
		},
		runs: () =>
			lines()
				.filter((l) => l.kind === "run")
				.map((l) => l.spec),
		received: () =>
			lines()
				.filter((l) => l.kind === "recv")
				.map((l) => l.type),
		allowLeak: (pid) => void leaks.add(pid),
		async cleanup() {
			// Give a just-signalled worker a moment to exit before judging it.
			await waitUntil(
				() => iso.workers().every((p) => leaks.has(p) || pidGone(p)),
				3000,
				"workers to exit",
			).catch(() => {});
			const survivors = iso
				.workers()
				.filter((p) => !leaks.has(p) && !pidGone(p));
			for (const pid of [...iso.workers(), ...iso.grandchildren()]) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// already gone
				}
			}
			fs.rmSync(root, { recursive: true, force: true });
			if (survivors.length > 0) {
				throw new Error(`fake-pi processes survived: ${survivors.join(", ")}`);
			}
		},
	};
	return iso;
}

/** Apply an isolation's environment to this process (in-process tests). */
export function applyEnv(iso: Isolation) {
	const previous: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(iso.env)) {
		previous[key] = process.env[key];
		process.env[key] = value;
	}
	return () => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}
