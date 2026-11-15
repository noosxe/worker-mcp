import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Config } from "../config.js";
import { isInside } from "../gate/paths.js";
import { workspaceProtectedPaths } from "../gate/protected-paths.js";

/**
 * The `workspace` sandbox: the worker process runs inside bubblewrap with the
 * whole filesystem read-only, a private `/tmp`, an empty `$HOME` and only the
 * workspace (and a few declared paths) writable. Linux only: macOS has no
 * sandbox, so a spawn there runs with `none`.
 *
 * The network is not restricted: the worker needs it to reach its model API,
 * and it can still read the API key it was given.
 */

/** What a provider needs from the home directory, relative to `$HOME`. */
export interface SandboxProfile {
	/** Visible read-only (the agent's own configuration). */
	roHome: readonly string[];
	/** Visible and writable (a cache the agent cannot work without). */
	rwHome: readonly string[];
	/**
	 * Directories the agent must be able to write into although nothing it
	 * writes may reach the real ones: an empty tmpfs on top, with each entry
	 * of the real directory mounted back read-only. Writes (a lock file, say)
	 * succeed and are gone when the worker is. Only for a directory below one
	 * in `roHome`.
	 */
	overlayHome?: readonly string[];
}

/** Home paths every sandboxed worker keeps, whatever its provider: Nix profiles. */
export const BASE_RO_HOME: readonly string[] = [
	".nix-profile",
	".local/state/nix",
];

export interface SandboxStatus {
	available: boolean;
	/** Why it is not available. */
	reason?: string;
	/** The binary that passed the check. */
	bwrap?: string;
}

// ---- detection --------------------------------------------------------------

/** `bwrap` as configured, else `WORKER_MCP_BWRAP`, else found on PATH. */
export function resolveBwrap(opts: {
	bwrapPath?: string;
	env: NodeJS.ProcessEnv;
}): string | undefined {
	const configured =
		opts.bwrapPath?.trim() || opts.env.WORKER_MCP_BWRAP?.trim();
	if (configured) {
		if (configured.includes("/")) {
			return path.isAbsolute(configured)
				? configured
				: path.resolve(configured);
		}
		return findOnPath(configured, opts.env.PATH);
	}
	return findOnPath("bwrap", opts.env.PATH);
}

function findOnPath(
	name: string,
	pathVar: string | undefined,
): string | undefined {
	for (const dir of (pathVar ?? "").split(path.delimiter)) {
		if (!dir || !path.isAbsolute(dir)) continue;
		const candidate = path.join(dir, name);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			if (fs.statSync(candidate).isFile()) return candidate;
		} catch {
			// not here
		}
	}
	return undefined;
}

/** The isolation flags shared by the real run and the startup check. */
const BASE_FLAGS = [
	"--die-with-parent",
	"--unshare-pid",
	"--unshare-ipc",
	"--unshare-uts",
	"--new-session",
	"--ro-bind",
	"/",
	"/",
	"--dev",
	"/dev",
	"--proc",
	"/proc",
	"--tmpfs",
	"/tmp",
];

/**
 * Run bwrap once with the same isolation as a worker gets and a trivial
 * command. Many systems install bwrap but forbid unprivileged user
 * namespaces (a sysctl, an AppArmor profile, a container), and then every
 * spawn would fail: better to know at startup.
 */
export function probeBwrap(
	bwrap: string,
	timeoutMs = 10_000,
): Promise<SandboxStatus> {
	return new Promise((resolve) => {
		execFile(
			bwrap,
			// The runtime's own binary exists on every system this runs on.
			[...BASE_FLAGS, "--", process.execPath, "--version"],
			{ timeout: timeoutMs, env: { PATH: process.env.PATH ?? "" } },
			(err, _stdout, stderr) => {
				if (!err) {
					resolve({ available: true, bwrap });
					return;
				}
				const detail =
					String(stderr)
						.split("\n")
						.find((l) => l.trim() !== "")
						?.trim() ?? err.message;
				resolve({
					available: false,
					reason: `bubblewrap (${bwrap}) cannot start a sandbox here: ${detail.slice(0, 300)}`,
				});
			},
		);
	});
}

/**
 * Finds bubblewrap, checks once that it works, and wraps worker commands.
 * One per server; the check result is cached.
 */
