import { z } from "zod";

import type { ToolKind } from "./canonical.js";
import { MAX_GLOB_LENGTH } from "./glob.js";
import { RISK_LABELS, RiskLevel, maxLevel, minLevel } from "./risk.js";

/** Policy v2: what the coordinator may set per worker. */
export interface RiskPolicy {
	/** Calls at or below this level are auto-allowed. Default LOW. */
	autoApproveUpTo: RiskLevel;
	overrides: RiskOverride[];
	/** Per-worker opt-out of the (later) external classifiers. */
	classifiers?: "on" | "off";
}

export interface RiskOverride {
	/** Globs; every field given must match. */
	match: { kind?: ToolKind; tool?: string; command?: string; path?: string };
	action: "allow" | "escalate" | "deny";
	/** `allow` only applies up to this level (default MEDIUM). */
	maxRiskLevel?: RiskLevel;
}

export const DEFAULT_RISK_POLICY: RiskPolicy = {
	autoApproveUpTo: RiskLevel.LOW,
	overrides: [],
};

/** What `allow` overrides may cover when they give no `maxRiskLevel`. */
export const DEFAULT_OVERRIDE_MAX = RiskLevel.MEDIUM;

// ---- input: v1 and v2 shapes -------------------------------------------------

const level = z.union([
	z.number().int().min(0).max(3),
	z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
]);
const glob = z.string().min(1).max(MAX_GLOB_LENGTH);
const KINDS = [
	"shell",
	"read",
	"list",
	"search",
	"write",
	"edit",
	"fetch",
	"mcp",
	"agent",
	"task",
	"other",
] as const;

const overrideV2 = z.strictObject({
	match: z
		.strictObject({
			kind: z.enum(KINDS).optional(),
			tool: glob.optional(),
			command: glob.optional(),
			path: glob.optional(),
		})
		.refine((m) => Object.values(m).some((v) => v !== undefined), {
			message: "match needs at least one of kind, tool, command, path",
		}),
	action: z.enum(["allow", "escalate", "deny"]),
	maxRiskLevel: level.optional(),
});

const overrideV1 = z.strictObject({
	pattern: glob,
	pathPattern: glob.optional(),
	action: z.enum(["allow", "block"]),
	maxRiskLevel: level.optional(),
});

const policyV2 = z.strictObject({
	autoApproveUpTo: level.optional(),
	overrides: z.array(overrideV2).max(200).optional(),
	classifiers: z.enum(["on", "off"]).optional(),
});

const policyV1 = z.strictObject({
	autoApproveUpTo: level.optional(),
	notifyUpTo: level.optional(),
	overrides: z.array(overrideV1).max(200).optional(),
});

/** Tool names from earlier versions, and the pi tool that replaces each. */
const LEGACY_TOOL_NAMES: Record<string, string> = {
	read_file: "read",
	view_file: "read",
	write_file: "write",
	create_file: "write",
	write_to_file: "write",
	edit_file: "edit",
	replace_file_content: "edit",
	multi_replace_file_content: "edit",
	list_dir: "ls",
	grep_file: "grep",
	search: "grep",
	run_command: "bash",
	shell: "bash",
	terminal: "bash",
};

const toLevel = (v: z.infer<typeof level> | undefined): RiskLevel | undefined =>
	v === undefined
		? undefined
		: typeof v === "number"
			? (v as RiskLevel)
			: RiskLevel[v];

export interface NormalizedPolicy {
	policy: RiskPolicy;
	/** The input used the v1 shape and was converted. */
	converted: boolean;
	/** Things the converter or validator changed that the caller should know. */
	notes: string[];
}

export class PolicyError extends Error {
	override name = "PolicyError";
}

/**
 * Validate a policy given as v2 or as the v1 shape (`autoApproveUpTo`,
 * `notifyUpTo`, `overrides[].pattern/pathPattern/action: allow|block`) and
 * return it as v2. Throws `PolicyError` on anything else.
 */
