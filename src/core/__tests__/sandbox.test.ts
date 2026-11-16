import assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { defaultConfig } from "../../config.js";
import {
	buildBwrapArgs,
	findHomeAliases,
	findWorktreeGit,
	parseMountinfo,
	planSandbox,
	probeBwrap,
	protectedInside,
	resolveBwrap,
	SandboxService,
	toolSandboxFlags,
	type SandboxPlan,
	type SandboxStatus,
} from "../sandbox.js";

let root: string;
beforeEach(() => {
	root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "worker-mcp-sandbox-unit-")),
	);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const mk = (...p: string[]) => {
	const d = path.join(root, ...p);
	fs.mkdirSync(d, { recursive: true });
	return d;
};

/** Index of the first `flag a b` triple (or pair) in the argument list. */
function at(args: string[], flag: string, target: string): number {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === flag && args[i + 1] === target) return i;
	}
	return -1;
}

const basePlan = (over: Partial<SandboxPlan> = {}): SandboxPlan => ({
	cwd: "/work/ws",
	privateDir: "/run/user/1000/worker-mcp-1/worker-x",
	hidden: ["/home/u", "/run/user/1000"],
	roHome: ["/home/u/.nix-profile", "/home/u/.pi"],
	rwHome: [],
	overlays: [],
	extraRo: ["/opt/tools"],
	extraRw: ["/var/cache/x"],
	gitRw: [],
	readOnly: [],
	...over,
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: root,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
		encoding: "utf8",
	}).trim();

function fakeBwrap(body: string) {
	const file = path.join(root, "bwrap");
	fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	return file;
}

const svc = (s: Partial<ReturnType<typeof defaultConfig>["sandbox"]>) =>
	new SandboxService({ ...defaultConfig().sandbox, ...s }, {});

function makeWorktree() {
	const main = mk("main");
	git(main, "init", "-q", "-b", "main");
	fs.writeFileSync(path.join(main, "a"), "a");
	git(main, "add", "a");
	git(main, "commit", "-q", "-m", "init");
	const wt = path.join(root, "wt");
	git(main, "worktree", "add", "-q", wt, "-b", "feature");
	return { main, wt };
}