export class SandboxService {
	private cached: Promise<SandboxStatus> | null = null;
	private result: SandboxStatus | null = null;

	constructor(
		private readonly settings: Config["sandbox"],
		private readonly env: NodeJS.ProcessEnv,
		private readonly platform: NodeJS.Platform = process.platform,
		private readonly probe: (
			bwrap: string,
		) => Promise<SandboxStatus> = probeBwrap,
		private readonly mountinfo: () => string = readMountinfo,
	) {}

	get config(): Config["sandbox"] {
		return this.settings;
	}

	/** Whether the sandbox works; the check runs at most once. */
	status(): Promise<SandboxStatus> {
		this.cached ??= this.check().then((s) => {
			this.result = s;
			return s;
		});
		return this.cached;
	}

	private async check(): Promise<SandboxStatus> {
		if (this.platform !== "linux") {
			return {
				available: false,
				reason:
					"the workspace sandbox needs Linux and bubblewrap; this platform has no sandbox",
			};
		}
		const bwrap = resolveBwrap({
			bwrapPath: this.settings.bwrapPath,
			env: this.env,
		});
		if (!bwrap) {
			return {
				available: false,
				reason:
					"bubblewrap was not found: install it, or set sandbox.bwrapPath (WORKER_MCP_BWRAP)",
			};
		}
		// Hiding the home directory needs the mounts: without them the sandbox
		// could leave it reachable by another path, so it is not offered.
		try {
			parseMountinfo(this.mountinfo());
		} catch (e) {
			return {
				available: false,
				reason: `the mounts cannot be inspected, so the home directory cannot be hidden reliably: ${e instanceof Error ? e.message : String(e)}`,
			};
		}
		return await this.probe(bwrap);
	}

	/**
	 * The mode a spawn runs with, and what to tell the caller. `asked` is the
	 * caller's wish. Never goes below `minimum`; throws nothing: an unavailable
	 * sandbox is the caller's to refuse or warn about.
	 */
	resolveMode(
		asked: Config["sandbox"]["minimum"] | undefined,
		available: boolean,
	): {
		mode: Config["sandbox"]["minimum"];
		clamped: string[];
		notes: string[];
	} {
		const { minimum } = this.settings;
		const clamped: string[] = [];
		const notes: string[] = [];
		// Nobody said "none": the server's default (or the caller) wants one.
		const wantsSandbox =
			asked === "workspace" ||
			(asked === undefined && this.settings.default !== "none");
		let mode =
			asked ?? this.settings.default ?? (available ? "workspace" : "none");
		if (mode === "none" && minimum === "workspace") {
			if (asked === "none") {
				clamped.push(
					'sandbox: "none" was raised to "workspace", the server\'s minimum',
				);
			}
			mode = "workspace";
		}
		if (!available && minimum === "none" && wantsSandbox) {
			mode = "none";
			notes.push(
				"The workspace sandbox is not available on this server, so the worker runs WITHOUT a sandbox: nothing limits what it can read or write.",
			);
		}
		return { mode, clamped, notes };
	}

	/**
	 * `argv` wrapped in bubblewrap. The status check must have succeeded:
	 * throws otherwise, so a worker never runs unsandboxed by accident.
	 */
	wrap(
		argv: readonly string[],
		input: {
			cwd: string;
			privateDir: string;
			env: Record<string, string>;
			profile?: SandboxProfile;
		},
	): string[] {
		if (!this.result?.available || !this.result.bwrap) {
			throw new Error(
				`the workspace sandbox is not available${this.result?.reason ? `: ${this.result.reason}` : ""}`,
			);
		}
		const home = input.env.HOME || os.homedir();
		const plan = planSandbox({
			cwd: input.cwd,
			privateDir: input.privateDir,
			home,
			runtimeDir: input.env.XDG_RUNTIME_DIR,
			hide: this.settings.hide,
			mountinfo: this.mountinfo(),
			profile: input.profile ?? { roHome: [], rwHome: [] },
			extraRo: this.settings.extraRo,
			extraRw: this.settings.extraRw,
		});
		return [this.result.bwrap, ...buildBwrapArgs(plan), "--", ...argv];
	}
}

// ---- the plan ---------------------------------------------------------------

