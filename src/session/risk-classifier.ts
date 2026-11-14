import * as os from "node:os";
import * as path from "node:path";

export enum RiskLevel {
	LOW = 0,
	MEDIUM = 1,
	HIGH = 2,
	CRITICAL = 3,
}

export const RISK_LABELS: Record<RiskLevel, string> = {
	[RiskLevel.LOW]: "LOW",
	[RiskLevel.MEDIUM]: "MEDIUM",
	[RiskLevel.HIGH]: "HIGH",
	[RiskLevel.CRITICAL]: "CRITICAL",
};

export interface ClassifiedAction {
	riskLevel: RiskLevel;
	riskLabel: string;
	reason: string;
	matchedRule: string;
}

export interface ToolCallInfo {
	toolName: string;
	input: Record<string, unknown>;
}

export function parseToolFromMessage(
	title: string,
	message: string,
): ToolCallInfo | null {
	if (title === "worker-mcp-gate") {
		try {
			const parsed = JSON.parse(message);
			if (
				typeof parsed.toolName === "string" &&
				typeof parsed.input === "object" &&
				parsed.input !== null
			) {
				return parsed as ToolCallInfo;
			}
		} catch {
			return null;
		}
	} else if (title === "Allow Tool Execution") {
		const match = message.match(
			/^Allow the "(.+?)" tool to run with arguments: (.+)\?$/,
		);
		if (match) {
			try {
				const input = JSON.parse(match[2]);
				return { toolName: match[1], input };
			} catch {
				return null;
			}
		}
	}
	return null;
}

export function classifyAction(
	toolCall: ToolCallInfo,
	workspaceCwd: string,
): ClassifiedAction {
	const { toolName, input } = toolCall;

	if (["bash", "shell", "terminal", "run_command"].includes(toolName)) {
		let cmdStr = "";
		if (typeof input.command === "string") cmdStr = input.command;
		else if (typeof input.cmd === "string") cmdStr = input.cmd;
		else if (typeof input.script === "string") cmdStr = input.script;

		return classifyShellCommandFull(cmdStr, workspaceCwd);
	}

	if (
		["read_file", "search", "grep_file", "list_dir", "view_file"].includes(
			toolName,
		)
	) {
		const pathStr = ["path", "filePath", "file", "targetFile", "TargetFile"]
			.map((key) => input[key])
			.find((v): v is string => typeof v === "string");
		if (pathStr && referencesSecretPath(pathStr)) {
			return {
				riskLevel: RiskLevel.HIGH,
				riskLabel: RISK_LABELS[RiskLevel.HIGH],
				reason: "Read of a credential or secret file",
				matchedRule: "secret_access",
			};
		}
		return {
			riskLevel: RiskLevel.LOW,
			riskLabel: RISK_LABELS[RiskLevel.LOW],
			reason: "Read-only file operation",
			matchedRule: "read_only_file_op",
		};
	}

	if (
		[
			"write_file",
			"edit_file",
			"create_file",
			"write_to_file",
			"replace_file_content",
			"multi_replace_file_content",
		].includes(toolName)
	) {
		let pathStr = "";
		for (const key of [
			"path",
			"filePath",
			"file",
			"targetFile",
			"TargetFile",
			"AbsolutePath",
		]) {
			if (typeof input[key] === "string") {
				pathStr = input[key] as string;
				break;
			}
		}

		if (pathStr && !pathStr.startsWith(workspaceCwd)) {
			return {
				riskLevel: RiskLevel.CRITICAL,
				riskLabel: RISK_LABELS[RiskLevel.CRITICAL],
				reason: "Write operation outside workspace",
				matchedRule: "write_outside_workspace",
			};
		}

		const configFiles = [
			".env",
			"package.json",
			"tsconfig.json",
			".oxlintrc.json",
			".oxfmtrc.json",
			".gitignore",
			"flake.nix",
			"flake.lock",
			".eslintrc",
			".prettierrc",
			"Makefile",
			"Dockerfile",
			"docker-compose.yml",
			"docker-compose.yaml",
		];

		let isConfig = false;
		if (pathStr) {
			isConfig =
				configFiles.some(
					(f) =>
						pathStr.endsWith(`/${f}`) ||
						pathStr === f ||
						pathStr === `${workspaceCwd}/${f}`,
				) || /\.config\.(js|ts|mjs|cjs)$/.test(pathStr);
		}

		if (isConfig) {
			return {
				riskLevel: RiskLevel.HIGH,
				riskLabel: RISK_LABELS[RiskLevel.HIGH],
				reason: "Configuration file write",
				matchedRule: "config_file_write",
			};
		}

		const sourceDirs = [
			"/src/",
			"/lib/",
			"/test/",
			"/tests/",
			"/__tests__/",
			"/spec/",
		];
		let isSource = false;
		if (pathStr) {
			isSource =
				sourceDirs.some((d) => pathStr.includes(d)) ||
				pathStr.startsWith("src/") ||
				pathStr.startsWith(`${workspaceCwd}/src/`);
		}

		if (isSource) {
			return {
				riskLevel: RiskLevel.MEDIUM,
				riskLabel: RISK_LABELS[RiskLevel.MEDIUM],
				reason: "Source/test file write",
				matchedRule: "source_file_write",
			};
		}

		return {
			riskLevel: RiskLevel.HIGH,
			riskLabel: RISK_LABELS[RiskLevel.HIGH],
			reason: "Unknown file write operation",
			matchedRule: "unknown_file_write",
		};
	}

	return {
		riskLevel: RiskLevel.HIGH,
		riskLabel: RISK_LABELS[RiskLevel.HIGH],
		reason: "Unknown tool",
		matchedRule: "unknown_tool",
	};
}