describe("buildBwrapArgs", () => {
	test("starts with the isolation flags, then the read-only root and the tmpfs mounts", () => {
		const a = buildBwrapArgs(basePlan());
		assert.deepStrictEqual(a.slice(0, 5), [
			"--die-with-parent",
			"--unshare-pid",
			"--unshare-ipc",
			"--unshare-uts",
			"--new-session",
		]);
		assert.deepStrictEqual(a.slice(5, 8), ["--ro-bind", "/", "/"]);
		assert.deepStrictEqual(a.slice(8, 14), [
			"--dev",
			"/dev",
			"--proc",
			"/proc",
			"--tmpfs",
			"/tmp",
		]);
		assert.deepStrictEqual(a.slice(-5), [
			"--setenv",
			"TMPDIR",
			"/tmp",
			"--chdir",
			"/work/ws",
		]);
	});

	test("every tmpfs comes before every mount that must stay visible", () => {
		// Workspace and private dir both below /tmp and the home directory.
		const plan = basePlan({
			cwd: "/tmp/ws",
			privateDir: "/tmp/run/worker-x",
			hidden: ["/tmp/home", "/tmp/run"],
			roHome: ["/tmp/home/.pi"],
			extraRo: ["/tmp/tools"],
			extraRw: ["/tmp/cache"],
			gitRw: ["/tmp/home/repo/.git"],
			readOnly: ["/tmp/ws/.git/hooks"],
		});
		const a = buildBwrapArgs(plan);
		const tmpfs = (p: string) => at(a, "--tmpfs", p);
		const lastTmpfs = Math.max(
			tmpfs("/tmp"),
			tmpfs("/tmp/home"),
			tmpfs("/tmp/run"),
		);
		assert.ok(tmpfs("/tmp") < tmpfs("/tmp/home"), "/tmp before home");
		for (const [flag, p] of [
			["--ro-bind-try", "/tmp/home/.pi"],
			["--bind", "/tmp/ws"],
			["--ro-bind", "/tmp/run/worker-x"],
			["--ro-bind-try", "/tmp/tools"],
			["--bind-try", "/tmp/cache"],
			["--bind", "/tmp/home/repo/.git"],
			["--ro-bind", "/tmp/ws/.git/hooks"],
		] as const) {
			const i = at(a, flag, p);
			assert.ok(i > lastTmpfs, `${flag} ${p} comes after the last tmpfs`);
		}
	});

	test("read-only protected paths come after the writable binds they sit in", () => {
		const a = buildBwrapArgs(
			basePlan({
				gitRw: ["/main/.git"],
				readOnly: ["/work/ws/.claude", "/main/.git/hooks"],
			}),
		);
		const ws = at(a, "--bind", "/work/ws");
		const gitAt = at(a, "--bind", "/main/.git");
		assert.ok(at(a, "--ro-bind", "/work/ws/.claude") > ws);
		assert.ok(at(a, "--ro-bind", "/main/.git/hooks") > gitAt);
		assert.ok(
			at(a, "--ro-bind", "/work/ws/.claude") > at(a, "--bind", "/work/ws"),
		);
	});

	test("home is hidden, its provider paths come back, the workspace is read-write", () => {
		const a = buildBwrapArgs(basePlan());
		assert.ok(at(a, "--tmpfs", "/home/u") > -1);
		assert.ok(
			at(a, "--ro-bind-try", "/home/u/.pi") > at(a, "--tmpfs", "/home/u"),
		);
		assert.ok(at(a, "--bind", "/work/ws") > -1);
		// The gate's directory is read-only for the worker.
		assert.ok(at(a, "--ro-bind", "/run/user/1000/worker-mcp-1/worker-x") > -1);
	});

	test("an overlay is a tmpfs followed by its entries, after the read-only mount below it", () => {
		const a = buildBwrapArgs(
			basePlan({
				overlays: [
					{
						dir: "/home/u/.pi/agent",
						entries: ["/home/u/.pi/agent/auth.json"],
					},
				],
			}),
		);
		const ro = at(a, "--ro-bind-try", "/home/u/.pi");
		const t = at(a, "--tmpfs", "/home/u/.pi/agent");
		assert.ok(t > ro);
		assert.ok(at(a, "--ro-bind-try", "/home/u/.pi/agent/auth.json") > t);
	});

	test("no home or runtime tmpfs when there is nothing to hide", () => {
		const a = buildBwrapArgs(basePlan({ hidden: [] }));
		assert.strictEqual(a.filter((x) => x === "--tmpfs").length, 1);
	});
});