/** Everything the argument builder needs, already looked up on disk. */
export interface SandboxPlan {
	/** Real path of the workspace. */
	cwd: string;
	privateDir: string;
	/**
	 * Directories hidden behind an empty tmpfs: the home
	 * directory and every other path that leads to its data, the runtime
	 * directory (so agent sockets are out of reach) and `sandbox.hide`.
	 */
	hidden: string[];
	roHome: string[];
	rwHome: string[];
	/** Writable scratch over a read-only directory: the tmpfs, then its entries. */
	overlays: { dir: string; entries: string[] }[];
	extraRo: string[];
	extraRw: string[];
	/** Git directories outside the workspace the worker must write (worktrees). */
	gitRw: string[];
	/** Mounted read-only over the writable mounts above, last. */
	readOnly: string[];
}

/**
 * The bubblewrap arguments for a plan, before `--` and the command. The order
 * is the point: a later mount is hidden by an earlier tmpfs over a parent of
 * it, so every tmpfs comes first and every bind that must stay visible after.
 */
export function buildBwrapArgs(plan: SandboxPlan): string[] {
	const args = [...BASE_FLAGS];
	for (const p of plan.hidden) args.push("--tmpfs", p);
	for (const p of plan.roHome) args.push("--ro-bind-try", p, p);
	for (const p of plan.rwHome) args.push("--bind-try", p, p);
	for (const o of plan.overlays) {
		args.push("--tmpfs", o.dir);
		for (const e of o.entries) args.push("--ro-bind-try", e, e);
	}
	args.push("--bind", plan.cwd, plan.cwd);
	// Read-only: pi only reads its gate file, and a worker that could rewrite
	// it would only be changing what its next start loads.
	args.push("--ro-bind", plan.privateDir, plan.privateDir);
	for (const p of plan.extraRo) args.push("--ro-bind-try", p, p);
	for (const p of plan.extraRw) args.push("--bind-try", p, p);
	for (const p of plan.gitRw) args.push("--bind", p, p);
	for (const p of plan.readOnly) args.push("--ro-bind", p, p);
	// The server's TMPDIR may be a directory that only exists outside.
	args.push("--setenv", "TMPDIR", "/tmp");
	args.push("--chdir", plan.cwd);
	return args;
}

export interface PlanInput {
	cwd: string;
	privateDir: string;
	home: string;
	runtimeDir?: string;
	/** Extra paths always hidden (`sandbox.hide`). */
	hide?: readonly string[];
	/** The text of `/proc/self/mountinfo`; read from the system when omitted. */
	mountinfo?: string;
	profile: SandboxProfile;
	extraRo: readonly string[];
	extraRw: readonly string[];
}

const isDir = (p: string): boolean => {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
};

const real = (p: string): string => {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
};

// ---- hiding the home directory ------------------------------------------------

/** One line of `/proc/self/mountinfo`, as far as hiding needs it. */
export interface MountEntry {
	/** `major:minor` of the device. */
	dev: string;
	/** The directory of the filesystem that is mounted here. */
	root: string;
	mountPoint: string;
}

/** Octal escapes (`\040` for a space) of a mountinfo field, as UTF-8. */
function unescapeMount(field: string): string {
	const bytes: number[] = [];
	for (let i = 0; i < field.length; i++) {
		const m = /^\\([0-7]{3})/.exec(field.slice(i, i + 4));
		if (m) {
			bytes.push(Number.parseInt(m[1], 8) & 0xff);
			i += 3;
		} else {
			bytes.push(...Buffer.from(field[i]));
		}
	}
	return Buffer.from(bytes).toString("utf8");
}

/**
 * Parse `/proc/self/mountinfo`. Throws on anything unexpected: a home that
 * cannot be checked against the mounts must not be assumed hidden.
 */
export function parseMountinfo(text: string): MountEntry[] {
	const mounts: MountEntry[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		const f = line.split(" ");
		// id parent dev root mountpoint options [optional fields] - type source opts
		const dash = f.indexOf("-", 6);
		if (dash < 6 || f.length < dash + 3 || !/^\d+:\d+$/.test(f[2])) {
			throw new Error(`cannot parse a mountinfo line: ${line.slice(0, 60)}`);
		}
		const root = unescapeMount(f[3]);
		const mountPoint = unescapeMount(f[4]);
		// Roots such as `net:[4026531992]` (namespace files) are not paths.
		if (!mountPoint.startsWith("/")) {
			throw new Error(`cannot parse a mountinfo line: ${line.slice(0, 60)}`);
		}
		mounts.push({ dev: f[2], root, mountPoint });
	}
	if (mounts.length === 0) throw new Error("mountinfo lists no mounts");
	return mounts;
}

