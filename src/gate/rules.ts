import * as path from "node:path";

import type { CanonicalToolCall, ResolvedPath } from "./canonical.js";
import type {
	Assessment,
	Classifier,
	ClassifierResult,
	ClassifyRequest,
	MaybePromise,
} from "./classifier.js";
import { matchCommand, matchGlob } from "./glob.js";
import { isInside } from "./paths.js";
import {
	DEFAULT_OVERRIDE_MAX,
	DEFAULT_RISK_POLICY,
	type RiskOverride,
	type RiskPolicy,
} from "./policy.js";
import type { ProtectedPaths } from "./protected-paths.js";
import { RISK_LABELS, RiskLevel, maxLevel } from "./risk.js";
import { assessShell, referencesSecretPath } from "./shell-rules.js";

export interface RuleContext {
	/** The worker's real workspace root. */
	workspace: string;
	home: string;
	protectedPaths: ProtectedPaths;
}

export interface RuleAssessment extends Assessment {
	/** Absolute paths outside the workspace that the call touches. */
	outsidePaths: string[];
}

const assessment = (
	level: RiskLevel,
	ruleId: string,
	reason: string,
	autoAllowable = true,
	outsidePaths: string[] = [],
): RuleAssessment => ({ level, ruleId, reason, autoAllowable, outsidePaths });

/** Workspace files whose change can run code or alter the build: HIGH. */
const CONFIG_FILES = new Set([
	"package.json",
	"tsconfig.json",
	".oxlintrc.json",
	".oxfmtrc.json",
	".gitignore",
	".gitattributes",
	"flake.nix",
	"flake.lock",
	".eslintrc",
	".prettierrc",
	"Makefile",
	"Dockerfile",
	"docker-compose.yml",
	"docker-compose.yaml",
	".npmrc",
	".nvmrc",
	"pnpm-workspace.yaml",
]);
const CONFIG_GLOB = /\.config\.(js|ts|mjs|cjs)$/;

function isConfigFile(workspace: string, abs: string): boolean {
	const rel = path.relative(workspace, abs);
	return (
		CONFIG_FILES.has(path.basename(abs)) ||
		CONFIG_GLOB.test(abs) ||
		rel === ".github/workflows" ||
		rel.startsWith(`.github${path.sep}workflows${path.sep}`)
	);
}

/** Rate a call by what it is and what it touches, whatever the policy says. */
export function assess(
	call: CanonicalToolCall,
	ctx: RuleContext,
): RuleAssessment {
	if (call.malformed) {
		return assessment(
			RiskLevel.HIGH,
			"malformed_call",
			`The tool call could not be understood: ${call.malformed}`,
		);
	}
	switch (call.kind) {
		case "shell": {
			const s = assessShell(call.command ?? "", ctx);
			return {
				level: s.level,
				ruleId: s.ruleId,
				reason: s.reason,
				autoAllowable: !s.hard,
				outsidePaths: s.outsidePaths,
			};
		}
		case "read":
		case "list":
		case "search":
			return assessRead(call);
		case "write":
		case "edit":
			return assessWrite(call, ctx);
		default:
			return call.kind === "other"
				? assessment(RiskLevel.HIGH, "unknown_tool", "Unknown tool")
				: assessment(
						RiskLevel.HIGH,
						`${call.kind}_tool`,
						`${call.kind} tools can reach beyond the workspace`,
					);
	}
}

const outside = (paths: ResolvedPath[]) =>
	paths.filter((p) => !p.inWorkspace).map((p) => p.abs);

function assessRead(call: CanonicalToolCall): RuleAssessment {
	const out = outside(call.paths);
	const hit = call.paths.find((p) => p.protected !== undefined);
	if (hit) {
		return assessment(
			maxLevel(hit.protectedLevel ?? RiskLevel.HIGH, RiskLevel.HIGH),
			`protected.${hit.protected}`,
			"Reads a protected path (credentials or worker-mcp's own state)",
			false,
			out,
		);
	}
	if (call.paths.some((p) => referencesSecretPath(p.abs))) {
		return assessment(
			RiskLevel.HIGH,
			"secret_access",
			"Read of a credential or secret file",
			true,
			out,
		);
	}
	return out.length > 0
		? assessment(
				RiskLevel.MEDIUM,
				"read_outside_workspace",
				"Reads outside the workspace",
				true,
				out,
			)
		: assessment(
				RiskLevel.LOW,
				"read_only_file_op",
				"Read-only file operation",
			);
}

