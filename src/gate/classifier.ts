import { callKey, type DecisionCache } from "./cache.js";
import type { CanonicalToolCall } from "./canonical.js";
import { RiskLevel } from "./risk.js";

export type Verdict = "allow" | "deny" | "escalate";

export interface Assessment {
	level: RiskLevel;
	ruleId: string;
	reason: string;
	/** False for a hard limit: nothing but the coordinator may allow it. */
	autoAllowable: boolean;
}

/** A summary of an earlier decision, for a classifier's context. */
export interface RecentAction {
	kind: string;
	tool: string;
	summary: string;
	verdict: Verdict;
	by: string;
}

export interface ClassifyRequest {
	requestId: string;
	call: CanonicalToolCall;
	context: {
		workerId: string;
		provider: string;
		cwd: string;
		runId?: string;
		model?: string;
		/** Set by the coordinator, never by the worker. */
		intent?: string;
		/** The latest decisions of this worker, summaries only. */
		recentActions?: RecentAction[];
		/** Filled in by the chain for classifiers that run after the rules. */
		ruleAssessment?: Assessment;
	};
}

export interface ClassifierResult {
	verdict: Verdict;
	/** Required from external classifiers for allow and deny. */
	confidence?: number;
	riskLevel?: RiskLevel;
	reason: string;
	ruleId?: string;
	/** How long a decisive verdict may be reused, for external classifiers. */
	cacheTtlMs?: number;
	/** Rules only: false marks a hard limit. */
	autoAllowable?: boolean;
	/** Rules only: the override that decided, for the audit. */
	matchedOverride?: string;
}

export type MaybePromise<T> = T | Promise<T>;

export interface Thresholds {
	/** An `allow` below this confidence becomes an escalation. */
	minAllowConfidence: number;
	/** A `deny` below this confidence becomes an escalation. */
	minDenyConfidence: number;
}

export interface Classifier {
	/** "rules", "http:<name>". */
	readonly id: string;
	/** Set for classifiers that report a confidence; the chain applies them. */
	readonly thresholds?: Thresholds;
	classify(
		req: ClassifyRequest,
		signal: AbortSignal,
	): MaybePromise<ClassifierResult>;
}

/** A classifier that could not answer (down, slow, invalid, breaker open). */
export class ClassifierFailure extends Error {
	override name = "ClassifierFailure";
}

export interface Consulted {
	by: string;
	verdict: Verdict;
	confidence?: number;
	reason: string;
	latencyMs: number;
	/** The verdict came from the decision cache, not from a request. */
	cached?: boolean;
	error?: string;
}

/** Why a call went to the coordinator. */
export type EscalatedBecause =
	| "rules"
	| "hard_limit"
	| "manual_mode"
	| "low_confidence"
	| "classifier_error"
	| "ceiling"
	| "repeat_cut_off";

export interface GateOutcome {
	requestId: string;
	decision: Verdict;
	decidedBy: string;
	level: RiskLevel;
	ruleId: string;
	reason: string;
	autoAllowable: boolean;
	matchedOverride?: string;
	consulted: Consulted[];
	/** Set on an escalation. */
	escalatedBecause?: EscalatedBecause;
	call: CanonicalToolCall;
}

export interface ChainOptions {
	rules: Classifier;
	/** Consulted in order after the rules, only for calls they escalate. */
	classifiers?: Classifier[];
	/** Whether those are consulted now (the server mode and the worker's opt-out). */
	enabled?: () => boolean;
	/** A classifier may not allow a call the rules rate above this. */
	classifierAllowCeiling?: RiskLevel;
	/** What a classifier that cannot answer means: ask the coordinator or deny. */
	onFailure?: "escalate" | "deny";
	cache?: DecisionCache;
	/** Separates cached verdicts of different classifier configurations. */
	configVersion?: string;
	/** Allows the coordinator has remembered for this worker, by call key. */
	remembered?: Set<string>;
	signal?: AbortSignal;
}

