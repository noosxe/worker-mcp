import assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import { probeBwrap, resolveBwrap } from "../../src/core/sandbox.js";
import { gatedBash, textOf, viewOf } from "../helpers/behaviour.js";
import {
	createIsolation,
	type Isolation,
	REPO_ROOT,
	sleep,
	waitUntil,
} from "../helpers/isolation.js";
import { RawServer, RUNTIME } from "../helpers/stdio.js";

/**
 * The workspace sandbox against fake-pi under real bubblewrap. Skipped where
 * bwrap is missing or unprivileged user namespaces are not allowed, such as
 * the Nix build sandbox; the CI job for these tests checks that they ran.
 */
const bwrap = resolveBwrap({ env: process.env });
const probe = bwrap
	? await probeBwrap(bwrap)
	: { available: false, reason: "bwrap is not on PATH" };
const skip = probe.available
	? false
	: `no working bubblewrap: ${probe.reason ?? ""}`;

const hasGit = (() => {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

async function spawnWorker(
	server: RawServer,
	cwd: string,
	extra: Record<string, unknown> = {},
) {
	const res = await server.callTool("spawn_worker", { cwd, ...extra });
	assert.notStrictEqual(res.result.isError, true, textOf(res.result));
	return res.result.structuredContent as {
		worker: { workerId: string; sandbox: string };
		clamped: string[];
		notes: string[];
	};
}

async function exec(server: RawServer, workerId: string, command: string) {
	const res = await server.callTool("start_run", {
		workerId,
		prompt: `scenario:exec:${command}`,
		intent: "sandbox test",
		waitMs: 10_000,
	});
	assert.notStrictEqual(res.result.isError, true, textOf(res.result));
	const view = viewOf(res.result);
	assert.strictEqual(view.state, "completed", view.error ?? "");
	const text = view.output.text ?? "";
	const m = /^exit=(\d+)\n([\s\S]*)$/.exec(text);
	assert.ok(m, `unexpected output: ${text}`);
	return { code: Number(m[1]), out: m[2] };
}

/** An existing directory the outer sandbox can replace with a tmpfs. */
const MOUNT_BASE = ["/mnt", "/srv", "/media", "/opt"].find((d) =>
	fs.existsSync(d),
);

describe(`workspace sandbox (${RUNTIME})`, { skip }, () => {
	let iso: Isolation;
	const servers: RawServer[] = [];
	/** Host directory outside every sandbox mount (not under /tmp). */
	let outside: string;

	before(() => {
		iso = createIsolation();
		// fake-pi's record file lives under /tmp, which the sandbox hides.
		delete iso.env.FAKE_PI_RECORD;
		iso.env.WORKER_MCP_SANDBOX_DEFAULT = "workspace";
		if (bwrap) iso.env.WORKER_MCP_BWRAP = bwrap;
		outside = fs.mkdtempSync("/var/tmp/worker-mcp-sandbox-outside-");
	});
	after(async () => {
		for (const s of servers) await s.dispose();
		fs.rmSync(outside, { recursive: true, force: true });
		await iso.cleanup();
	});

	async function start(): Promise<RawServer> {
		const server = new RawServer(iso);
		servers.push(server);
		await server.initialize();
		return server;
	}

	/** Run a shell command as the worker, ungated; its exit code and output. */

	test("the worker runs sandboxed and the gate still works through its private dir", async () => {
		const server = await start();
		const { worker } = await spawnWorker(server, iso.cwd);
		assert.strictEqual(worker.sandbox, "workspace");
		// The handshake that made spawn succeed read the gate file from the
		// private dir inside the sandbox. A gated call still waits for an answer.
		const res = await server.callTool("start_run", {
			workerId: worker.workerId,
			prompt: gatedBash("rm -rf build"),
			intent: "sandbox test",
			waitMs: 10_000,
		});
		const view = viewOf(res.result);
		assert.strictEqual(view.state, "awaiting_approval");
		await server.callTool("reject_action", {
			approvalId: view.pendingApprovals[0].approvalId,
			reason: "test",
		});
		await server.callTool("terminate_worker", { workerId: worker.workerId });
	});

	test("list_providers reports the sandbox", async () => {
		const server = await start();
		const res = await server.callTool("list_providers", {});
		assert.deepStrictEqual(res.result.structuredContent.sandbox, {
			available: true,
			minimum: "none",
			default: "workspace",
		});
	});

	test("writes outside the workspace fail and never reach the host", async () => {
		const server = await start();
		const { worker } = await spawnWorker(server, iso.cwd);
		const id = worker.workerId;
		const inside = await exec(
			server,
			id,
			"echo ok > inside.txt && cat inside.txt",
		);
		assert.deepStrictEqual(inside, { code: 0, out: "ok\n" });
		assert.strictEqual(
			fs.readFileSync(path.join(iso.cwd, "inside.txt"), "utf8"),
			"ok\n",
		);

		for (const target of [
			path.join(outside, "x"), // another place on the host
			"/etc/worker-mcp-sandbox-test",
			"/usr/worker-mcp-sandbox-test",
		]) {
			const r = await exec(server, id, `echo no > ${target}`);
			assert.notStrictEqual(r.code, 0, `${target} was writable`);
		}
		assert.deepStrictEqual(fs.readdirSync(outside), []);

		// A sibling of the workspace and the home directory are scratch space
		// that goes away with the worker, not the host's.
		const sibling = path.join(iso.root, "sibling");
		await exec(server, id, `mkdir -p ${sibling} && echo x > ${sibling}/f`);
		await exec(server, id, `echo x > "$HOME/note"`);
		assert.ok(!fs.existsSync(sibling), "the host's sibling dir was created");
		assert.ok(!fs.existsSync(path.join(iso.home, "note")));
		await server.callTool("terminate_worker", { workerId: id });
	});

	test("$HOME/.ssh is invisible", async () => {
		fs.mkdirSync(path.join(iso.home, ".ssh"), { mode: 0o700 });
		fs.writeFileSync(path.join(iso.home, ".ssh", "id_test"), "not-a-key\n");
		const server = await start();
		const { worker } = await spawnWorker(server, iso.cwd);
		const id = worker.workerId;
		const ls = await exec(server, id, 'ls -A "$HOME"');
		assert.ok(!ls.out.includes(".ssh"), ls.out);
		const cat = await exec(server, id, 'cat "$HOME/.ssh/id_test"');
		assert.notStrictEqual(cat.code, 0);
		assert.ok(!cat.out.includes("not-a-key"));
		await server.callTool("terminate_worker", { workerId: id });
	});

	test("protected paths are read-only; the rest of the workspace is writable", async () => {
		const cwd = path.join(iso.root, "protected-ws");
		fs.mkdirSync(path.join(cwd, ".git", "hooks"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".git", "config"), "[core]\n");
		for (const d of [".claude", ".husky", ".pi"]) {
			fs.mkdirSync(path.join(cwd, d));
		}
		for (const f of [".mcp.json", ".envrc", ".env"]) {
			fs.writeFileSync(path.join(cwd, f), "{}\n");
		}
		const server = await start();
		const { worker } = await spawnWorker(server, cwd);
		const id = worker.workerId;
		const writes = [
			"echo x > .mcp.json",
			"echo x > .envrc",
			"echo x > .env",
			"touch .claude/settings.json",
			"touch .husky/pre-commit",
			"touch .pi/settings.json",
			"touch .git/hooks/pre-commit",
			"echo x >> .git/config",
			"rm .mcp.json",
		];
		for (const cmd of writes) {
			const r = await exec(server, id, cmd);
			assert.notStrictEqual(r.code, 0, `${cmd} succeeded`);
		}
		for (const f of [".mcp.json", ".envrc", ".env"]) {
			assert.strictEqual(fs.readFileSync(path.join(cwd, f), "utf8"), "{}\n");
		}
		assert.deepStrictEqual(fs.readdirSync(path.join(cwd, ".claude")), []);
		assert.deepStrictEqual(fs.readdirSync(path.join(cwd, ".git", "hooks")), []);
		// Reading them is fine, and the workspace around them stays writable.
		const read = await exec(
			server,
			id,
			"cat .mcp.json && echo y > other.txt && mkdir .git/objects",
		);
		assert.strictEqual(read.code, 0, read.out);
		await server.callTool("terminate_worker", { workerId: id });
	});

	test("a path in the config's extraRo and extraRw is mounted", async () => {
		const ro = path.join(outside, "ro");
		const rw = path.join(outside, "rw");
		fs.mkdirSync(ro);
		fs.mkdirSync(rw);
		fs.writeFileSync(path.join(ro, "file"), "from-host\n");
		const configFile = path.join(iso.root, "sandbox-config.json");
		fs.writeFileSync(
			configFile,
			JSON.stringify({ sandbox: { extraRo: [ro], extraRw: [rw] } }),
			{ mode: 0o600 },
		);
		const saved = iso.env.WORKER_MCP_CONFIG;
		iso.env.WORKER_MCP_CONFIG = configFile;
		try {
			const server = await start();
			const { worker } = await spawnWorker(server, iso.cwd);
			const id = worker.workerId;
			assert.deepStrictEqual(await exec(server, id, `cat ${ro}/file`), {
				code: 0,
				out: "from-host\n",
			});
			assert.notStrictEqual(
				(await exec(server, id, `echo x > ${ro}/new`)).code,
				0,
			);
			assert.strictEqual(
				(await exec(server, id, `echo x > ${rw}/new`)).code,
				0,
			);
			assert.ok(fs.existsSync(path.join(rw, "new")));
			await server.callTool("terminate_worker", { workerId: id });
		} finally {
			if (saved === undefined) delete iso.env.WORKER_MCP_CONFIG;
			else iso.env.WORKER_MCP_CONFIG = saved;
		}
	});

	test("sandbox: none can be asked for, the minimum can forbid it", async () => {
		const server = await start();
		const plain = await spawnWorker(server, iso.cwd, { sandbox: "none" });
		assert.strictEqual(plain.worker.sandbox, "none");
		assert.deepStrictEqual(plain.clamped, []);
		await server.callTool("terminate_worker", {
			workerId: plain.worker.workerId,
		});

		const saved = iso.env.WORKER_MCP_SANDBOX_MINIMUM;
		iso.env.WORKER_MCP_SANDBOX_MINIMUM = "workspace";
		try {
			const strict = await start();
			const raised = await spawnWorker(strict, iso.cwd, { sandbox: "none" });
			assert.strictEqual(raised.worker.sandbox, "workspace");
			assert.match(raised.clamped.join(" "), /minimum/);
			await strict.callTool("terminate_worker", {
				workerId: raised.worker.workerId,
			});
		} finally {
			if (saved === undefined) delete iso.env.WORKER_MCP_SANDBOX_MINIMUM;
			else iso.env.WORKER_MCP_SANDBOX_MINIMUM = saved;
		}
	});

	test("a worker's grandchild dies when the server is SIGKILLed", async () => {
		const server = await start();
		const { worker } = await spawnWorker(server, iso.cwd);
		const beat = path.join(iso.cwd, "heartbeat");
		// Its own session, like a tool pi started, and detached from the pipes.
		await exec(
			server,
			worker.workerId,
			`setsid sh -c 'while :; do date +%s%N > heartbeat; sleep 0.1; done' >/dev/null 2>&1 < /dev/null &`,
		);
		await waitUntil(() => fs.existsSync(beat), 5000, "the heartbeat to start");
		const first = fs.readFileSync(beat, "utf8");
		await waitUntil(
			() => fs.readFileSync(beat, "utf8") !== first,
			5000,
			"the heartbeat to advance",
		);

		server.child.kill("SIGKILL");
		await server.exited;
		await sleep(1000);
		const stopped = fs.readFileSync(beat, "utf8");
		await sleep(800);
		assert.strictEqual(
			fs.readFileSync(beat, "utf8"),
			stopped,
			"the grandchild kept running after the server died",
		);
	});

	test(
		"a git worktree workspace can commit, without reaching the main checkout",
		{
			skip: hasGit ? false : "git is not installed",
		},
		async () => {
			const git = (cwd: string, ...args: string[]) =>
				execFileSync("git", args, {
					cwd,
					env: {
						PATH: process.env.PATH ?? "",
						HOME: iso.root,
						GIT_AUTHOR_NAME: "t",
						GIT_AUTHOR_EMAIL: "t@example.com",
						GIT_COMMITTER_NAME: "t",
						GIT_COMMITTER_EMAIL: "t@example.com",
					},
					encoding: "utf8",
				}).trim();
			const main = path.join(iso.root, "main");
			const wt = path.join(iso.root, "wt");
			fs.mkdirSync(main);
			git(main, "init", "-q", "-b", "main");
			fs.writeFileSync(path.join(main, "a.txt"), "a\n");
			git(main, "add", "a.txt");
			git(main, "commit", "-q", "-m", "init");
			git(main, "worktree", "add", "-q", wt, "-b", "feature");

			const server = await start();
			const { worker } = await spawnWorker(server, wt);
			const id = worker.workerId;
			const commit = await exec(
				server,
				id,
				'echo b > b.txt && git add b.txt && git -c user.name=t -c user.email=t@example.com commit -q -m "from the sandbox" && git log --oneline -1',
			);
			assert.strictEqual(commit.code, 0, commit.out);
			assert.match(
				git(wt, "log", "-1", "--format=%s", "feature"),
				/from the sandbox/,
			);

			// The main checkout is not mounted: a file there only lands in the
			// sandbox's scratch /tmp, which the host check below confirms.
			// The repository's hooks and config stay out of reach.
			const attacks = [
				`echo x > ${main}/.git/hooks/post-commit`,
				`echo x >> ${main}/.git/config`,
			];
			for (const cmd of attacks) {
				const r = await exec(server, id, cmd);
				assert.notStrictEqual(r.code, 0, `${cmd} succeeded`);
			}
			assert.strictEqual(
				fs.readFileSync(path.join(main, "a.txt"), "utf8"),
				"a\n",
			);
			assert.deepStrictEqual(
				fs
					.readdirSync(path.join(main, ".git", "hooks"))
					.filter((f) => !f.endsWith(".sample")),
				[],
			);
			await server.callTool("terminate_worker", { workerId: id });
		},
	);

	test(
		"another path to the home directory is hidden too",
		{
			skip: MOUNT_BASE ? false : "no directory to mount the alias on",
		},
		() => {
			fs.mkdirSync(path.join(iso.home, ".ssh"), { recursive: true });
			fs.writeFileSync(path.join(iso.home, ".ssh", "id_alias"), "x\n");
			const priv = fs.mkdtempSync(path.join(iso.root, "priv-"));
			// An outer sandbox mounts the same home a second time, as persistent
			// storage does (/home and /persistent/home).
			const alias = `${MOUNT_BASE}/alias-home`;
			const run = (script: string) =>
				spawnSync(
					bwrap as string,
					[
						"--bind",
						"/",
						"/",
						"--dev",
						"/dev",
						"--proc",
						"/proc",
						"--tmpfs",
						"/mnt",
						"--bind",
						iso.home,
						alias,
						"--",
						process.execPath,
						script,
						bwrap as string,
						iso.home,
						alias,
						iso.cwd,
						priv,
					],
					{ encoding: "utf8" },
				);
			const r = run(
				path.join(REPO_ROOT, "test", "fixtures", "alias-probe.mjs"),
			);
			if (r.status !== 0 && /namespace|permitted|denied/i.test(r.stderr)) {
				// Nested sandboxes are not allowed here: nothing to test.
				return;
			}
			assert.strictEqual(r.status, 0, r.stderr);
			const got = JSON.parse(r.stdout.trim().split("\n").at(-1) as string);
			assert.ok(got.hidden.includes(alias), `alias not hidden: ${got.hidden}`);
			assert.match(got.out, /via-home: .*No such file/);
			assert.match(got.out, /via-alias: .*No such file/);
			assert.ok(!got.out.includes("id_alias"), got.out);
		},
	);
});
