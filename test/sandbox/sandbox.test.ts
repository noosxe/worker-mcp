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

/** The outer sandbox of the alias test: the same home mounted a second time. */
const outerArgs = (base: string, home: string, alias: string) => [
	"--bind",
	"/",
	"/",
	"--dev",
	"/dev",
	"--proc",
	"/proc",
	"--tmpfs",
	base,
	"--bind",
	home,
	alias,
];

/**
 * Whether a sandbox can start inside another one: some systems (Ubuntu's
 * AppArmor policy) let bwrap create a user namespace but not a nested one.
 */
const nestedSkip: string | false = (() => {
	if (!bwrap || !probe.available || !MOUNT_BASE) {
		return "no directory to mount the alias on, or no working bubblewrap";
	}
	const r = spawnSync(
		bwrap,
		[
			...outerArgs(MOUNT_BASE, "/", `${MOUNT_BASE}/nested-check`).slice(0, 7),
			"--",
			bwrap,
			"--ro-bind",
			"/",
			"/",
			"--unshare-pid",
			"--proc",
			"/proc",
			"--dev",
			"/dev",
			"--",
			process.execPath,
			"--version",
		],
		{ encoding: "utf8" },
	);
	return r.status === 0
		? false
		: `bubblewrap cannot nest here: ${(r.stderr || "no output").trim().split("\n")[0].slice(0, 200)}`;
})();

/** Skip reason for the tests of the second sandbox around shell commands. */
const toolSkip: string | false = probe.nested?.available
	? false
	: `bubblewrap cannot nest here: ${probe.nested?.reason ?? "not checked"}`;

