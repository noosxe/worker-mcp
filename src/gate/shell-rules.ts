import * as path from "node:path";

import { isInside, realResolve } from "./paths.js";
import type { ProtectedHit, ProtectedPaths } from "./protected-paths.js";
import { RiskLevel, maxLevel } from "./risk.js";
import {
	lexShell,
	type Redirect,
	type SimpleCommand,
	type Word,
} from "./shell-lexer.js";

/** One rule outcome for (part of) a shell command. */
export interface Finding {
	level: RiskLevel;
	ruleId: string;
	reason: string;
	/** A protected path is involved: no policy may auto-approve it. */
	hard?: boolean;
}

export interface ShellAssessment extends Finding {
	/** Absolute real paths outside the workspace that the command names. */
	outsidePaths: string[];
}

export interface ShellContext {
	/** The worker's real workspace root. */
	workspace: string;
	home: string;
	protectedPaths: ProtectedPaths;
}

const result = (level: RiskLevel, reason: string, ruleId: string): Finding => ({
	level,
	reason,
	ruleId,
});

/** Paths and names that hold credentials or environment contents. */
const SECRET_PATH_PATTERNS: RegExp[] = [
	/(^|[\s/="'])\.(ssh|aws|gnupg|kube|azure|docker|netrc|npmrc|pypirc|git-credentials)(\/|\s|$|"|')/i,
	/(^|[\s/="'])\.env(\.[\w-]+)?(\s|$|"|')/i,
	/(^|[\s/="'])\.config\/(gh|worker-mcp|gcloud|op)(\/|\s|$)/i,
	/(^|[\s/="'])\.local\/share\/(keyrings|gnupg)(\/|\s|$)/i,
	/(^|[\s/="'])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?(\s|$|"|')/i,
	/\/proc\/[^\s/]+\/(environ|mem|maps)\b/,
	/\/etc\/(shadow|gshadow|sudoers)/,
	/(^|[\s/="'])[\w.-]*\.(pem|key|p12|pfx|keystore|kdbx)(\s|$|"|')/i,
	/(^|[\s/="'])\.?(secrets?|credentials?|tokens?|passwords?)(\.\w+)?(\s|$|"|')/i,
];

export function referencesSecretPath(text: string): boolean {
	return SECRET_PATH_PATTERNS.some((re) => re.test(text));
}

/** Shell keywords that may precede a command: the command after is classified. */
const KEYWORDS = new Set([
	"{",
	"}",
	"!",
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"for",
	"while",
	"until",
	"do",
	"done",
	"case",
	"esac",
	"select",
	"function",
	"coproc",
	"[[",
	"]]",
]);

const SHELLS = new Set([
	"sh",
	"bash",
	"zsh",
	"dash",
	"ksh",
	"fish",
	"csh",
	"tcsh",
]);

const CRITICAL_BASE = new Set([
	"sudo",
	"su",
	"doas",
	"pkexec",
	"chmod",
	"chown",
	"chgrp",
	"chroot",
	"mkfs",
	"dd",
	"fdisk",
	"mount",
	"umount",
	"kill",
	"killall",
	"pkill",
	"shutdown",
	"reboot",
	"halt",
	"poweroff",
	"systemctl",
	"service",
]);

/** Commands that run another command: HIGH, or the inner command's level if higher. */
const WRAPPERS = new Set([
	"env",
	"xargs",
	"nohup",
	"timeout",
	"nice",
	"ionice",
	"command",
	"builtin",
	"busybox",
	"setsid",
	"stdbuf",
	"time",
	"watch",
	"strace",
	"ltrace",
	"script",
	"unshare",
	"chrt",
	"taskset",
	"flock",
	"parallel",
	"nsenter",
	"firejail",
	"bwrap",
	"sh",
	"bash",
	"zsh",
	"dash",
	"ksh",
	"fish",
	"csh",
	"tcsh",
]);

/** Interpreters: with a code flag or a script they run arbitrary code. */
const INTERPRETERS = new Set([
	"python",
	"python2",
	"python3",
	"node",
	"nodejs",
	"deno",
	"bun",
	"perl",
	"ruby",
	"php",
	"lua",
	"luajit",
	"tclsh",
	"Rscript",
	"julia",
	"awk",
	"gawk",
	"mawk",
	"ghc",
	"runghc",
	"swipl",
	"tsx",
	"ts-node",
	"osascript",
]);

/** Package installers, build tools and task runners: they run scripts and hooks. */
const RUNNERS = new Set([
	"npm",
	"pnpm",
	"yarn",
	"npx",
	"pnpx",
	"bunx",
	"corepack",
	"pip",
	"pip3",
	"pipx",
	"uv",
	"uvx",
	"poetry",
	"pdm",
	"cargo",
	"rustc",
	"make",
	"gmake",
	"cmake",
	"ninja",
	"just",
	"task",
	"go",
	"nix",
	"nix-shell",
	"nix-build",
	"gradle",
	"gradlew",
	"mvn",
	"ant",
	"gem",
	"bundle",
	"composer",
	"dotnet",
	"swift",
	"mix",
	"cabal",
	"stack",
	"brew",
	"apt",
	"apt-get",
	"dnf",
	"yum",
	"pacman",
	"snap",
	"flatpak",
	"tsc",
	"jest",
	"vitest",
	"eslint",
	"prettier",
	"mocha",
	"pytest",
]);

const SECRET_DUMPS = new Set([
	"env",
	"printenv",
	"set",
	"export",
	"declare",
	"typeset",
	"compgen",
	"getenv",
]);

const HIGH_BASE = new Set([
	"rm",
	"rmdir",
	"mv",
	"curl",
	"wget",
	"ssh",
	"scp",
	"sftp",
	"rsync",
	"nc",
	"ncat",
	"socat",
	"docker",
	"podman",
	"unlink",
	"shred",
	"truncate",
	"tee",
	"crontab",
	"at",
]);

const MEDIUM_BASE = new Set(["oxlint", "oxfmt", "mkdir", "touch", "ln", "cp"]);

const LOW_BASE = new Set([
	"ls",
	"cat",
	"grep",
	"rg",
	"find",
	"pwd",
	"echo",
	"head",
	"tail",
	"wc",
	"which",
	"whoami",
	"date",
	"tree",
	"file",
	"stat",
	"du",
	"df",
	"uname",
	"hostname",
	"type",
	"less",
	"more",
	"sort",
	"uniq",
	"diff",
	"comm",
	"tr",
	"cut",
	"true",
	"false",
	"test",
	"[",
]);

/** `find` options that run commands or write files. */
const FIND_EXEC = /^-(exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;

/** Options that turn a read-only command into one that executes or writes. */
function lowCommandHasSideEffects(base: string, args: string[]): boolean {
	switch (base) {
		case "find":
			return args.some((a) => FIND_EXEC.test(a));
		case "sort":
			return args.some((a) => a === "-o" || a.startsWith("--output"));
		case "tree":
			return args.some((a) => a === "-o");
		case "rg":
			return args.some(
				(a) => a.startsWith("--pre") || a.startsWith("--hostname-bin"),
			);
		case "uniq":
			return args.filter((a) => !a.startsWith("-")).length > 1;
		case "date":
			return args.some((a) => a === "-s" || a.startsWith("--set"));
		case "hostname":
			return args.some((a) => !a.startsWith("-") || a === "-F");
		default:
			return false;
	}
}

/** Read-only git subcommands. */
const GIT_READ_ONLY = new Set([
	"status",
	"log",
	"diff",
	"show",
	"describe",
	"rev-parse",
	"ls-files",
	"blame",
	"shortlog",
	"rev-list",
	"ls-tree",
	"cat-file",
]);
const GIT_MEDIUM = new Set(["add", "switch", "stash"]);
const GIT_CRITICAL = new Set(["rebase", "filter-branch", "filter-repo"]);
/** Global options that are harmless: `-C` and `--git-dir` take a value. */
const GIT_SAFE_GLOBAL = new Set([
	"--no-pager",
	"-P",
	"--no-optional-locks",
	"--literal-pathspecs",
]);

/** Arguments that make even a read-only subcommand run code or write a file. */
const GIT_DANGEROUS_ARG =
	/^(--output(=.*)?|--upload-pack(=.*)?|--receive-pack(=.*)?|--exec(=.*)?|--ext-diff|--open-files-in-pager(=.*)?|-O.*|-c|--config(-env)?(=.*)?)$/;

const high = (reason: string) => result(RiskLevel.HIGH, reason, "git_mutating");
const critical = (reason: string) =>
	result(RiskLevel.CRITICAL, reason, "critical_command");

function classifyGit(args: string[]): Finding {
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) {
		const opt = args[i];
		if (opt === "-C") {
			i += 2; // takes a directory
		} else if (GIT_SAFE_GLOBAL.has(opt)) {
			i += 1;
		} else {
			// -c (config, hooks path), --upload-pack, --exec-path, --git-dir, ...
			return high(`git global option ${opt} can change what git runs`);
		}
	}
	const sub = args[i];
	const rest = args.slice(i + 1);
	if (!sub) return high("git without a subcommand");

	if (rest.some((a) => GIT_DANGEROUS_ARG.test(a))) {
		return high(`git ${sub} with an option that runs code or writes files`);
	}

	if (
		sub === "config" &&
		!rest.some((a) =>
			/^(--(get|get-all|get-regexp|list|show-origin|show-scope)|-l)$/.test(a),
		)
	) {
		// .git/config can name hooks and filters that run later.
		return {
			...high("git config writes .git/config"),
			ruleId: "protected.runs-later",
			hard: true,
		};
	}
	if (GIT_CRITICAL.has(sub)) return critical(`git ${sub} rewrites history`);
	if (sub === "reset") {
		return rest.some((a) => a === "--hard" || a === "--merge" || a === "--keep")
			? critical("git reset --hard discards work")
			: high("git reset moves the branch or index");
	}
	if (sub === "push") {
		return rest.some(
			(a) =>
				a === "-f" ||
				a.startsWith("--force") ||
				a === "--delete" ||
				a === "-d" ||
				a.startsWith("+") ||
				a.startsWith(":"),
		)
			? critical("git push rewrites or deletes remote refs")
			: high("git push sends data to a remote");
	}
	if (sub === "clean") {
		return rest.some((a) => /^-[a-zA-Z]*[fdx]/.test(a) || a === "--force")
			? critical("git clean deletes untracked files")
			: high("git clean");
	}

	if (GIT_READ_ONLY.has(sub)) {
		return result(RiskLevel.LOW, "Read-only git command", "git_read_only");
	}
	if (sub === "branch") {
		const listing = rest.every((a) =>
			["-a", "-r", "-v", "-vv", "--list", "--show-current", "--all"].includes(
				a,
			),
		);
		return listing
			? result(RiskLevel.LOW, "Read-only git command", "git_read_only")
			: high("git branch changes branches");
	}
	if (sub === "stash" && rest[0] === "list") {
		return result(RiskLevel.LOW, "Read-only git command", "git_read_only");
	}
	if (sub === "checkout") {
		// Plain branch switches are MEDIUM; `--`, `.`, `-f`, `-B` and the like
		// overwrite working-tree files.
		return rest.some((a) => a === "--" || a === "." || /^-[a-zA-Z-]/.test(a))
			? high("git checkout may overwrite working-tree files")
			: result(RiskLevel.MEDIUM, "Medium risk command", "medium_risk_command");
	}
	if (GIT_MEDIUM.has(sub)) {
		return result(
			RiskLevel.MEDIUM,
			"Medium risk command",
			"medium_risk_command",
		);
	}

	// push, commit (runs hooks), fetch, pull, clone, config, remote, submodule,
	// worktree, merge, tag, aliases and anything else unknown.
	return high(`git ${sub} mutates the repository or uses the network`);
}

/** A leading NAME=value is not a command; `find` predicates that filter. */
const FIND_FILTER =
	/^-(name|iname|path|ipath|wholename|iwholename|regex|iregex|type|newer|mtime|mmin|atime|amin|ctime|cmin|size|user|group|empty|perm|lname)$/;

const SAFE_CHMOD_MODE =
	/^([ugoa]*[-+=][rwxX]+(,[ugoa]*[-+=][rwxX]+)*|[0-7]{3})$/;
const SAFE_CHMOD_FLAGS = new Set(["-R", "-v", "-c", "-f", "--recursive"]);

class Accumulator {
	worst: Finding = result(
		RiskLevel.LOW,
		"Low risk command",
		"low_risk_command",
	);
	hard = false;
	outside = new Set<string>();

	raise(f: Finding): void {
		const wins =
			f.level > this.worst.level ||
			(f.level === this.worst.level && f.hard && !this.hard);
		if (wins) this.worst = f;
		if (f.hard) this.hard = true;
	}

	merge(other: ShellAssessment): void {
		this.raise(other);
		for (const p of other.outsidePaths) this.outside.add(p);
	}

	done(): ShellAssessment {
		return {
			...this.worst,
			hard: this.hard || undefined,
			level: this.hard
				? maxLevel(this.worst.level, RiskLevel.HIGH)
				: this.worst.level,
			outsidePaths: [...this.outside],
		};
	}
}

/**
 * Classify a shell command line. The level is the highest over every simple
 * command in it (pipelines, lists, substitutions); anything the lexer cannot
 * parse with confidence is at least HIGH.
 */
export function assessShell(
	command: string,
	ctx: ShellContext,
	depth = 0,
): ShellAssessment {
	const acc = new Accumulator();
	const lexed = lexShell(command, depth);

	if (lexed.unparseable) {
		acc.raise(
			result(
				RiskLevel.HIGH,
				`Shell syntax could not be analysed: ${lexed.unparseable}`,
				"shell.unparseable",
			),
		);
		// Without a parse, fall back to patterns on the raw text.
		if (
			/\|\s*(sh|bash|zsh|dash|ksh)(\s|$)/.test(command) ||
			/(^|[\s;&|(`])(eval|exec)(\s|$)/.test(command)
		) {
			acc.raise(
				result(
					RiskLevel.CRITICAL,
					"Critical pattern detected",
					"critical_pattern",
				),
			);
		}
	} else if (lexed.commands.length === 0) {
		acc.raise(result(RiskLevel.HIGH, "Empty command", "shell.empty"));
	}
	if (lexed.heredoc) {
		acc.raise(result(RiskLevel.HIGH, "Here-document", "shell.heredoc"));
	}
	if (lexed.group) {
		acc.raise(
			result(RiskLevel.HIGH, "Subshell or grouped commands", "shell.group"),
		);
	}
	if (lexed.background) {
		acc.raise(
			result(
				RiskLevel.HIGH,
				"Runs a command in the background",
				"shell.background",
			),
		);
	}
	for (const body of lexed.substitutions) {
		acc.raise(
			result(
				RiskLevel.HIGH,
				"Command or process substitution",
				"shell.substitution",
			),
		);
		acc.merge(assessShell(body, ctx, depth + 1));
	}
	for (const cmd of lexed.commands) {
		assessSimple(cmd, ctx, acc);
	}
	return acc.done();
}

function assessSimple(cmd: SimpleCommand, ctx: ShellContext, acc: Accumulator) {
	let words = cmd.words;
	let writesFile = false;

	for (const r of cmd.redirects) {
		if (redirectWrites(r)) writesFile = true;
	}
	if (cmd.assignments.length > 0) {
		acc.raise(
			result(
				RiskLevel.HIGH,
				"Command runs with environment assignments",
				"env_assignment",
			),
		);
	}
	let keyword = false;
	while (words.length > 0 && !words[0].quoted && KEYWORDS.has(words[0].text)) {
		words = words.slice(1);
		keyword = true;
	}
	if (keyword) {
		acc.raise(
			result(RiskLevel.HIGH, "Shell compound command", "shell.compound"),
		);
	}
	if (words.some((w) => w.dynamic)) {
		acc.raise(
			result(
				RiskLevel.HIGH,
				"Uses a variable or expansion whose value is unknown",
				"shell.expansion",
			),
		);
	}

	let base = "";
	if (words.length === 0) {
		if (cmd.assignments.length === 0 && cmd.redirects.length === 0) {
			acc.raise(result(RiskLevel.HIGH, "No command", "shell.empty"));
		}
	} else {
		const first = words[0];
		base = first.text.includes("/")
			? (first.text.split("/").pop() ?? "")
			: first.text;
		const piped = cmd.after === "|" || cmd.after === "|&";
		if (base === "eval" || base === "exec" || (piped && SHELLS.has(base))) {
			acc.raise(
				result(
					RiskLevel.CRITICAL,
					"Critical pattern detected",
					"critical_pattern",
				),
			);
		}
		const finding = classifyCommandWords(first, words.slice(1), ctx);
		acc.raise(finding);
	}

	// Whether the command only reads, whatever else it was rated for (`cat .env`
	// is rated HIGH for the secret, but it still only reads).
	const argTexts = words.slice(1).map((w) => w.text);
	const reads =
		LOW_BASE.has(base) && !lowCommandHasSideEffects(base, argTexts)
			? true
			: base === "git" && classifyGit(argTexts).ruleId === "git_read_only";
	const readOnly = reads && !writesFile;
	const lowOrMedium = (outside: string) => {
		if (readOnly) {
			acc.raise(
				result(
					RiskLevel.MEDIUM,
					`Reads ${outside} outside the workspace`,
					"shell.outside_workspace",
				),
			);
		} else if (MEDIUM_BASE.has(base)) {
			acc.raise(
				result(
					RiskLevel.HIGH,
					`Writes ${outside} outside the workspace`,
					"shell.outside_workspace",
				),
			);
		}
	};

	// Redirections, then the arguments.
	for (const r of cmd.redirects) {
		if (r.op === "<<" || r.op === "<<-" || r.op === "<<<") continue;
		if ((r.op === ">&" || r.op === "<&") && /^(\d+|-)$/.test(r.target.text))
			continue;
		if (r.target.dynamic) {
			acc.raise(
				result(
					RiskLevel.HIGH,
					"Redirects to a path that is not known",
					"shell.expansion",
				),
			);
			continue;
		}
		if (r.target.text === "/dev/null") continue;
		const writes = redirectWrites(r);
		acc.raise(
			result(
				RiskLevel.HIGH,
				writes ? "Redirects output to a file" : "Redirects input from a file",
				"shell.redirect",
			),
		);
		checkPath(r.target, writes ? "write" : "read", ctx, acc, lowOrMedium);
	}
	if (base !== "echo") {
		for (const arg of words.slice(1)) {
			if (arg.dynamic) continue;
			let text = arg.text;
			if (text.startsWith("-")) {
				const eq = text.indexOf("=");
				if (eq < 0) continue;
				text = text.slice(eq + 1);
			}
			if (text === "" || /^\d+$/.test(text)) continue;
			checkPath(
				{ ...arg, text, tilde: arg.tilde && text === arg.text },
				readOnly ? "read" : "write",
				ctx,
				acc,
				lowOrMedium,
			);
		}
	}
}

const redirectWrites = (r: Redirect) =>
	r.op !== "<" &&
	r.op !== "<<" &&
	r.op !== "<<-" &&
	r.op !== "<<<" &&
	r.op !== "<&";

/** Look one path-like word up: protected, outside the workspace, or fine. */
function checkPath(
	word: Word,
	access: "read" | "write",
	ctx: ShellContext,
	acc: Accumulator,
	outsideRule: (what: string) => void,
): void {
	let text = word.text;
	if (word.tilde) {
		if (text === "~") text = ctx.home;
		else if (text.startsWith("~/")) text = path.join(ctx.home, text.slice(2));
		else {
			acc.raise(
				result(
					RiskLevel.HIGH,
					"Uses another user's home directory",
					"shell.expansion",
				),
			);
			return;
		}
	}
	const real = realResolve(ctx.workspace, text);
	let hit: ProtectedHit | null = null;
	if (word.glob) {
		hit = ctx.protectedPaths.globMayHit(real.abs, access);
		const dirs = text.split("/").slice(0, -1);
		if (!hit && dirs.some((d) => /[*?[]/.test(d) && d.startsWith("."))) {
			hit = {
				id: "glob",
				access,
				level: RiskLevel.HIGH,
				reason: "a glob into a hidden directory",
			};
		}
	} else {
		hit = ctx.protectedPaths.check(real.abs, access);
	}
	if (hit) {
		acc.raise({
			level: hit.level,
			ruleId: `protected.${hit.id}`,
			reason: `Touches a protected path (${hit.reason})`,
			hard: true,
		});
	}
	if (real.unresolved || !isInside(ctx.workspace, real.abs)) {
		acc.outside.add(real.abs);
		outsideRule(real.abs === ctx.home ? "the home directory" : "a path");
	}
}

/** Whether `target` (as written) resolves strictly inside the workspace. */
function strictlyInside(target: Word, ctx: ShellContext): boolean {
	if (target.dynamic) return false;
	let t = target.text;
	if (t === "" || (target.tilde && t !== "~" && !t.startsWith("~/")))
		return false;
	if (target.tilde) t = t === "~" ? ctx.home : path.join(ctx.home, t.slice(2));
	// A glob in the last component stands for everything in its directory.
	const dir =
		target.glob && /[*?[]/.test(path.basename(t)) ? path.dirname(t) : t;
	const real = realResolve(ctx.workspace, dir);
	return (
		!real.unresolved &&
		isInside(ctx.workspace, real.abs) &&
		path.relative(ctx.workspace, real.abs) !== ""
	);
}

/** A deletion target is dangerous unless it resolves strictly inside the workspace. */
const isDangerousTarget = (target: Word, ctx: ShellContext) =>
	!strictlyInside(target, ctx);

function classifyDestructive(
	base: string,
	args: Word[],
	ctx: ShellContext,
): Finding | null {
	const texts = args.map((a) => a.text);
	if (base === "rm") {
		if (texts.includes("--no-preserve-root")) {
			return critical("rm --no-preserve-root");
		}
		const dashDash = texts.indexOf("--");
		const flags = (dashDash < 0 ? texts : texts.slice(0, dashDash)).filter(
			(a) => a.startsWith("-"),
		);
		const targets = args.filter(
			(a, i) => (dashDash >= 0 && i > dashDash) || !a.text.startsWith("-"),
		);
		const sweeping = flags.some(
			(f) =>
				f === "--recursive" ||
				f === "--force" ||
				(!f.startsWith("--") && /[rRf]/.test(f)),
		);
		if (sweeping && targets.some((t) => isDangerousTarget(t, ctx))) {
			return critical("Recursive or forced delete outside the workspace");
		}
	}
	if (base === "find" && texts.includes("-delete")) {
		const del = texts.indexOf("-delete");
		const end = texts.findIndex((a) => /^(-|\(|!)/.test(a));
		const roots = end < 0 ? args : args.slice(0, end);
		const rootList = roots.length
			? roots
			: [
					{
						text: ".",
						quoted: false,
						dynamic: false,
						glob: false,
						tilde: false,
					},
				];
		// Roots must stay inside the workspace; the workspace itself is fine
		// only when a predicate before -delete narrows what is removed.
		const escapes = rootList.some((r) => {
			if (r.dynamic) return true;
			const real = realResolve(ctx.workspace, r.text);
			return real.unresolved || !isInside(ctx.workspace, real.abs);
		});
		if (escapes)
			return critical("find -delete from a root outside the workspace");
		const filtered = texts.slice(0, del).some((a) => FIND_FILTER.test(a));
		if (!filtered) return critical("find -delete without a filter");
		if (texts.some((a) => FIND_EXEC.test(a))) return null;
		return result(
			RiskLevel.MEDIUM,
			"find -delete with a filter inside the workspace",
			"medium_risk_command",
		);
	}
	return null;
}

/** `chmod` with a plain mode on files strictly inside the workspace. */
function isSafeChmod(args: Word[], ctx: ShellContext): boolean {
	const rest = args.filter((a) => !(!a.quoted && SAFE_CHMOD_FLAGS.has(a.text)));
	if (rest.length < 2) return false;
	const [mode, ...targets] = rest;
	if (mode.dynamic || !SAFE_CHMOD_MODE.test(mode.text)) return false;
	return targets.every(
		(t) => !t.text.startsWith("-") && strictlyInside(t, ctx),
	);
}

function classifyCommandWords(
	first: Word,
	args: Word[],
	ctx: ShellContext,
): Finding {
	const base = first.text.includes("/")
		? (first.text.split("/").pop() ?? "")
		: first.text;
	const argTexts = args.map((a) => a.text);

	if (base === "chmod" && isSafeChmod(args, ctx)) {
		return result(
			RiskLevel.MEDIUM,
			"chmod of files inside the workspace",
			"medium_risk_command",
		);
	}
	if (CRITICAL_BASE.has(base)) {
		return result(RiskLevel.CRITICAL, "Critical command", "critical_command");
	}

	const destructive = classifyDestructive(base, args, ctx);
	if (destructive) return destructive;

	// A path to a program or script: it runs whatever the file contains.
	if (first.text.includes("/")) {
		return result(
			RiskLevel.HIGH,
			"Runs a program or script by path",
			"script_execution",
		);
	}

	if (WRAPPERS.has(base)) {
		// The wrapped command is not parsed. Anything critical named in the
		// arguments keeps its level; otherwise HIGH.
		for (let i = 0; i < args.length; i++) {
			if (argTexts[i] === "rm" || argTexts[i] === "find") {
				const found = classifyDestructive(argTexts[i], args.slice(i + 1), ctx);
				if (found) return found;
			}
		}
		return argTexts.some((a) => CRITICAL_BASE.has(a))
			? result(RiskLevel.CRITICAL, "Critical command", "critical_command")
			: result(RiskLevel.HIGH, "Runs another command", "wrapper_command");
	}

	if (
		SECRET_DUMPS.has(base) ||
		referencesSecretPath([first.text, ...argTexts].join(" "))
	) {
		return result(
			RiskLevel.HIGH,
			"Reads secrets or the environment",
			"secret_access",
		);
	}
	if (INTERPRETERS.has(base)) {
		return result(
			RiskLevel.HIGH,
			"Runs code through an interpreter",
			"code_execution",
		);
	}
	if (RUNNERS.has(base)) {
		return result(
			RiskLevel.HIGH,
			"Package installer, build tool or task runner",
			"code_execution",
		);
	}
	if (base === "git") return classifyGit(argTexts);
	if (base === "sed" && argTexts.some((a) => /^-[a-zA-Z]*i/.test(a))) {
		return result(RiskLevel.HIGH, "High risk command", "high_risk_command");
	}
	if (HIGH_BASE.has(base)) {
		return result(RiskLevel.HIGH, "High risk command", "high_risk_command");
	}
	if (MEDIUM_BASE.has(base)) {
		return result(
			RiskLevel.MEDIUM,
			"Medium risk command",
			"medium_risk_command",
		);
	}
	if (LOW_BASE.has(base)) {
		return lowCommandHasSideEffects(base, argTexts)
			? result(
					RiskLevel.HIGH,
					"Normally read-only command with side effects",
					"high_risk_command",
				)
			: result(RiskLevel.LOW, "Low risk command", "low_risk_command");
	}
	return result(RiskLevel.HIGH, "Unknown command", "high_risk_command");
}