const result = (level: RiskLevel, reason: string, rule: string) => ({
	riskLevel: level,
	riskLabel: RISK_LABELS[level],
	reason,
	matchedRule: rule,
});

/**
 * Anything that lets a shell run more than one command, change where output
 * goes or expand into something else: `; & | < > ` $ ( ) \` and newlines.
 * Conservative on purpose: a quoted `;` counts too, because telling them apart
 * needs a real shell lexer.
 */
const SHELL_METACHARACTERS = /[;&|<>`$()\\\n\r]/;
// `$` alone is kept so `$HOME` stays a token; `$(` starts a new segment.
const SEGMENT_SPLIT = /[;&|<>`)\n\r]+|\$?\(/;

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

function classifyShellCommandFull(cmd: string, cwd: string): ClassifiedAction {
	if (
		/\|\s*(sh|bash|zsh|dash|ksh)(\s|$)/.test(cmd) ||
		/(^|[\s;&|(`])(eval|exec)(\s|$)/.test(cmd)
	) {
		return result(
			RiskLevel.CRITICAL,
			"Critical pattern detected",
			"critical_pattern",
		);
	}

	if (!SHELL_METACHARACTERS.test(cmd)) {
		return classifySingleCommand(cmd, cwd);
	}

	// Chaining, substitution, redirection or an escape: at least HIGH, and as
	// high as the riskiest part.
	let worst = result(
		RiskLevel.HIGH,
		"Shell metacharacters (chaining, substitution or redirection)",
		"shell_metacharacter",
	);
	for (const part of cmd.split(SEGMENT_SPLIT)) {
		if (!part.trim()) continue;
		const res = classifySingleCommand(part, cwd);
		if (res.riskLevel > worst.riskLevel) worst = res;
	}
	return worst;
}

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
const FIND_EXEC =
	/^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;

function classifySingleCommand(rawCmd: string, cwd: string): ClassifiedAction {
	let cmd = rawCmd.trim();

	// Leading `NAME=value` assignments change how the command behaves
	// (`PATH=`, `LD_PRELOAD=`, `GIT_SSH_COMMAND=`): at least HIGH.
	let assigned = false;
	while (/^[A-Za-z_][A-Za-z0-9_]*=\S*(\s+|$)/.test(cmd)) {
		cmd = cmd.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s*/, "");
		assigned = true;
	}
	const inner = classifyCommandWords(cmd, cwd);
	if (assigned && inner.riskLevel < RiskLevel.HIGH) {
		return result(
			RiskLevel.HIGH,
			"Command runs with environment assignments",
			"env_assignment",
		);
	}
	return inner;
}

function classifyCommandWords(cmd: string, cwd: string): ClassifiedAction {
	const parts = cmd.split(/\s+/).filter(Boolean);
	const first = parts[0] ?? "";
	const args = parts.slice(1);
	const base = first.includes("/") ? (first.split("/").pop() ?? "") : first;

	if (CRITICAL_BASE.has(base)) {
		return result(RiskLevel.CRITICAL, "Critical command", "critical_command");
	}

	// A path to a program or script: it runs whatever the file contains.
	if (first.includes("/")) {
		return result(
			RiskLevel.HIGH,
			"Runs a program or script by path",
			"script_execution",
		);
	}

	const destructive = classifyDestructive(base, args, cwd);
	if (destructive) return destructive;

	if (WRAPPERS.has(base)) {
		// The wrapped command is not parsed. Anything critical named in the
		// arguments keeps its level; otherwise HIGH.
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "rm" || args[i] === "find") {
				const found = classifyDestructive(args[i], args.slice(i + 1), cwd);
				if (found) return found;
			}
		}
		const innerCritical = args.some((a) => CRITICAL_BASE.has(a));
		return innerCritical
			? result(RiskLevel.CRITICAL, "Critical command", "critical_command")
			: result(RiskLevel.HIGH, "Runs another command", "wrapper_command");
	}

	if (SECRET_DUMPS.has(base) || referencesSecretPath(cmd)) {
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

	if (base === "git") return classifyGit(args);

	if (base === "sed" && args.some((a) => /^-[a-zA-Z]*i/.test(a))) {
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
		if (lowCommandHasSideEffects(base, args)) {
			return result(
				RiskLevel.HIGH,
				"Normally read-only command with side effects",
				"high_risk_command",
			);
		}
		return result(RiskLevel.LOW, "Low risk command", "low_risk_command");
	}

	return result(RiskLevel.HIGH, "Unknown command", "high_risk_command");
}

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

function classifyGit(args: string[]): ClassifiedAction {
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

/** A deletion target is dangerous unless it resolves strictly inside `cwd`. */
function isDangerousTarget(target: string, cwd: string): boolean {
	const t = target.replace(/^["']|["']$/g, "");
	if (t === "" || /[$`]/.test(t) || /^~[^/]/.test(t)) return true;
	const expanded =
		t === "~" || t.startsWith("~/") ? path.join(os.homedir(), t.slice(1)) : t;
	// A glob in the last component stands for everything in its directory.
	const dir = /[*?[]/.test(path.basename(expanded))
		? path.dirname(expanded)
		: expanded;
	const rel = path.relative(path.resolve(cwd), path.resolve(cwd, dir));
	return rel === "" || rel.startsWith("..") || path.isAbsolute(rel);
}

/**
 * Recursive or forced `rm`, and `find -delete`, aimed at the filesystem root,
 * the home directory, the workspace itself or anything outside it: CRITICAL.
 * Returns null when this is not such a command.
 */
function classifyDestructive(
	base: string,
	args: string[],
	cwd: string,
): ClassifiedAction | null {
	if (base === "rm") {
		if (args.includes("--no-preserve-root")) {
			return critical("rm --no-preserve-root");
		}
		const dashDash = args.indexOf("--");
		const flags = (dashDash < 0 ? args : args.slice(0, dashDash)).filter((a) =>
			a.startsWith("-"),
		);
		const targets = args.filter(
			(a, i) => (dashDash >= 0 && i > dashDash) || !a.startsWith("-"),
		);
		const sweeping = flags.some(
			(f) =>
				f === "--recursive" ||
				f === "--force" ||
				(!f.startsWith("--") && /[rRf]/.test(f)),
		);
		if (sweeping && targets.some((t) => isDangerousTarget(t, cwd))) {
			return critical("Recursive or forced delete outside the workspace");
		}
	}
	if (base === "find" && args.includes("-delete")) {
		const end = args.findIndex((a) => /^(-|\(|!)/.test(a));
		const roots = end < 0 ? args : args.slice(0, end);
		if ((roots.length ? roots : ["."]).some((r) => isDangerousTarget(r, cwd))) {
			return critical("find -delete from a root outside the workspace");
		}
	}
	return null;
}