/** What the fake agent's credentials look like: a file, and an env variable. */
const FILE_MARKER = "MARKER-S3-FILE-SECRET";
const ENV_MARKER = "MARKER-S3-ENV-SECRET";

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
		{ skip: nestedSkip },
		() => {
			fs.mkdirSync(path.join(iso.home, ".ssh"), { recursive: true });
			fs.writeFileSync(path.join(iso.home, ".ssh", "id_alias"), "x\n");
			const priv = fs.mkdtempSync(path.join(iso.root, "priv-"));
			const base = MOUNT_BASE as string;
			// An outer sandbox mounts the same home a second time, as persistent
			// storage does (/home and /persistent/home).
			const alias = `${base}/alias-home`;
			const r = spawnSync(
				bwrap as string,
				[
					...outerArgs(base, iso.home, alias),
					"--",
					process.execPath,
					path.join(REPO_ROOT, "test", "fixtures", "alias-probe.mjs"),
					bwrap as string,
					iso.home,
					alias,
					iso.cwd,
					priv,
				],
				{ encoding: "utf8" },
			);
			assert.strictEqual(r.status, 0, r.stderr);
			const got = JSON.parse(r.stdout.trim().split("\n").at(-1) as string);
			// The probe really ran inside the inner sandbox: never an empty pass.
			assert.strictEqual(got.status, 0, got.err);
			assert.ok(got.out.startsWith("probe-ran\n"), got.out);
			assert.ok(got.hidden.includes(alias), `alias not hidden: ${got.hidden}`);
			assert.match(got.out, /via-home: .*No such file/);
			assert.match(got.out, /via-alias: .*No such file/);
			assert.ok(!got.out.includes("id_alias"), got.out);
		},
	);

	describe("the agent's credentials", () => {
		/**
		 * Run a call as the agent would, through the gate, and approve whatever
		 * it asks about: the coordinator saying yes must still not be enough to
		 * read the credentials from a shell command. Returns the final text.
		 */
		// oxlint-disable-next-line unicorn/consistent-function-scoping -- a test helper next to its use
		async function viaGate(
			server: RawServer,
			workerId: string,
			scenario: string,
			rejectHardLimits = false,
		): Promise<string> {
			let res = await server.callTool("start_run", {
				workerId,
				prompt: `scenario:${scenario}`,
				intent: "credential probe",
				waitMs: 10_000,
			});
			let view = viewOf(res.result);
			for (let i = 0; i < 5 && view.state === "awaiting_approval"; i++) {
				const pending = view.pendingApprovals[0];
				if (rejectHardLimits && pending.hardLimit) {
					await server.callTool("reject_action", {
						approvalId: pending.approvalId,
						reason: "hard limit",
					});
				} else {
					await server.callTool("approve_action", {
						approvalId: pending.approvalId,
					});
				}
				res = await server.callTool("wait_run", {
					runId: view.runId,
					waitMs: 10_000,
				});
				view = viewOf(res.result);
			}
			assert.strictEqual(view.state, "completed", view.error ?? "");
			return view.output.text ?? "";
		}

		const AUTH = '"$HOME/.pi/agent/auth.json"';
		/** Every way to read the file or the agent's process from a command. */
		const VECTORS: Record<string, string> = {
			cat: `cat ${AUTH}`,
			head: `head -c 200 ${AUTH}`,
			"cat with a tilde": "cat ~/.pi/agent/auth.json",
			glob: "cat ~/.pi/*/a*",
			cp: `cp ${AUTH} ./copied-auth && cat ./copied-auth`,
			base64: `base64 ${AUTH}; base64 -w0 ${AUTH} | base64 -d`,
			"interpreter (node)": `"${process.execPath}" -e "process.stdout.write(require('fs').readFileSync(process.env.HOME + '/.pi/agent/auth.json', 'utf8'))"`,
			"interpreter (python)": `command -v python3 >/dev/null && python3 -c "import os; print(open(os.environ['HOME'] + '/.pi/agent/auth.json').read())"`,
			symlink: `ln -sf ${AUTH} ./link-to-auth && cat ./link-to-auth`,
			"/proc/<parent>/environ": "cat /proc/$PPID/environ",
			"/proc/*/environ": "cat /proc/[0-9]*/environ",
			"/proc/<parent>/root": 'cat /proc/$PPID/root"$HOME/.pi/agent/auth.json"',
			"/proc/*/cmdline": "cat /proc/[0-9]*/cmdline",
			"/proc/<parent>/fd": "ls -l /proc/$PPID/fd; cat /proc/$PPID/fd/*",
			"the directory listing": 'ls -la "$HOME/.pi/agent"',
			env: "env",
		};

		before(() => {
			fs.mkdirSync(path.join(iso.home, ".pi", "agent"), { recursive: true });
			fs.writeFileSync(
				path.join(iso.home, ".pi", "agent", "auth.json"),
				JSON.stringify({ zai: { type: "api_key", key: FILE_MARKER } }),
			);
			fs.writeFileSync(
				path.join(iso.home, ".pi", "agent", "settings.json"),
				"{}\n",
			);
			// The fake agent holds a credential in its environment, which its
			// children do not inherit (like a key it read at startup).
			iso.env.FAKE_PI_CRED = ENV_MARKER;
		});
		after(() => {
			delete iso.env.FAKE_PI_CRED;
		});

		// oxlint-disable-next-line unicorn/consistent-function-scoping -- a test helper next to its use
		const leaked = (out: string) =>
			out.includes(FILE_MARKER) ||
			out.includes(ENV_MARKER) ||
			out.includes(Buffer.from(FILE_MARKER).toString("base64").slice(0, 20));

		test(
			"with the second sandbox no command can read the file or the agent's process",
			{ skip: toolSkip },
			async () => {
				const server = await start();
				const { worker, notes } = await spawnWorker(server, iso.cwd);
				assert.deepStrictEqual(
					notes.filter((n) => n.includes("NOT isolated")),
					[],
				);
				const id = worker.workerId;
				for (const [name, command] of Object.entries(VECTORS)) {
					const out = await viaGate(server, id, `bash:${command}`);
					assert.ok(!leaked(out), `${name} leaked the credentials: ${out}`);
				}
				// The agent still works: a command sees the workspace, and the
				// agent's own files are an empty directory.
				const ok = await viaGate(
					server,
					id,
					'bash:echo fine > from-tool.txt; ls -A "$HOME/.pi/agent" | wc -l; pwd',
				);
				assert.match(ok, /^exit=0\n0\n/);
				assert.ok(ok.trimEnd().endsWith(fs.realpathSync(iso.cwd)), ok);
				assert.strictEqual(
					fs.readFileSync(path.join(iso.cwd, "from-tool.txt"), "utf8"),
					"fine\n",
				);
				await server.callTool("terminate_worker", { workerId: id });
			},
		);

		test(
			"the second sandbox keeps the first one's limits and the exit status",
			{ skip: toolSkip },
			async () => {
				const server = await start();
				const { worker } = await spawnWorker(server, iso.cwd);
				const id = worker.workerId;
				const out = await viaGate(
					server,
					id,
					"bash:touch /etc/worker-mcp-test 2>&1 | head -c 200; exit 7",
				);
				assert.match(out, /^exit=7\n/);
				assert.match(out, /Read-only file system/);
				assert.ok(!fs.existsSync("/etc/worker-mcp-test"));
				await server.callTool("terminate_worker", { workerId: id });
			},
		);

		test(
			"the vectors are real: without the second sandbox they read the credentials",
			{ skip: toolSkip },
			async () => {
				iso.env.WORKER_MCP_SANDBOX_TOOL_ISOLATION = "off";
				try {
					const server = await start();
					const { worker } = await spawnWorker(server, iso.cwd);
					const id = worker.workerId;
					const file = await viaGate(server, id, `bash:cat ${AUTH}`);
					assert.ok(file.includes(FILE_MARKER), file);
					const proc = await viaGate(
						server,
						id,
						"bash:cat /proc/$PPID/environ",
					);
					assert.ok(proc.includes(ENV_MARKER), proc);
					await server.callTool("terminate_worker", { workerId: id });
				} finally {
					delete iso.env.WORKER_MCP_SANDBOX_TOOL_ISOLATION;
				}
			},
		);

		describe("parallel tool calls", () => {
			/** pi's batch: a shell command that swaps a link in, and a read of that path. */
			// oxlint-disable-next-line unicorn/consistent-function-scoping -- kept next to its use
			async function race(server: RawServer, id: string) {
				const target = path.join(iso.cwd, "swapped");
				fs.rmSync(target, { force: true });
				fs.writeFileSync(target, "harmless\n");
				return await viaGate(
					server,
					id,
					`race:${JSON.stringify([
						{
							tool: "bash",
							input: { command: 'ln -sfn "$HOME/.pi/agent/auth.json" swapped' },
						},
						{ tool: "read", input: { path: target } },
					])}`,
					true,
				);
			}

			test(
				"a read cannot follow a link a concurrent command swapped in: pi's tools run one at a time",
				{ skip: toolSkip },
				async () => {
					const server = await start();
					const { worker } = await spawnWorker(server, iso.cwd);
					const out = await race(server, worker.workerId);
					assert.ok(!leaked(out), out);
					// The read was rated after the command ran: it saw the link.
					assert.match(out, /blocked/);
					await server.callTool("terminate_worker", {
						workerId: worker.workerId,
					});
				},
			);

			test(
				"the race is real: if pi rates every call first and then runs them at once, the link is followed",
				{ skip: toolSkip },
				async () => {
					iso.env.FAKE_PI_PARALLEL = "1";
					try {
						const server = await start();
						const { worker } = await spawnWorker(server, iso.cwd);
						const out = await race(server, worker.workerId);
						assert.ok(out.includes(FILE_MARKER), out);
						await server.callTool("terminate_worker", {
							workerId: worker.workerId,
						});
					} finally {
						delete iso.env.FAKE_PI_PARALLEL;
					}
				},
			);

			test(
				"nothing a command started outlives it, so the next call never races a leftover process",
				{ skip: toolSkip },
				async () => {
					const server = await start();
					const { worker } = await spawnWorker(server, iso.cwd);
					const id = worker.workerId;
					const out = await viaGate(
						server,
						id,
						"bash:(sleep 41 &) ; setsid -f sleep 42; nohup sleep 43 >/dev/null 2>&1 & echo started",
					);
					assert.match(out, /started/);
					await sleep(300);
					const left = spawnSync("pgrep", ["-f", "^sleep 4[123]$"], {
						encoding: "utf8",
					});
					assert.strictEqual(
						left.stdout.trim(),
						"",
						"a process outlived its command",
					);
					await server.callTool("terminate_worker", { workerId: id });
				},
			);
		});

		test("the read tool and /proc paths are hard limits at the gate", async () => {
			const server = await start();
			const { worker } = await spawnWorker(server, iso.cwd);
			const id = worker.workerId;
			const auth = path.join(iso.home, ".pi", "agent", "auth.json");
			for (const target of [
				auth,
				path.join(iso.home, ".pi", "agent", "models.json"),
				"/proc/self/environ",
				"/proc/self/mem",
				`/proc/self/root${auth}`,
			]) {
				const res = await server.callTool("start_run", {
					workerId: id,
					prompt: `scenario:read:${target}`,
					intent: "credential probe",
					waitMs: 10_000,
				});
				const view = viewOf(res.result);
				assert.strictEqual(view.state, "awaiting_approval", target);
				assert.strictEqual(view.pendingApprovals[0].hardLimit, true, target);
				await server.callTool("reject_action", {
					approvalId: view.pendingApprovals[0].approvalId,
					reason: "test",
				});
				const done = viewOf(
					(
						await server.callTool("wait_run", {
							runId: view.runId,
							waitMs: 10_000,
						})
					).result,
				);
				assert.ok(!leaked(done.output.text ?? ""), target);
			}
			await server.callTool("terminate_worker", { workerId: id });
		});

		test("toolIsolation off spawns without the warning", async () => {
			iso.env.WORKER_MCP_SANDBOX_TOOL_ISOLATION = "off";
			try {
				const server = await start();
				const { notes } = await spawnWorker(server, iso.cwd);
				assert.deepStrictEqual(
					notes.filter((n) => n.includes("NOT isolated")),
					[],
				);
			} finally {
				delete iso.env.WORKER_MCP_SANDBOX_TOOL_ISOLATION;
			}
		});
	});
});
