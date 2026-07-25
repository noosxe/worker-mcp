import {
	type ClassifiedAction,
	RiskLevel,
	type ToolCallInfo,
} from "./risk-classifier.js";

export interface RiskOverride {
	/** Glob-style pattern to match against the command string or tool name */
	pattern: string;
	/** Optional glob pattern to match against the target file path (for file operations) */
	pathPattern?: string;
	/** Force allow (auto-approve) or force block (require approval) */
	action: "allow" | "block";
	/** Only apply this override if the classified risk is at or below this level */
	maxRiskLevel?: RiskLevel;
}

export interface RiskPolicy {
	/** Actions at or below this level are auto-approved silently. Default: LOW */
	autoApproveUpTo: RiskLevel;
	/** Actions at or below this level (but above autoApproveUpTo) are auto-approved with notification. Default: MEDIUM */
	notifyUpTo: RiskLevel;
	/** Custom overrides for specific patterns */
	overrides: RiskOverride[];
}

export const DEFAULT_RISK_POLICY: RiskPolicy = {
	autoApproveUpTo: RiskLevel.LOW,
	notifyUpTo: RiskLevel.MEDIUM,
	overrides: [],
};

export interface AutoApproveResult {
	/** Whether the action should be auto-approved */
	approved: boolean;
	/** Whether the coordinator should be notified about the auto-approval */
	notify: boolean;
	/** Reason for the decision */
	reason: string;
	/** The override pattern that triggered this decision, if any */
	matchedOverride?: string;
}

export function matchesPattern(input: string, pattern: string): boolean {
	// Split on glob *, escape each segment for regex, then join with .*
	const segments = pattern.split("*");
	const regexStr =
		"^" +
		segments.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") +
		"$";
	return new RegExp(regexStr).test(input);
}

/** File-related tool names that carry a target path in their input. */
const FILE_TOOLS = [
	"read_file",
	"search",
	"grep_file",
	"list_dir",
	"view_file",
	"write_file",
	"edit_file",
	"create_file",
	"write_to_file",
	"replace_file_content",
	"multi_replace_file_content",
];

/** Input keys that commonly hold file paths across different tool schemas. */
const PATH_KEYS = [
	"path",
	"filePath",
	"file",
	"targetFile",
	"TargetFile",
	"AbsolutePath",
];

/**
 * Extract the target file path from a tool call, if applicable.
 * Returns `null` for non-file tools or when no path is found.
 */
export function getTargetPath(toolCall: ToolCallInfo): string | null {
	if (!FILE_TOOLS.includes(toolCall.toolName)) {
		return null;
	}
	for (const key of PATH_KEYS) {
		if (typeof toolCall.input[key] === "string") {
			return toolCall.input[key] as string;
		}
	}
	return null;
}

export function getCommandString(toolCall: ToolCallInfo): string {
	if (
		["bash", "shell", "terminal", "run_command"].includes(toolCall.toolName)
	) {
		if (typeof toolCall.input.command === "string")
			return toolCall.input.command;
		if (typeof toolCall.input.cmd === "string") return toolCall.input.cmd;
		if (typeof toolCall.input.script === "string") return toolCall.input.script;
		return "";
	}
	if (FILE_TOOLS.includes(toolCall.toolName)) {
		const pathStr = getTargetPath(toolCall);
		return pathStr ? `${toolCall.toolName} ${pathStr}` : toolCall.toolName;
	}
	return toolCall.toolName;
}

export function shouldAutoApprove(
	classified: ClassifiedAction,
	policy: RiskPolicy,
	toolCall: ToolCallInfo,
): AutoApproveResult {
	const cmdStr = getCommandString(toolCall);
	const targetPath = getTargetPath(toolCall);

	// Check overrides first
	for (const override of policy.overrides) {
		const commandMatches =
			matchesPattern(cmdStr, override.pattern) ||
			matchesPattern(toolCall.toolName, override.pattern);

		if (!commandMatches) continue;

		// If pathPattern is specified, require the file path to match too
		if (override.pathPattern !== undefined) {
			if (!targetPath || !matchesPattern(targetPath, override.pathPattern)) {
				continue;
			}
		}

		// If maxRiskLevel is specified, only apply when classified risk is at or below it
		if (
			override.maxRiskLevel !== undefined &&
			classified.riskLevel > override.maxRiskLevel
		) {
			continue;
		}

		const overrideLabel = override.pathPattern
			? `${override.pattern} [path: ${override.pathPattern}]`
			: override.pattern;

		if (override.action === "allow") {
			return {
				approved: true,
				notify: false,
				reason: `Allowed by override: ${overrideLabel}`,
				matchedOverride: override.pattern,
			};
		}
		return {
			approved: false,
			notify: false,
			reason: `Blocked by override: ${overrideLabel}`,
			matchedOverride: override.pattern,
		};
	}

	if (classified.riskLevel <= policy.autoApproveUpTo) {
		return {
			approved: true,
			notify: false,
			reason: "Risk level within auto-approve threshold",
		};
	}

	if (classified.riskLevel <= policy.notifyUpTo) {
		return {
			approved: true,
			notify: true,
			reason: "Risk level within notify threshold",
		};
	}

	return {
		approved: false,
		notify: false,
		reason: "Risk level exceeds policy threshold",
	};
}