describe("planSandbox", () => {
	test("protected paths that exist are mounted read-only; missing ones are not", () => {
		const cwd = mk("ws");
		mk("ws", ".git", "hooks");
		fs.writeFileSync(path.join(cwd, ".git", "config"), "");
		mk("ws", ".claude");
		fs.writeFileSync(path.join(cwd, ".envrc"), "");
		fs.writeFileSync(path.join(cwd, ".env.local"), "");
		fs.writeFileSync(path.join(cwd, "README.md"), "");
		const found = protectedInside(cwd).map((p) => path.relative(cwd, p));
		assert.deepStrictEqual(
			new Set(found),
			new Set([".claude", ".env.local", ".envrc", ".git/config", ".git/hooks"]),
		);
		// .mcp.json, .husky and .pi do not exist: nothing is created for them.
		assert.ok(!found.includes(".mcp.json"));
	});

	test("a protected symlink is left to the gate", () => {
		const cwd = mk("ws");
		const target = mk("elsewhere");
		fs.symlinkSync(target, path.join(cwd, ".claude"));
		assert.deepStrictEqual(protectedInside(cwd), []);
	});

	test("home that does not exist is not hidden; the runtime dir only when deep enough", () => {
		const cwd = mk("ws");
		const priv = mk("priv");
		const plan = planSandbox({
			cwd,
			privateDir: priv,
			home: path.join(root, "no-home"),
			runtimeDir: "/run",
			profile: { roHome: [".pi"], rwHome: [] },
			extraRo: [],
			extraRw: [],
		});
		assert.deepStrictEqual(plan.hidden, []);
		assert.ok(plan.roHome.includes(path.join(root, "no-home", ".pi")));
	});

	test("the workspace is its real path", () => {
		const cwd = mk("ws");
		const link = path.join(root, "link");
		fs.symlinkSync(cwd, link);
		const plan = planSandbox({
			cwd: link,
			privateDir: mk("priv"),
			home: mk("home"),
			profile: { roHome: [], rwHome: [] },
			extraRo: [],
			extraRw: [],
		});
		assert.strictEqual(plan.cwd, cwd);
	});

	test("an overlay lists the entries of the real directory", () => {
		const home = mk("home");
		mk("home", ".pi", "agent");
		fs.writeFileSync(path.join(home, ".pi", "agent", "auth.json"), "{}");
		const plan = planSandbox({
			cwd: mk("ws"),
			privateDir: mk("priv"),
			home,
			profile: {
				roHome: [".pi"],
				rwHome: [],
				overlayHome: [".pi/agent", ".nope"],
			},
			extraRo: [],
			extraRw: [],
		});
		assert.deepStrictEqual(plan.overlays, [
			{
				dir: path.join(home, ".pi", "agent"),
				entries: [path.join(home, ".pi", "agent", "auth.json")],
			},
		]);
	});
});

describe("overlayOmitHome", () => {
	test("leaves the omitted entry out of the overlay", () => {
		const home = mk("home");
		const agent = mk("home", ".pi", "agent");
		fs.writeFileSync(path.join(agent, "auth.json"), "{}");
		fs.mkdirSync(path.join(agent, "skills"));
		const plan = (omit?: string[]) =>
			planSandbox({
				cwd: mk("ws"),
				privateDir: mk("priv"),
				home,
				profile: {
					roHome: [".pi"],
					rwHome: [],
					overlayHome: [".pi/agent"],
					overlayOmitHome: omit,
				},
				extraRo: [],
				extraRw: [],
			}).overlays[0].entries.map((e) => path.basename(e));
		assert.deepStrictEqual(new Set(plan()), new Set(["auth.json", "skills"]));
		assert.deepStrictEqual(plan([".pi/agent/skills"]), ["auth.json"]);
	});
});

describe("git worktrees", () => {
	test("binds the common and the worktree git dir, as git reports them", () => {
		const { main, wt } = makeWorktree();
		const common = fs.realpathSync(
			path.resolve(wt, git(wt, "rev-parse", "--git-common-dir")),
		);
		const own = fs.realpathSync(git(wt, "rev-parse", "--absolute-git-dir"));
		assert.strictEqual(common, path.join(fs.realpathSync(main), ".git"));
		const found = findWorktreeGit(fs.realpathSync(wt));
		// The worktree's directory is inside the common one: one mount covers both.
		assert.ok(own.startsWith(`${common}${path.sep}`));
		assert.deepStrictEqual(found.rw, [common]);
		assert.deepStrictEqual(
			new Set(found.readOnly),
			new Set([path.join(common, "config"), path.join(common, "hooks")]),
		);
	});

	test("an ordinary repository needs nothing", () => {
		const main = mk("main");
		git(main, "init", "-q");
		assert.deepStrictEqual(findWorktreeGit(main), { rw: [], readOnly: [] });
	});

	test("a .git file the worker pointed somewhere else is not trusted", () => {
		const cwd = mk("ws");
		const victim = mk("victim");
		fs.writeFileSync(path.join(cwd, ".git"), `gitdir: ${victim}\n`);
		assert.deepStrictEqual(findWorktreeGit(cwd), { rw: [], readOnly: [] });
		// Even a directory that looks like a git dir must point back here.
		for (const d of ["objects", "refs"]) mk("victim", d);
		fs.writeFileSync(path.join(victim, "HEAD"), "ref: refs/heads/main\n");
		assert.deepStrictEqual(findWorktreeGit(cwd), { rw: [], readOnly: [] });
		fs.writeFileSync(path.join(victim, "gitdir"), `${root}/other/.git\n`);
		assert.deepStrictEqual(findWorktreeGit(cwd), { rw: [], readOnly: [] });
	});
});

