import * as os from "node:os";
import * as path from "node:path";

import { matchGlob } from "./glob.js";
import { isInside, realOrLexical } from "./paths.js";
import { RiskLevel } from "./risk.js";

/**
 * Files a worker must never change without a human saying so, even inside its
 * own workspace: they reconfigure the coordinator, run code later for the
 * user, hold secrets or belong to this server. A hit is a hard limit: no
 * policy, override or classifier can auto-approve it.
 */
export interface ProtectedHit {
	/** The rule that matched. */
	id: string;
	access: "read" | "write";
	level: RiskLevel;
	reason: string;
}

interface Entry {
	/** Lower-cased real path. */
	path: string;
	/** A tree covers everything beneath it, a file only itself. */
	tree: boolean;
}

interface Rule {
	id: string;
	reason: string;
	entries: Entry[];
	/** Extra matcher for patterns a path list can't express. */
	extra?: (lower: string) => boolean;
	/** Level when the path is read, or undefined if reading is fine. */
	read?: RiskLevel;
	/** Level when the path is written. */
	write: RiskLevel;
}

export interface ProtectedPathsOptions {
	/** The worker's real workspace root. */
	workspace: string;
	home?: string;
	stateDir?: string;
	runtimeDir?: string;
	configFile?: string | null;
	/** From config: more paths (absolute or `~/`) protected against writes. */
	extra?: readonly string[];
	/** Provider config directories (a later phase passes them in). */
	providerDirs?: readonly string[];
}

const lower = (p: string) => p.toLowerCase();

/** `.env`, `.env.local`, ...: any file named like that in the workspace. */
const ENV_FILE = /^\.env(\..+)?$/;

export class ProtectedPaths {
	private readonly rules: Rule[];
	private readonly workspace: string;

	constructor(opts: ProtectedPathsOptions) {
		const ws = opts.workspace;
		this.workspace = lower(ws);
		const home = opts.home ?? os.homedir();
		const tree = (p: string): Entry[] => this.entries(p, true);
		const file = (p: string): Entry[] => this.entries(p, false);
		const h = (rel: string) => path.join(home, rel);
		const w = (rel: string) => path.join(ws, rel);
		const gitDir = lower(realOrLexical(w(".git")));

		const stateTrees: string[] = [h(".config/worker-mcp")];
		for (const p of [opts.stateDir, opts.runtimeDir]) if (p) stateTrees.push(p);
		const stateFiles = opts.configFile ? [opts.configFile] : [];

		this.rules = [
			{
				id: "worker-mcp-state",
				reason: "worker-mcp's own state and configuration",
				entries: [...stateTrees.flatMap(tree), ...stateFiles.flatMap(file)],
				read: RiskLevel.HIGH,
				write: RiskLevel.CRITICAL,
			},
			{
				id: "coordinator-config",
				reason: "reconfigures the coordinating agent",
				entries: [
					...file(w(".mcp.json")),
					...tree(w(".claude")),
					...tree(h(".claude")),
					...file(h(".claude.json")),
					...tree(h(".config/Claude")),
				],
				write: RiskLevel.HIGH,
			},
			{
				id: "runs-later",
				reason: "code in it runs later with the user's authority",
				entries: [
					...file(w(".envrc")),
					...tree(w(".husky")),
					...file(h(".bashrc")),
					...file(h(".bash_profile")),
					...file(h(".bash_login")),
					...file(h(".bash_logout")),
					...file(h(".profile")),
					...file(h(".zshrc")),
					...file(h(".zshenv")),
					...file(h(".zprofile")),
					...file(h(".zlogin")),
					...tree(h(".config/fish")),
					...tree(h(".config/autostart")),
					...tree(h(".config/systemd/user")),
				],
				// .git/hooks, .git/config and the same inside submodules.
				extra: (p) => {
					if (!isInside(gitDir, p) || p === gitDir) return false;
					const parts = path.relative(gitDir, p).split(path.sep);
					return (
						parts.includes("hooks") || parts[parts.length - 1] === "config"
					);
				},
				write: RiskLevel.HIGH,
			},
			{
				id: "agent-config",
				reason: "configures the agent that runs the workers",
				entries: [
					...tree(h(".pi")),
					...tree(w(".pi")),
					...(opts.providerDirs ?? []).flatMap(tree),
				],
				write: RiskLevel.HIGH,
			},
			{
				id: "secrets",
				reason: "credentials",
				entries: [
					...tree(h(".ssh")),
					...tree(h(".gnupg")),
					...tree(h(".aws")),
					...tree(h(".config/gh")),
					...file(h(".netrc")),
					...file(h(".docker/config.json")),
					...file(h(".pi/agent/auth.json")),
				],
				extra: (p) =>
					isInside(this.workspace, p) && ENV_FILE.test(path.basename(p)),
				read: RiskLevel.HIGH,
				write: RiskLevel.CRITICAL,
			},
			{
				id: "configured",
				reason: "protected by the server's configuration",
				entries: (opts.extra ?? []).flatMap((p) =>
					tree(p.startsWith("~/") ? path.join(home, p.slice(2)) : p),
				),
				write: RiskLevel.HIGH,
			},
		];
	}

	/** Both the path as written and its real path, lower-cased. */
	private entries(p: string, tree: boolean): Entry[] {
		const real = lower(realOrLexical(p));
		const given = lower(path.resolve(p));
		const all = real === given ? [real] : [real, given];
		// A rule that would cover the whole workspace protects nothing useful
		// and would make every write hard: leave it out.
		return all
			.filter((e) => !(tree && isInside(e, this.workspace)))
			.map((e) => ({ path: e, tree }));
	}

	/**
	 * The most severe rule `abs` (an absolute real path) falls under for this
	 * kind of access, or null.
	 */
	check(abs: string, access: "read" | "write"): ProtectedHit | null {
		const p = lower(abs);
		let hit: ProtectedHit | null = null;
		for (const rule of this.rules) {
			const level = access === "read" ? rule.read : rule.write;
			if (level === undefined) continue;
			const covered =
				rule.entries.some((e) =>
					e.tree ? isInside(e.path, p) : e.path === p,
				) ||
				(rule.extra?.(p) ?? false);
			if (covered && (!hit || level > hit.level)) {
				hit = { id: rule.id, access, level, reason: rule.reason };
			}
		}
		return hit;
	}

	/**
	 * Whether an unquoted glob such as `.e*` or `~/.s*` could expand to a
	 * protected path. `abs` is the pattern resolved like a path. Best effort:
	 * it compares the pattern with every protected entry beneath its directory.
	 */
	globMayHit(abs: string, access: "read" | "write"): ProtectedHit | null {
		const p = lower(abs);
		const dir = path.dirname(p);
		const pattern = path.basename(p);
		// Like the shell, a wildcard at the start never matches a leading dot.
		const hidesDots = !pattern.startsWith(".");
		const probe = (name: string): ProtectedHit | null =>
			(hidesDots && name.startsWith(".")) || !matchGlob(name, pattern)
				? null
				: this.check(path.join(dir, name), access);
		let hit: ProtectedHit | null = null;
		for (const rule of this.rules) {
			for (const e of rule.entries) {
				if (!isInside(dir, e.path) || e.path === dir) continue;
				const first = path.relative(dir, e.path).split(path.sep)[0];
				const found = probe(first);
				if (found && (!hit || found.level > hit.level)) hit = found;
			}
		}
		// `.env*` style names that exist only as a rule on the file name.
		const env = probe(".env");
		if (env && (!hit || env.level > hit.level)) hit = env;
		return hit;
	}
}