/** The key under which an approved call is remembered. */
export const rememberKey = (workerId: string, call: CanonicalToolCall) =>
	callKey("remember", "", workerId, call);

/** A call a remembered allow may cover: not a hard limit, not CRITICAL. */
export function rememberable(o: GateOutcome): boolean {
	return (
		o.autoAllowable &&
		o.level < RiskLevel.CRITICAL &&
		!o.call.paths.some((p) => p.protected !== undefined)
	);
}

/**
 * rules, then a remembered allow, then any further classifiers, then the
 * coordinator. The rules' `deny`, `allow` and hard limits are final: no later
 * classifier is asked. The result is synchronous unless a further classifier
 * has to be consulted, so rules-only operation keeps a worker's event handling
 * in order. Nothing a classifier does can allow a hard limit or CRITICAL.
 */
export class ClassifierChain {
	constructor(private readonly opts: ChainOptions) {}

	decide(req: ClassifyRequest, abort?: AbortSignal): MaybePromise<GateOutcome> {
		const signal = abort ?? this.opts.signal ?? new AbortController().signal;
		const started = Date.now();
		let rules: MaybePromise<ClassifierResult>;
		try {
			rules = this.opts.rules.classify(req, signal);
		} catch (e) {
			return this.failClosed(req, e);
		}
		if (rules instanceof Promise) {
			return rules.then(
				(r) => this.afterRules(req, r, started, signal),
				(e) => this.failClosed(req, e),
			);
		}
		return this.afterRules(req, rules, started, signal);
	}

	private afterRules(
		req: ClassifyRequest,
		rules: ClassifierResult,
		started: number,
		signal: AbortSignal,
	): MaybePromise<GateOutcome> {
		const consulted: Consulted[] = [
			{
				by: this.opts.rules.id,
				verdict: rules.verdict,
				reason: rules.reason,
				latencyMs: Date.now() - started,
			},
		];
		const level = rules.riskLevel ?? RiskLevel.HIGH;
		const base = (
			verdict: Verdict,
			decidedBy: string,
			reason: string,
			escalatedBecause?: EscalatedBecause,
		): GateOutcome => ({
			requestId: req.requestId,
			decision: verdict,
			decidedBy,
			level,
			ruleId: rules.ruleId ?? "rules",
			reason,
			// Fail closed: a result that doesn't say is a hard limit.
			autoAllowable: rules.autoAllowable ?? false,
			matchedOverride: rules.matchedOverride,
			consulted,
			escalatedBecause,
			call: req.call,
		});

		if (rules.verdict !== "escalate") {
			return base(rules.verdict, this.opts.rules.id, rules.reason);
		}
		const autoAllowable = rules.autoAllowable ?? false;
		const escalate = (because: EscalatedBecause) =>
			base("escalate", this.opts.rules.id, rules.reason, because);
		if (!autoAllowable || level >= RiskLevel.CRITICAL) {
			return escalate("hard_limit");
		}

		const outcome = base("escalate", this.opts.rules.id, rules.reason);
		if (
			this.opts.remembered?.has(rememberKey(req.context.workerId, req.call)) &&
			rememberable(outcome)
		) {
			consulted.push({
				by: "cache",
				verdict: "allow",
				reason: "the coordinator approved this exact call before",
				latencyMs: 0,
				cached: true,
			});
			return base("allow", "cache", "approved earlier by the coordinator");
		}

		const further = this.opts.classifiers ?? [];
		if (further.length === 0 || this.opts.enabled?.() === false) {
			return escalate("manual_mode");
		}
		const ruleAssessment: Assessment = {
			level,
			ruleId: rules.ruleId ?? "rules",
			reason: rules.reason,
			autoAllowable,
		};
		const asked = { ...req, context: { ...req.context, ruleAssessment } };
		return this.consult(
			asked,
			further,
			base,
			consulted,
			level,
			rules.reason,
			signal,
		);
	}