describe("detection", () => {
	test("resolveBwrap: config, then WORKER_MCP_BWRAP, then PATH", () => {
		const bin = mk("bin");
		fs.writeFileSync(path.join(bin, "bwrap"), "", { mode: 0o755 });
		const env = { PATH: bin };
		assert.strictEqual(resolveBwrap({ env }), path.join(bin, "bwrap"));
		assert.strictEqual(
			resolveBwrap({ env: { ...env, WORKER_MCP_BWRAP: "/x/env-bwrap" } }),
			"/x/env-bwrap",
		);
		assert.strictEqual(
			resolveBwrap({
				bwrapPath: "/x/config-bwrap",
				env: { ...env, WORKER_MCP_BWRAP: "/x/env-bwrap" },
			}),
			"/x/config-bwrap",
		);
		assert.strictEqual(resolveBwrap({ env: { PATH: mk("empty") } }), undefined);
	});

	test("probeBwrap reports a bwrap that fails, with its reason", async () => {
		const bad = fakeBwrap(
			'echo "bwrap: No permissions to create new namespace" >&2; exit 1',
		);
		const status = await probeBwrap(bad);
		assert.strictEqual(status.available, false);
		assert.match(status.reason ?? "", /No permissions to create new namespace/);
		const good = fakeBwrap("exit 0");
		assert.deepStrictEqual(await probeBwrap(good), {
			available: true,
			bwrap: good,
			nested: { available: true },
		});
	});

	test("probeBwrap reports apart that a sandbox cannot start inside the sandbox", async () => {
		const noNesting = fakeBwrap(
			'case " $* " in *" --bind / / "*) echo "bwrap: creating new namespace failed" >&2; exit 1;; esac; exit 0',
		);
		const status = await probeBwrap(noNesting);
		assert.strictEqual(status.available, true);
		assert.strictEqual(status.nested?.available, false);
		assert.match(status.nested?.reason ?? "", /creating new namespace failed/);
	});

	test("the check runs once and its result is cached", async () => {
		let probes = 0;
		const service = new SandboxService(
			{ ...defaultConfig().sandbox, bwrapPath: "/x/bwrap" },
			{},
			"linux",
			async (bwrap) => {
				probes++;
				return { available: true, bwrap };
			},
		);
		await Promise.all([service.status(), service.status()]);
		await service.status();
		assert.strictEqual(probes, 1);
	});

	test("not Linux, or no bwrap: unavailable with a reason, nothing probed", async () => {
		const mac = new SandboxService(defaultConfig().sandbox, {}, "darwin");
		const s = await mac.status();
		assert.strictEqual(s.available, false);
		assert.match(s.reason ?? "", /no sandbox/);
		const none = new SandboxService(
			defaultConfig().sandbox,
			{ PATH: mk("empty") },
			"linux",
		);
		assert.match((await none.status()).reason ?? "", /not found/);
	});

	test("wrap refuses to run before the check passed", () => {
		const service = new SandboxService(defaultConfig().sandbox, {}, "linux");
		assert.throws(
			() =>
				service.wrap(["pi"], {
					cwd: root,
					privateDir: root,
					env: { HOME: root },
				}),
			/not available/,
		);
	});
});

