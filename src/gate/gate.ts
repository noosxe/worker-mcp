import { randomBytes } from "node:crypto";
import * as os from "node:os";

import {
	AuditRing,
	digest,
	previewOf,
	type AuditFile,
	type GateLogEntry,
} from "./audit.js";
import type { DecisionCache } from "./cache.js";
import {
	canonicalize,
	workspaceRoot,
	type CanonicalToolCall,
	type RawToolCall,
	type ToolMap,
} from "./canonical.js";
import {
	ClassifierChain,
	rememberKey,
	rememberable,
	type Classifier,
	type GateOutcome,
	type MaybePromise,
	type RecentAction,
	type Verdict,
} from "./classifier.js";
import { clampPolicy, DEFAULT_RISK_POLICY, type RiskPolicy } from "./policy.js";
import {
	ProtectedPaths,
	type ProtectedPathsOptions,
} from "./protected-paths.js";
import { RiskLevel, minLevel } from "./risk.js";
import { RuleClassifier } from "./rules.js";

export interface GateOptions {
	/** The worker's working directory. */
	cwd: string;
	workerId?: string;
	/** Server ceiling on what a policy may auto-approve (F13). Default MEDIUM. */
	maxAutoApprove?: RiskLevel;
	policy?: RiskPolicy;
	home?: string;
	/** Locations of this server's own state, protected from workers. */
	protected?: Omit<ProtectedPathsOptions, "workspace" | "home">;
	toolMap?: ToolMap;
	/**
	 * Further classifiers, consulted after the rules for calls they escalate.
	 * Without `mode` they are consulted whenever there are any.
	 */
	classifiers?: Classifier[];
	/** `auto` consults the classifiers; `manual` sends escalations straight on. */
	mode?: "manual" | "auto";
	/** Highest level a classifier may allow (never above HIGH). Default HIGH. */
	classifierAllowCeiling?: RiskLevel;
	onClassifierFailure?: "escalate" | "deny";
	/** Shared by every worker; entries are scoped per worker by their key. */
	cache?: DecisionCache;
	/** Changes when the classifier configuration does, so old verdicts lapse. */
	configVersion?: string;
	/** How many recent decisions a classifier is told about. Default 10. */
	recentActions?: number;
	model?: string;
	/** Files of secrets (such as a token file): protected like credentials. */
	secretFiles?: string[];
	/** The audit file; every decision and resolution is appended to it. */
	audit?: AuditFile | null;
	ringSize?: number;
}

/** What the gate learns about a call from the session, not from the provider. */
export interface DecideContext {
	runId?: string;
	/** The coordinator's one-line summary of the task. */
	intent?: string;
	/** Aborts a classifier request still in flight when the run ends. */
	signal?: AbortSignal;
}

const MAX_REMEMBERED = 1000;

export const DEFAULT_MAX_AUTO_APPROVE = RiskLevel.MEDIUM;

/**
 * The approval gate for one worker: it maps a tool call to its canonical
 * form, runs the classifier chain against the worker's policy, and records
 * every decision. Hard limits (protected paths) are enforced by the rules and
 * cannot be lifted by a policy, an override or a later classifier. The server
 * ceiling is applied here too, so no caller can set a policy above it.
 */
export class Gate {
	readonly log: AuditRing;
	private current: RiskPolicy;
	private readonly ceiling: RiskLevel;
	private readonly chain: ClassifierChain;
	private readonly options: GateOptions;
	private readonly protectedPaths: ProtectedPaths;
	private readonly home: string;
	private readonly workspace: string;
	/** Allows the coordinator asked to keep for this worker, by call key. */
	private readonly remembered = new Set<string>();

	constructor(options: GateOptions) {
		this.options = options;
		// The ceiling never reaches CRITICAL, whatever was passed.
		this.ceiling = minLevel(
			options.maxAutoApprove ?? DEFAULT_MAX_AUTO_APPROVE,
			RiskLevel.HIGH,
		);
		this.home = options.home ?? os.homedir();
		this.workspace = workspaceRoot(options.cwd);
		this.protectedPaths = new ProtectedPaths({
			...options.protected,
			workspace: this.workspace,
			home: this.home,
			secretFiles: options.secretFiles,
		});
		this.current = clampPolicy(
			options.policy ?? DEFAULT_RISK_POLICY,
			this.ceiling,
		).policy;
		this.log = new AuditRing(options.ringSize ?? 500);
		this.chain = new ClassifierChain({
			rules: new RuleClassifier({
				context: {
					workspace: this.workspace,
					home: this.home,
					protectedPaths: this.protectedPaths,
				},
				policy: () => this.current,
			}),
			classifiers: options.classifiers,
			enabled: () =>
				(options.mode ?? (options.classifiers?.length ? "auto" : "manual")) ===
					"auto" && this.current.classifiers !== "off",
			classifierAllowCeiling: options.classifierAllowCeiling,
			onFailure: options.onClassifierFailure,
			cache: options.cache,
			configVersion: options.configVersion,
			remembered: this.remembered,
		});
	}

	get policy(): RiskPolicy {
		return this.current;
	}

	/** Replace the policy, limited to the ceiling. Returns what was lowered. */
	setPolicy(policy: RiskPolicy): { policy: RiskPolicy; clamped: string[] } {
		const result = clampPolicy(policy, this.ceiling);
		this.current = result.policy;
		// Verdicts given under the old policy do not carry over.
		this.forget();
		return result;
	}