	private async consult(
		req: ClassifyRequest,
		further: Classifier[],
		base: (
			v: Verdict,
			by: string,
			reason: string,
			because?: EscalatedBecause,
		) => GateOutcome,
		consulted: Consulted[],
		level: RiskLevel,
		rulesReason: string,
		signal: AbortSignal,
	): Promise<GateOutcome> {
		const ceiling = Math.min(
			this.opts.classifierAllowCeiling ?? RiskLevel.HIGH,
			RiskLevel.HIGH,
		);
		const cache = this.opts.cache;
		let because: EscalatedBecause = "low_confidence";
		let failed: { by: string; error: string } | null = null;
		for (const classifier of further) {
			const key = cache
				? callKey(
						classifier.id,
						this.opts.configVersion ?? "",
						req.context.workerId,
						req.call,
					)
				: "";
			const t0 = Date.now();
			let result: ClassifierResult;
			let cached = false;
			const hit = cache?.get(key);
			if (hit) {
				cached = true;
				result = hit;
			} else {
				try {
					result = await classifier.classify(req, signal);
				} catch (e) {
					const error = e instanceof Error ? e.message : String(e);
					consulted.push({
						by: classifier.id,
						verdict: "escalate",
						reason: "the classifier did not answer",
						latencyMs: Date.now() - t0,
						error,
					});
					failed = { by: classifier.id, error };
					continue; // fail closed: ask the next, then decide below
				}
			}
			const effective = this.applyThresholds(classifier, result);
			const entry: Consulted = {
				by: classifier.id,
				verdict: effective.verdict,
				confidence: result.confidence,
				reason: effective.reason,
				latencyMs: cached ? 0 : Date.now() - t0,
			};
			if (cached) entry.cached = true;
			consulted.push(entry);

			if (effective.verdict === "deny") {
				if (!cached && cache && result.cacheTtlMs !== undefined) {
					cache.set(
						key,
						req.context.workerId,
						{
							verdict: "deny",
							confidence: result.confidence,
							reason: result.reason,
						},
						result.cacheTtlMs,
					);
				}
				return base("deny", classifier.id, effective.reason);
			}
			if (effective.verdict === "allow") {
				if (level > ceiling) {
					because = "ceiling";
					continue;
				}
				if (!cached && cache && result.cacheTtlMs !== undefined) {
					cache.set(
						key,
						req.context.workerId,
						{
							verdict: "allow",
							confidence: result.confidence,
							reason: result.reason,
						},
						result.cacheTtlMs,
					);
				}
				return base("allow", classifier.id, effective.reason);
			}
		}
		if (failed) {
			if (this.opts.onFailure === "deny") {
				return base(
					"deny",
					failed.by,
					`the classifier did not answer (${failed.error}); the server is set to deny in that case`,
				);
			}
			because = "classifier_error";
		}
		return base("escalate", this.opts.rules.id, rulesReason, because);
	}

	/** An allow or deny without enough confidence is an escalation. */
	private applyThresholds(
		classifier: Classifier,
		r: ClassifierResult,
	): ClassifierResult {
		const t = classifier.thresholds;
		if (!t || r.verdict === "escalate") return r;
		const confidence = r.confidence;
		const needed =
			r.verdict === "allow" ? t.minAllowConfidence : t.minDenyConfidence;
		if (confidence === undefined || !(confidence >= needed)) {
			return {
				...r,
				verdict: "escalate",
				reason: `${r.reason} (${r.verdict} with confidence ${confidence ?? "none"}, below ${needed})`,
			};
		}
		return r;
	}

	private failClosed(req: ClassifyRequest, e: unknown): GateOutcome {
		return {
			requestId: req.requestId,
			decision: "escalate",
			decidedBy: this.opts.rules.id,
			level: RiskLevel.HIGH,
			ruleId: "gate.error",
			reason: `The classifier failed: ${e instanceof Error ? e.message : String(e)}`,
			autoAllowable: false,
			escalatedBecause: "hard_limit",
			consulted: [],
			call: req.call,
		};
	}
}
