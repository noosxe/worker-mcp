import { z } from "zod";

import type { ToolKind } from "./canonical.js";
import { MAX_GLOB_LENGTH } from "./glob.js";
import { RISK_LABELS, RiskLevel, minLevel } from "./risk.js";

/** What the coordinator may set per worker. */
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

// ---- input -------------------------------------------------

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

const policyV2 = z.strictObject({
	autoApproveUpTo: level.optional(),
	overrides: z.array(overrideV2).max(50).optional(),
	classifiers: z.enum(["on", "off"]).optional(),
});

const toLevel = (v: z.infer<typeof level> | undefined): RiskLevel | undefined =>
	v === undefined
		? undefined
		: typeof v === "number"
			? (v as RiskLevel)
			: RiskLevel[v];

export interface NormalizedPolicy {
	policy: RiskPolicy;
	/** Things the validator changed that the caller should know. */
	notes: string[];
}

export class PolicyError extends Error {
	override name = "PolicyError";
}

/** Validate a policy and return it with its levels as numbers. Throws `PolicyError` on anything else. */
export function normalizePolicy(input: unknown): NormalizedPolicy {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new PolicyError("policy must be an object");
	}
	const parsed = policyV2.safeParse(input);
	if (!parsed.success) throw new PolicyError(describe(parsed.error));
	const p = parsed.data;
	return {
		notes: [],
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

function describe(error: z.ZodError): string {
	return `Invalid policy: ${error.issues
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