describe("resolveMode", () => {
	test("default is workspace when available, none when not (with a warning)", () => {
		assert.strictEqual(svc({}).resolveMode(undefined, true).mode, "workspace");
		const r = svc({}).resolveMode(undefined, false);
		assert.strictEqual(r.mode, "none");
		assert.match(r.notes[0], /WITHOUT a sandbox/);
	});

	test("a configured default is used", () => {
		assert.strictEqual(
			svc({ default: "none" }).resolveMode(undefined, true).mode,
			"none",
		);
	});

	test("a request below the minimum is raised and reported", () => {
		const r = svc({ minimum: "workspace" }).resolveMode("none", true);
		assert.strictEqual(r.mode, "workspace");
		assert.match(r.clamped[0], /raised to "workspace"/);
	});

	test("minimum workspace without a sandbox stays workspace: the caller refuses", () => {
		const r = svc({ minimum: "workspace" }).resolveMode(undefined, false);
		assert.strictEqual(r.mode, "workspace");
		assert.deepStrictEqual(r.notes, []);
	});
});

// Fixture mountinfo: id parent dev root mountpoint options - type source opts
const mi = (...lines: string[]) => `${lines.join("\n")}\n`;
const HOME_ALIAS = mi(
	"20 1 8:2 / / rw - ext4 /dev/disk rw",
	"30 20 8:3 /home /home rw - btrfs /dev/pers rw",
	"31 20 8:3 / /persistent rw - btrfs /dev/pers rw",
	"32 20 0:5 / /tmp rw - tmpfs tmpfs rw",
);

const always = () => true;

const input = (over: Record<string, unknown>) => ({
	cwd: mk("ws"),
	privateDir: mk("priv"),
	home: mk("home"),
	profile: { roHome: [], rwHome: [] },
	extraRo: [],
	extraRw: [],
	...over,
});

describe("parseMountinfo", () => {
	test("reads the fields and optional fields", () => {
		const m = parseMountinfo(
			mi(
				"36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 shared:2 - ext3 /dev/root rw",
			),
		);
		assert.deepStrictEqual(m, [
			{ dev: "98:0", root: "/mnt1", mountPoint: "/mnt2" },
		]);
	});

	test("octal escapes in paths", () => {
		const m = parseMountinfo(
			mi(
				"40 20 8:3 /my\\040home /home/a\\040b rw - btrfs /dev/pers rw",
				"41 20 8:3 /\\303\\244 /x\\134y rw - btrfs /dev/pers rw",
			),
		);
		assert.strictEqual(m[0].root, "/my home");
		assert.strictEqual(m[0].mountPoint, "/home/a b");
		assert.strictEqual(m[1].root, "/\u00e4");
		assert.strictEqual(m[1].mountPoint, "/x\\y");
	});

	test("anything unexpected throws, so the caller fails closed", () => {
		for (const bad of ["", "garbage", "1 2 x /a /b rw - t s o"]) {
			assert.throws(() => parseMountinfo(bad), /mountinfo|mounts/, bad);
		}
	});
});

describe("findHomeAliases", () => {
	test("a bind of the home directory elsewhere (persistent storage)", () => {
		const m = parseMountinfo(HOME_ALIAS);
		assert.deepStrictEqual(findHomeAliases(m, "/home/u", always), [
			"/persistent/home/u",
		]);
	});

	test("a bind of one directory in the home, with the home itself a tmpfs", () => {
		const m = parseMountinfo(
			mi(
				"20 1 8:2 / / rw - ext4 /dev/disk rw",
				"21 20 0:7 / /home/u rw - tmpfs tmpfs rw",
				"22 21 8:3 /home/u/.ssh /home/u/.ssh rw - btrfs /dev/pers rw",
				"23 20 8:3 / /persistent rw - btrfs /dev/pers rw",
			),
		);
		assert.deepStrictEqual(findHomeAliases(m, "/home/u", always), [
			"/persistent/home/u/.ssh",
		]);
	});

	test("a home that is not a mount point, on a device mounted twice", () => {
		const m = parseMountinfo(
			mi(
				"20 1 8:2 / / rw - ext4 /dev/disk rw",
				"21 20 8:2 / /mnt/disk rw - ext4 /dev/disk rw",
			),
		);
		assert.deepStrictEqual(findHomeAliases(m, "/home/u", always), [
			"/mnt/disk/home/u",
		]);
	});

	test("an octal-escaped mount point", () => {
		const m = parseMountinfo(
			mi(
				"20 1 8:2 / / rw - ext4 /dev/disk rw",
				"30 20 8:3 /home /home rw - btrfs /dev/pers rw",
				"31 20 8:3 / /per\\040sistent rw - btrfs /dev/pers rw",
			),
		);
		assert.deepStrictEqual(findHomeAliases(m, "/home/u", always), [
			"/per sistent/home/u",
		]);
	});

	test("a path that is not the same directory is dropped", () => {
		const m = parseMountinfo(HOME_ALIAS);
		assert.deepStrictEqual(
			findHomeAliases(m, "/home/u", () => false),
			[],
		);
	});

	test("a different device gives no alias", () => {
		const m = parseMountinfo(
			mi(
				"20 1 8:2 / / rw - ext4 /dev/disk rw",
				"31 20 8:9 / /other rw - ext4 /dev/other rw",
			),
		);
		assert.deepStrictEqual(findHomeAliases(m, "/home/u", always), []);
	});
});

