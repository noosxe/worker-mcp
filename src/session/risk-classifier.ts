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

		return classifyShellCommandFull(cmdStr);
	}

	if (
		["read_file", "search", "grep_file", "list_dir", "view_file"].includes(
			toolName,
		)
	) {
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
			"biome.json",
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

function classifyShellCommandFull(cmd: string): ClassifiedAction {
	const criticalPatterns = [
		"| sh",
		"| bash",
		"| zsh",
		"| sh ",
		"| bash ",
		"| zsh ",
		"eval ",
		"exec ",
	];
	if (criticalPatterns.some((p) => cmd.includes(p))) {
		return {
			riskLevel: RiskLevel.CRITICAL,
			riskLabel: RISK_LABELS[RiskLevel.CRITICAL],
			reason: "Critical pattern detected",
			matchedRule: "critical_pattern",
		};
	}

	if (cmd.includes("|")) {
		const pipedCmds = cmd.split("|").map((c) => c.trim());
		let maxLevel = RiskLevel.LOW;
		let highestResult: ClassifiedAction = classifySingleCommand(
			pipedCmds[0] || "",
		);

		for (const pCmd of pipedCmds) {
			const res = classifySingleCommand(pCmd);
			if (res.riskLevel > maxLevel) {
				maxLevel = res.riskLevel;
				highestResult = res;
			}
		}
		return highestResult;
	}

	return classifySingleCommand(cmd);
}

function classifySingleCommand(cmd: string): ClassifiedAction {
	const criticalBase = [
		"sudo",
		"su",
		"doas",
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
	];
	const criticalGit = [
		"git reset --hard",
		"git push --force",
		"git push -f",
		"git rebase",
		"git clean -fd",
		"git clean -f",
		"git filter-branch",
	];

	const highBase = [
		"rm",
		"mv",
		"curl",
		"wget",
		"ssh",
		"scp",
		"rsync",
		"nc",
		"ncat",
		"docker",
		"podman",
	];
	const highGit = [
		"git commit",
		"git push",
		"git merge",
		"git tag",
		"git cherry-pick",
	];

	const mediumBase = [
		"pnpm",
		"npm",
		"npx",
		"yarn",
		"pip",
		"pip3",
		"cargo",
		"node",
		"deno",
		"bun",
		"tsc",
		"biome",
		"eslint",
		"prettier",
		"jest",
		"vitest",
		"make",
		"python",
		"python3",
		"mkdir",
		"touch",
		"ln",
		"cp",
	];
	const mediumGit = [
		"git add",
		"git checkout",
		"git switch",
		"git stash",
		"git fetch",
		"git pull",
		"git branch -d",
		"git branch -D",
	];

	const lowBase = [
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
		"env",
		"printenv",
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
	];
	const lowGit = [
		"git status",
		"git log",
		"git diff",
		"git branch",
		"git show",
		"git remote",
		"git stash list",
		"git describe",
		"git rev-parse",
		"git ls-files",
		"git blame",
		"git shortlog",
	];

	const parts = cmd.trim().split(/\s+/);
	const baseCmd = parts[0] || "";

	if (
		criticalBase.includes(baseCmd) ||
		criticalGit.some((g) => cmd.startsWith(g))
	) {
		return {
			riskLevel: RiskLevel.CRITICAL,
			riskLabel: RISK_LABELS[RiskLevel.CRITICAL],
			reason: "Critical command",
			matchedRule: "critical_command",
		};
	}

	if (baseCmd === "sed" && parts.includes("-i")) {
		return {
			riskLevel: RiskLevel.HIGH,
			riskLabel: RISK_LABELS[RiskLevel.HIGH],
			reason: "High risk command",
			matchedRule: "high_risk_command",
		};
	}
	if (highBase.includes(baseCmd) || highGit.some((g) => cmd.startsWith(g))) {
		return {
			riskLevel: RiskLevel.HIGH,
			riskLabel: RISK_LABELS[RiskLevel.HIGH],
			reason: "High risk command",
			matchedRule: "high_risk_command",
		};
	}

	if (
		mediumBase.includes(baseCmd) ||
		mediumGit.some((g) => cmd.startsWith(g))
	) {
		return {
			riskLevel: RiskLevel.MEDIUM,
			riskLabel: RISK_LABELS[RiskLevel.MEDIUM],
			reason: "Medium risk command",
			matchedRule: "medium_risk_command",
		};
	}

	if (lowBase.includes(baseCmd) || lowGit.some((g) => cmd.startsWith(g))) {
		return {
			riskLevel: RiskLevel.LOW,
			riskLabel: RISK_LABELS[RiskLevel.LOW],
			reason: "Low risk command",
			matchedRule: "low_risk_command",
		};
	}

	return {
		riskLevel: RiskLevel.HIGH,
		riskLabel: RISK_LABELS[RiskLevel.HIGH],
		reason: "Unknown command",
		matchedRule: "high_risk_command",
	};
}