function assessWrite(
	call: CanonicalToolCall,
	ctx: RuleContext,
): RuleAssessment {
	const out = outside(call.paths);
	const hit = call.paths.find((p) => p.protected !== undefined);
	if (hit) {
		return assessment(
			hit.protectedLevel ?? RiskLevel.HIGH,
			`protected.${hit.protected}`,
			"Writes a protected path (it reconfigures the coordinator, runs later or holds secrets)",
			false,
			out,
		);
	}
	if (out.length > 0) {
		return assessment(
			RiskLevel.CRITICAL,
			"write_outside_workspace",
			"Write operation outside the workspace",
			true,
			out,
		);
	}
	if (call.paths.some((p) => isConfigFile(ctx.workspace, p.abs))) {
		return assessment(
			RiskLevel.HIGH,
			"config_file_write",
			"Configuration or build file write",
		);
	}
	return assessment(
		RiskLevel.MEDIUM,
		"workspace_file_write",
		"Write inside the workspace",
	);
}

// ---- policy ------------------------------------------------------------------

function describeOverride(o: RiskOverride): string {
	const m = Object.entries(o.match)
		.map(([k, v]) => `${k}=${v}`)
		.join(" ");
	return `${o.action} ${m}`;
}

function overrideMatches(
	o: RiskOverride,
	call: CanonicalToolCall,
	ctx: RuleContext,
): boolean {
	const m = o.match;
	if (m.kind !== undefined && m.kind !== call.kind) return false;
	if (m.tool !== undefined && !matchGlob(call.rawName, m.tool)) return false;
	if (m.command !== undefined) {
		if (call.command === undefined || !matchCommand(call.command, m.command)) {
			return false;
		}
	}
	if (
		m.path !== undefined &&
		!call.paths.some((p) => pathMatches(p, m.path!, ctx))
	) {
		return false;
	}
	return true;
}

/** The glob is tried on the absolute path and on the workspace-relative one. */
function pathMatches(
	p: ResolvedPath,
	pattern: string,
	ctx: RuleContext,
): boolean {
	if (matchGlob(p.abs, pattern)) return true;
	return (
		p.inWorkspace && matchGlob(path.relative(ctx.workspace, p.abs), pattern)
	);
}

/** An `allow` override may cover this call. */
function allowApplies(
	o: RiskOverride,
	a: RuleAssessment,
	call: CanonicalToolCall,
	ctx: RuleContext,
): boolean {
	if (!a.autoAllowable) return false;
	const max = o.maxRiskLevel ?? DEFAULT_OVERRIDE_MAX;
	if (a.level > max) return false;
	// Paths outside the workspace need a path match that names every one.
	if (a.outsidePaths.length > 0) {
		const pattern = o.match.path;
		if (pattern === undefined) return false;
		const named = call.paths.filter((p) => !p.inWorkspace);
		if (
			a.outsidePaths.some(
				(abs) =>
					!matchGlob(abs, pattern) &&
					!named.some((p) => p.abs === abs && pathMatches(p, pattern, ctx)),
			)
		) {
			return false;
		}
	}
	return true;
}

/** Combine the rating with the worker's policy into a verdict. */
export function applyPolicy(
	a: RuleAssessment,
	call: CanonicalToolCall,
	policy: RiskPolicy,
	ctx: RuleContext,
): ClassifierResult {
	const base = {
		riskLevel: a.level,
		ruleId: a.ruleId,
		autoAllowable: a.autoAllowable,
	};
	const label = RISK_LABELS[a.level];
	for (const o of policy.overrides) {
		if (!overrideMatches(o, call, ctx)) continue;
		const name = describeOverride(o);
		if (o.action === "deny") {
			return {
				...base,
				verdict: "deny",
				reason: `Denied by override: ${name}`,
				matchedOverride: name,
			};
		}
		if (o.action === "escalate") {
			return {
				...base,
				verdict: "escalate",
				reason: `Needs approval by override: ${name}`,
				matchedOverride: name,
			};
		}
		if (allowApplies(o, a, call, ctx)) {
			return {
				...base,
				verdict: "allow",
				reason: `Allowed by override: ${name}`,
				matchedOverride: name,
			};
		}
	}
	if (!a.autoAllowable) {
		return {
			...base,
			verdict: "escalate",
			reason: `${a.reason} (hard limit: only the coordinator can allow it)`,
		};
	}
	if (a.level <= policy.autoApproveUpTo) {
		return {
			...base,
			verdict: "allow",
			reason: `${label} risk, within the auto-approve threshold`,
		};
	}
	return {
		...base,
		verdict: "escalate",
		reason: `${label} risk exceeds the policy threshold: ${a.reason}`,
	};
}

export interface RuleClassifierOptions {
	context: RuleContext;
	/** The worker's current policy, read at each decision. */
	policy: () => RiskPolicy;
}

/** The rule-based classifier: `assess` plus the worker's policy. */
export class RuleClassifier implements Classifier {
	readonly id = "rules";
	constructor(private readonly opts: RuleClassifierOptions) {}

	classify(
		req: ClassifyRequest,
		_signal?: AbortSignal,
	): MaybePromise<ClassifierResult> {
		const a = assess(req.call, this.opts.context);
		return applyPolicy(a, req.call, this.opts.policy(), this.opts.context);
	}
}

export { DEFAULT_RISK_POLICY, isInside };