	/**
	 * Keep an allow for this exact call (same tool, command, paths and
	 * arguments) until the worker closes or its policy changes. Refused, with
	 * false, for a hard limit, a protected path or CRITICAL: those always ask.
	 */
	remember(outcome: GateOutcome): boolean {
		if (!rememberable(outcome)) return false;
		if (this.remembered.size >= MAX_REMEMBERED) {
			const oldest = this.remembered.values().next().value;
			if (oldest !== undefined) this.remembered.delete(oldest);
		}
		this.remembered.add(rememberKey(this.options.workerId ?? "", outcome.call));
		return true;
	}

	/** Drop every remembered allow and cached classifier verdict of this worker. */
	forget(): void {
		this.remembered.clear();
		this.options.cache?.clearWorker(this.options.workerId ?? "");
	}

	private recent(): RecentAction[] {
		const n = this.options.recentActions ?? 10;
		if (n <= 0) return [];
		// An escalation is logged twice (asked, then answered): the last counts.
		const byRequest = new Map<string, GateLogEntry>();
		for (const e of this.log.entries()) {
			byRequest.delete(e.requestId);
			byRequest.set(e.requestId, e);
		}
		return [...byRequest.values()].slice(-n).map((e) => ({
			kind: e.kind,
			tool: e.tool,
			summary: e.preview.slice(0, 120),
			verdict: e.decision,
			by: e.decidedBy,
		}));
	}

	/**
	 * Decide one tool call. Never throws: anything unexpected is an escalation
	 * that nothing can auto-approve. The result is synchronous unless a further
	 * classifier had to be consulted.
	 */
	decide(
		raw: RawToolCall,
		actionId?: string,
		ctx: DecideContext = {},
	): MaybePromise<GateOutcome> {
		const requestId = `g_${randomBytes(6).toString("hex")}`;
		let call: CanonicalToolCall;
		try {
			call = canonicalize(raw, {
				cwd: this.options.cwd,
				protectedPaths: this.protectedPaths,
				toolMap: this.options.toolMap,
				home: this.home,
			});
		} catch (e) {
			const outcome = this.failed(raw, requestId, e);
			this.record(outcome, actionId, ctx);
			return outcome;
		}
		let decided: MaybePromise<GateOutcome>;
		try {
			decided = this.chain.decide(
				{
					requestId,
					call,
					context: {
						workerId: this.options.workerId ?? "",
						provider: raw.provider,
						cwd: this.workspace,
						runId: ctx.runId,
						model: this.options.model,
						intent: ctx.intent,
						recentActions: this.recent(),
					},
				},
				ctx.signal,
			);
		} catch (e) {
			decided = this.failed(raw, requestId, e, call);
		}
		if (decided instanceof Promise) {
			return decided
				.catch((e) => this.failed(raw, requestId, e, call))
				.then((o) => {
					this.record(o, actionId, ctx);
					return o;
				});
		}
		this.record(decided, actionId, ctx);
		return decided;
	}

	/** Record what happened after an escalation: the coordinator's answer. */
	recordResolution(
		actionId: string,
		decision: Verdict,
		decidedBy: "coordinator" | "timeout" | "cancel",
		reason: string,
	): void {
		const original = this.log.findByAction(actionId);
		if (!original) return;
		this.push({
			...original,
			ts: new Date().toISOString(),
			consulted: [],
			decision,
			decidedBy,
			reason,
		});
	}

	private failed(
		raw: RawToolCall,
		requestId: string,
		e: unknown,
		call?: CanonicalToolCall,
	): GateOutcome {
		return {
			requestId,
			decision: "escalate",
			decidedBy: "rules",
			level: RiskLevel.HIGH,
			ruleId: "gate.error",
			escalatedBecause: "hard_limit",
			reason: `The gate failed on this call: ${e instanceof Error ? e.message : String(e)}`,
			autoAllowable: false,
			consulted: [],
			call: call ?? {
				provider: raw.provider,
				rawName: raw.toolName,
				kind: "other",
				paths: [],
				input: raw.input,
				origin: { depth: raw.depth ?? 0 },
			},
		};
	}

	private push(entry: GateLogEntry): void {
		this.log.push(entry);
		this.options.audit?.write(entry);
	}

	private record(
		o: GateOutcome,
		actionId: string | undefined,
		ctx: DecideContext,
	): void {
		const entry: GateLogEntry = {
			ts: new Date().toISOString(),
			requestId: o.requestId,
			workerId: this.options.workerId,
			runId: ctx.runId,
			actionId,
			provider: o.call.provider,
			tool: o.call.rawName,
			kind: o.call.kind,
			depth: o.call.origin.depth,
			argsDigest: digest(o.call.input),
			preview: previewOf(o.call.command, o.call.paths[0]?.abs),
			rule: {
				level: o.level,
				ruleId: o.ruleId,
				autoAllowable: o.autoAllowable,
			},
			consulted: o.consulted,
			decision: o.decision,
			decidedBy: o.decidedBy,
			reason: o.reason,
			matchedOverride: o.matchedOverride,
			escalatedBecause: o.escalatedBecause,
		};
		this.push(entry);
	}
}