describe("hiding the home directory", () => {
	test("sandbox.hide paths are hidden, nested and missing ones skipped", () => {
		const a = mk("a");
		const b = mk("a", "b");
		const plan = planSandbox(
			input({ hide: [b, a, path.join(root, "nope")], runtimeDir: undefined }),
		);
		assert.deepStrictEqual(plan.hidden.slice(-1), [a]);
		assert.ok(!plan.hidden.includes(b), "inside another hidden path");
		assert.ok(!plan.hidden.includes(path.join(root, "nope")));
	});

	test("the workspace under a hidden alias is bound back afterwards", () => {
		const hideRoot = mk("persist");
		const cwd = mk("persist", "ws");
		const a = buildBwrapArgs(planSandbox(input({ cwd, hide: [hideRoot] })));
		const tmpfs = at(a, "--tmpfs", hideRoot);
		assert.ok(tmpfs > -1);
		assert.ok(at(a, "--bind", cwd) > tmpfs);
	});

	test("a state directory outside the home directory is hidden; the session directory is bound back, read-write", () => {
		const state = mk("state");
		const sessionDir = mk("state", "workers", "w_aaaa1111", "session");
		const cwd = mk("ws");
		const plan = planSandbox(input({ cwd, stateDir: state, sessionDir }));
		assert.ok(plan.hidden.includes(state));
		assert.strictEqual(plan.sessionDir, sessionDir);
		const a = buildBwrapArgs(plan);
		const hidden = at(a, "--tmpfs", state);
		const bound = at(a, "--bind", sessionDir);
		assert.ok(hidden > -1, "the state directory is under a tmpfs");
		assert.ok(bound > hidden, "bound after it, so it shows through");
		// and nothing else of the state directory is bound
		assert.strictEqual(a.filter((x) => x === state).length, 1);
	});

	test("a state directory inside the home directory needs no extra mount; without a session nothing is bound", () => {
		const home = mk("home");
		const state = mk("home", ".local", "state", "worker-mcp");
		const plan = planSandbox(input({ home, stateDir: state }));
		assert.ok(plan.hidden.includes(home));
		assert.ok(!plan.hidden.includes(state));
		assert.strictEqual(plan.sessionDir ?? null, null);
		const a = buildBwrapArgs(plan);
		assert.ok(!a.some((x) => x.endsWith("/session")));
	});

	test("unreadable mounts fail closed: not available, and no plan", async () => {
		assert.throws(
			() => planSandbox(input({ mountinfo: "garbage" })),
			/mountinfo/,
		);
		const broken = new SandboxService(
			{ ...defaultConfig().sandbox, bwrapPath: "/x/bwrap" },
			{},
			"linux",
			async (bwrap) => ({ available: true, bwrap }),
			() => {
				throw new Error("cannot read /proc/self/mountinfo (EACCES)");
			},
		);
		const s = await broken.status();
		assert.strictEqual(s.available, false);
		assert.match(s.reason ?? "", /cannot be hidden reliably/);
	});
});