/** The system's mounts as text; throws when they cannot be read. */
export function readMountinfo(): string {
	try {
		return fs.readFileSync("/proc/self/mountinfo", "utf8");
	} catch (e) {
		throw new Error(
			`cannot read /proc/self/mountinfo (${e instanceof Error ? e.message : String(e)})`,
			{ cause: e },
		);
	}
}

const sameFile = (a: string, b: string): boolean => {
	try {
		const x = fs.statSync(a);
		const y = fs.statSync(b);
		return x.dev === y.dev && x.ino === y.ino;
	} catch {
		return false;
	}
};

/**
 * Other paths that lead to the data of `home` (a real path): a bind mount of
 * the same directory elsewhere (`/persistent/home/u` behind `/home/u`), the
 * same device mounted twice, a bind of just one directory in it. Found from
 * the mounts: for the home directory and every mount point inside it, take
 * (device, directory on it); every mount of that device whose directory is a
 * prefix of it gives another path. Only paths that are really the same
 * directory (device and inode) are kept.
 */
export function findHomeAliases(
	mounts: readonly MountEntry[],
	home: string,
	same: (a: string, b: string) => boolean = sameFile,
): string[] {
	const targets: { dev: string; root: string; at: string }[] = [];
	// The mount that contains home: the longest mount point, the latest on a tie.
	let container: MountEntry | undefined;
	for (const m of mounts) {
		if (
			isInside(m.mountPoint, home) &&
			(!container || m.mountPoint.length >= container.mountPoint.length)
		) {
			container = m;
		}
	}
	if (container?.root.startsWith("/")) {
		targets.push({
			dev: container.dev,
			root: path.posix.join(
				container.root,
				path.posix.relative(container.mountPoint, home),
			),
			at: home,
		});
	}
	for (const m of mounts) {
		if (
			m.root.startsWith("/") &&
			m.mountPoint !== home &&
			isInside(home, m.mountPoint)
		) {
			targets.push({ dev: m.dev, root: m.root, at: m.mountPoint });
		}
	}
	const found = new Set<string>();
	for (const t of targets) {
		for (const m of mounts) {
			if (m.dev !== t.dev || !m.root.startsWith("/")) continue;
			if (!isInside(m.root, t.root)) continue;
			const alias = path.posix.join(
				m.mountPoint,
				path.posix.relative(m.root, t.root),
			);
			if (alias === "/" || isInside(home, alias)) continue;
			if (same(alias, t.at)) found.add(alias);
		}
	}
	return [...found];
}

/**
 * What to put an empty tmpfs on. Missing directories are left out (bwrap
 * cannot create a mount point under the read-only root), and so is anything
 * inside another, so the order does not matter.
 */
function hiddenPaths(input: {
	home: string;
	runtimeDir: string | null;
	hide: readonly string[];
	mounts: readonly MountEntry[];
}): string[] {
	const wanted: string[] = [];
	if (input.home !== "/" && isDir(input.home)) {
		const realHome = real(input.home);
		wanted.push(input.home, realHome);
		wanted.push(...findHomeAliases(input.mounts, realHome));
	}
	if (
		input.runtimeDir &&
		path.isAbsolute(input.runtimeDir) &&
		input.runtimeDir.split("/").filter(Boolean).length >= 2
	) {
		wanted.push(input.runtimeDir);
	}
	wanted.push(...input.hide);
	const existing = [...new Set(wanted)].filter((p) => p !== "/" && isDir(p));
	return existing.filter(
		(p) => !existing.some((o) => o !== p && isInside(o, p)),
	);
}

