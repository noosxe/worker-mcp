import {
	type ClassifiedAction,
	RiskLevel,
	type ToolCallInfo,
} from "./risk-classifier.js";

export interface RiskOverride {
	/** Glob-style pattern to match against the command string or tool name */
	pattern: string;
	/** Force allow (auto-approve) or force block (require approval) */
	action: "allow" | "block";
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
	if (
		[
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
		].includes(toolCall.toolName)
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
			if (typeof toolCall.input[key] === "string") {
				pathStr = toolCall.input[key] as string;
				break;
			}
		}
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
	const _targetStr = ["bash", "shell", "terminal", "run_command"].includes(
		toolCall.toolName,
	)
		? cmdStr
		: toolCall.toolName;

	// Check overrides first
	for (const override of policy.overrides) {
		if (
			matchesPattern(cmdStr, override.pattern) ||
			matchesPattern(toolCall.toolName, override.pattern)
		) {
			if (override.action === "allow") {
				return {
					approved: true,
					notify: false,
					reason: `Allowed by override: ${override.pattern}`,
				};
			} else {
				return {
					approved: false,
					notify: false,
					reason: `Blocked by override: ${override.pattern}`,
				};
			}
		}
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