describe("the second sandbox for shell commands", () => {
	const profile = {
		roHome: [".pi"],
		rwHome: [],
		toolHideHome: [".pi/agent"],
		shellTool: { name: "bash", command: "command" },
	};
	// oxlint-disable-next-line unicorn/consistent-function-scoping -- a test helper next to its use
	const ready = async (
		setting: "auto" | "require" | "off",
		nested?: boolean,
	) => {
		const service = new SandboxService(
			{
				...defaultConfig().sandbox,
				toolIsolation: setting,
				bwrapPath: "/x/bwrap",
			},
			{},
			"linux",
			async (bwrap): Promise<SandboxStatus> => ({
				available: true,
				bwrap,
				nested:
					nested === undefined
						? undefined
						: nested
							? { available: true }
							: { available: false, reason: "no nesting here" },
			}),
			() => "1 0 8:1 / / rw - ext4 /dev/sda rw\n",
		);
		return { service, status: await service.status() };
	};

	test("it has a process table of its own and an empty tmpfs over what it hides", () => {
		const flags = toolSandboxFlags(["/home/u/.pi/agent"]);
		assert.ok(flags.includes("--unshare-pid"));
		assert.ok(flags.includes("--proc"));
		const i = flags.indexOf("--tmpfs");
		assert.strictEqual(flags[i + 1], "/home/u/.pi/agent");
	});

	test("the command is wrapped, quoted, and runs in the shell's directory", async () => {
		const home = mk("home");
		mk("home", ".pi", "agent");
		const { service } = await ready("auto", true);
		const command = "echo 'it'\"'\"'s' $HOME; echo \"x\"";
		const out = service.isolateCommand(command, { home, profile });
		assert.ok(out.startsWith("exec '/x/bwrap' "), out);
		assert.ok(out.includes(`'--tmpfs' '${path.join(home, ".pi", "agent")}'`));
		assert.ok(out.includes('--chdir "$PWD" --'));
		// The original text survives as one word: a shell gives it back as it was.
		const quoted = out.slice(out.indexOf(" -c ") + 4);
		assert.strictEqual(
			execFileSync("sh", ["-c", `printf %s ${quoted}`], { encoding: "utf8" }),
			command,
		);
	});

	test("the session directory is hidden from the command too", async () => {
		const home = mk("home");
		const session = mk("state", "workers", "w_aaaa1111", "session");
		const { service } = await ready("auto", true);
		const out = service.isolateCommand("cat x", {
			home,
			profile,
			hide: [session, path.join(root, "not-there")],
		});
		assert.ok(out.includes(`'--tmpfs' '${session}'`), out);
		assert.ok(!out.includes("not-there"));
	});

	test("a hidden directory that does not exist is left out", async () => {
		const { service } = await ready("auto", true);
		const out = service.isolateCommand("true", {
			home: mk("empty-home"),
			profile,
		});
		assert.ok(!out.includes("--tmpfs"), out);
	});

	test("auto: active when nesting works, a warning when not; require refuses; off is silent", async () => {
		const ok = await ready("auto", true);
		assert.deepStrictEqual(ok.service.resolveToolIsolation(ok.status), {
			active: true,
		});
		const no = await ready("auto", false);
		const r = no.service.resolveToolIsolation(no.status);
		assert.strictEqual(r.active, false);
		assert.match(r.note ?? "", /NOT isolated/);
		assert.match(r.note ?? "", /no nesting here/);
		const unknown = await ready("auto");
		assert.match(
			unknown.service.resolveToolIsolation(unknown.status).note ?? "",
			/not checked/,
		);
		const req = await ready("require", false);
		const e = req.service.resolveToolIsolation(req.status);
		assert.strictEqual(e.active, false);
		assert.match(e.error ?? "", /toolIsolation is require/);
		const reqOk = await ready("require", true);
		assert.strictEqual(
			reqOk.service.resolveToolIsolation(reqOk.status).active,
			true,
		);
		const off = await ready("off", false);
		assert.deepStrictEqual(off.service.resolveToolIsolation(off.status), {
			active: false,
		});
	});
});