export function normalizePolicy(input: unknown): NormalizedPolicy {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new PolicyError("riskPolicy must be an object");
	}
	const notes: string[] = [];
	const raw = input as Record<string, unknown>;
	const overrides = raw.overrides;
	const isV1 =
		"notifyUpTo" in raw ||
		(Array.isArray(overrides) &&
			overrides.some(
				(o) => typeof o === "object" && o !== null && "pattern" in o,
			));

	if (!isV1) {
		const parsed = policyV2.safeParse(raw);
		if (!parsed.success) throw new PolicyError(describe(parsed.error));
		const p = parsed.data;
		return {
			converted: false,
			notes,
			policy: {
				autoApproveUpTo: toLevel(p.autoApproveUpTo) ?? RiskLevel.LOW,
				classifiers: p.classifiers,
				overrides: (p.overrides ?? []).map((o) => ({
					match: o.match,
					action: o.action,
					maxRiskLevel: toLevel(o.maxRiskLevel),
				})),
			},
		};
	}

	const parsed = policyV1.safeParse(raw);
	if (!parsed.success) throw new PolicyError(describe(parsed.error));
	const p = parsed.data;
	const out: RiskOverride[] = [];
	for (const o of p.overrides ?? []) {
		const action = o.action === "block" ? "escalate" : "allow";
		const maxRiskLevel = toLevel(o.maxRiskLevel);
		// v1 matched the pattern against the command string OR the tool name,
		// so it becomes two v2 overrides that share the rest.
		const tool = LEGACY_TOOL_NAMES[o.pattern] ?? o.pattern;
		const path = o.pathPattern;
		out.push({
			match: { tool, ...(path ? { path } : {}) },
			action,
			maxRiskLevel,
		});
		out.push({
			match: { command: o.pattern, ...(path ? { path } : {}) },
			action,
			maxRiskLevel,
		});
	}
	// v1 auto-approved up to notifyUpTo too, only reporting those calls. Now
	// every auto-approved call is reported, so the two thresholds merge.
	const quiet = toLevel(p.autoApproveUpTo) ?? RiskLevel.LOW;
	const notify = toLevel(p.notifyUpTo) ?? RiskLevel.LOW;
	if (p.notifyUpTo !== undefined) {
		notes.push(
			"notifyUpTo is merged into autoApproveUpTo: every auto-approved call is reported in the next result",
		);
	}
	notes.push("riskPolicy used the v1 shape and was converted");
	return {
		converted: true,
		notes,
		policy: {
			autoApproveUpTo: maxLevel(quiet, notify),
			overrides: out,
		},
	};
}

function describe(error: z.ZodError): string {
	return `Invalid riskPolicy: ${error.issues
		.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
		.join("; ")}`;
}

// ---- the ceiling -------------------------------------------------------------

export interface ClampedPolicy {
	policy: RiskPolicy;
	/** One line per value that was lowered; empty when nothing changed. */
	clamped: string[];
}

const label = (l: RiskLevel) => RISK_LABELS[l];

/**
 * Limit a coordinator-supplied policy to the server's `maxAutoApprove`. Both
 * the auto-approve threshold and every `allow` override are lowered to the
 * ceiling; an `allow` with no `maxRiskLevel` is limited to its default.
 */
export function clampPolicy(
	policy: RiskPolicy,
	ceiling: RiskLevel,
): ClampedPolicy {
	const clamped: string[] = [];
	const autoApproveUpTo = minLevel(policy.autoApproveUpTo, ceiling);
	if (autoApproveUpTo !== policy.autoApproveUpTo) {
		clamped.push(
			`autoApproveUpTo ${label(policy.autoApproveUpTo)} lowered to ${label(autoApproveUpTo)}`,
		);
	}
	const overrides = policy.overrides.map((o, i): RiskOverride => {
		if (o.action !== "allow") return o;
		const wanted = o.maxRiskLevel ?? DEFAULT_OVERRIDE_MAX;
		const max = minLevel(wanted, ceiling);
		if (max !== wanted) {
			clamped.push(
				`overrides[${i}] allow limited to ${label(max)} instead of ${label(wanted)}`,
			);
		}
		return { ...o, maxRiskLevel: max };
	});
	return { policy: { ...policy, autoApproveUpTo, overrides }, clamped };
}