/** Look at the disk and decide what to mount. */
export function planSandbox(input: PlanInput): SandboxPlan {
	const cwd = real(input.cwd);
	const home = path.resolve(input.home);
	const underHome = (rel: string) => path.join(home, rel);
	const git = findWorktreeGit(cwd);
	const readOnly = [
		...protectedInside(cwd),
		...git.readOnly.filter((p) => fs.existsSync(p)),
	];
	const runtimeDir = input.runtimeDir ? path.resolve(input.runtimeDir) : null;
	return {
		cwd,
		privateDir: real(input.privateDir),
		hidden: hiddenPaths({
			home,
			runtimeDir,
			hide: input.hide ?? [],
			mounts: parseMountinfo(input.mountinfo ?? readMountinfo()),
		}),
		roHome: [...BASE_RO_HOME, ...input.profile.roHome].map(underHome),
		rwHome: input.profile.rwHome.map(underHome),
		overlays: (input.profile.overlayHome ?? []).flatMap((rel) => {
			const dir = underHome(rel);
			try {
				return [
					{
						dir,
						entries: fs.readdirSync(dir).map((name) => path.join(dir, name)),
					},
				];
			} catch {
				return []; // no such directory: nothing to overlay
			}
		}),
		extraRo: [...input.extraRo],
		extraRw: [...input.extraRw],
		gitRw: git.rw,
		readOnly,
	};
}

/**
 * Protected files and trees that exist inside the workspace, to mount
 * read-only (the sandbox's second line behind the gate). Missing ones are
 * left to the gate: creating a mount point would create the file. Symlinks
 * and anything whose real path leaves the workspace are skipped.
 */
export function protectedInside(cwd: string): string[] {
	const found: string[] = [];
	const candidates = workspaceProtectedPaths(cwd);
	try {
		for (const name of fs.readdirSync(cwd)) {
			if (/^\.env(\..+)?$/.test(name)) candidates.push(path.join(cwd, name));
		}
	} catch {
		// unreadable: nothing more to add
	}
	for (const p of candidates) {
		try {
			if (fs.lstatSync(p).isSymbolicLink()) continue;
			if (!isInside(cwd, fs.realpathSync(p))) continue;
			found.push(p);
		} catch {
			// does not exist
		}
	}
	return found;
}

export interface WorktreeGit {
	/** Directories to bind read-write. */
	rw: string[];
	/** Inside them, read-only again. */
	readOnly: string[];
}

/**
 * When `<cwd>/.git` is a file (a linked worktree), the repository lives
 * outside the workspace and `git commit` writes there. Returns the worktree's
 * own git directory and the common one, which is what
 * `git rev-parse --git-dir --git-common-dir` reports. They are read from the
 * files git writes instead of by running git: the `.git` file is writable by
 * the worker, and a path in it must not be trusted. A directory is only used
 * when it looks like a git directory and points back at this workspace.
 */
export function findWorktreeGit(cwd: string): WorktreeGit {
	const none: WorktreeGit = { rw: [], readOnly: [] };
	const dotGit = path.join(cwd, ".git");
	let text: string;
	try {
		if (!fs.lstatSync(dotGit).isFile()) return none;
		text = fs.readFileSync(dotGit, "utf8");
	} catch {
		return none;
	}
	const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(text);
	if (!m) return none;
	const gitDir = real(path.resolve(cwd, m[1]));
	if (!isDir(gitDir) || !fs.existsSync(path.join(gitDir, "HEAD"))) return none;

	// A linked worktree's directory names it: `gitdir` holds the path of the
	// `.git` file that points here. A worker cannot forge that for a
	// repository it cannot already write.
	let back: string;
	try {
		back = fs.readFileSync(path.join(gitDir, "gitdir"), "utf8").trim();
	} catch {
		return none;
	}
	if (real(path.resolve(gitDir, back)) !== real(dotGit)) return none;

	let common = gitDir;
	try {
		const rel = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
		if (rel) common = real(path.resolve(gitDir, rel));
	} catch {
		// a git directory without a commondir is its own common directory
	}
	if (
		!isDir(common) ||
		!isDir(path.join(common, "objects")) ||
		!isDir(path.join(common, "refs"))
	) {
		return none;
	}

	const rw = [...new Set([common, gitDir])]
		.filter((d) => !isInside(cwd, d))
		// One inside the other needs only the outer mount.
		.filter((d, _i, all) => !all.some((o) => o !== d && isInside(o, d)));
	return {
		rw,
		// The same protection as `.git/hooks` and `.git/config` in the workspace.
		readOnly: [
			path.join(common, "hooks"),
			path.join(common, "config"),
			path.join(gitDir, "config.worktree"),
		].filter((p) => rw.some((d) => isInside(d, p)) && fs.existsSync(p)),
	};
}
