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

export interface ClassifyRequest {
	requestId: string;
	call: CanonicalToolCall;
	context: {
		workerId: string;
		provider: string;
		cwd: string;
		/** Set by the coordinator, never by the worker (a later phase). */
		intent?: string;
		/** Filled in by the chain for classifiers that run after the rules. */
		ruleAssessment?: Assessment;
	};
}

export interface ClassifierResult {
	verdict: Verdict;
	/** Required from external classifiers for allow and deny (a later phase). */
	confidence?: number;
	riskLevel?: RiskLevel;
	reason: string;
	ruleId?: string;
	/** Rules only: false marks a hard limit. */
	autoAllowable?: boolean;
	/** Rules only: the override that decided, for the audit. */
	matchedOverride?: string;
}

export type MaybePromise<T> = T | Promise<T>;

export interface Classifier {
	/** "rules", later "http:<name>". */
	readonly id: string;
	classify(
		req: ClassifyRequest,
		signal: AbortSignal,
	): MaybePromise<ClassifierResult>;
}

export interface Consulted {
	by: string;
	verdict: Verdict;
	reason: string;
	latencyMs: number;
	error?: string;
}

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
	call: CanonicalToolCall;
}

export interface ChainOptions {
	rules: Classifier;
	/** Consulted in order after the rules, only for calls they escalate. */
	classifiers?: Classifier[];
	/** A classifier may not allow a call the rules rate above this. */
	classifierAllowCeiling?: RiskLevel;
	signal?: AbortSignal;
}

/**
 * rules, then any further classifiers, then the coordinator. The rules'
 * `deny`, `allow` and hard limits are final: no later classifier is asked. The
 * result is synchronous unless a further classifier has to be consulted, so
 * rules-only operation keeps a worker's event handling in order.
 */
export class ClassifierChain {
	constructor(private readonly opts: ChainOptions) {}

	decide(req: ClassifyRequest): MaybePromise<GateOutcome> {
		const signal = this.opts.signal ?? new AbortController().signal;
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
		const base = (
			verdict: Verdict,
			decidedBy: string,
			reason: string,
		): GateOutcome => ({
			requestId: req.requestId,
			decision: verdict,
			decidedBy,
			level: rules.riskLevel ?? RiskLevel.HIGH,
			ruleId: rules.ruleId ?? "rules",
			reason,
			// Fail closed: a result that doesn't say is a hard limit.
			autoAllowable: rules.autoAllowable ?? false,
			matchedOverride: rules.matchedOverride,
			consulted,
			call: req.call,
		});

		const further = this.opts.classifiers ?? [];
		const autoAllowable = rules.autoAllowable ?? false;
		if (
			rules.verdict !== "escalate" ||
			!autoAllowable ||
			further.length === 0
		) {
			return base(rules.verdict, this.opts.rules.id, rules.reason);
		}
		const ruleAssessment: Assessment = {
			level: rules.riskLevel ?? RiskLevel.HIGH,
			ruleId: rules.ruleId ?? "rules",
			reason: rules.reason,
			autoAllowable,
		};
		const asked = { ...req, context: { ...req.context, ruleAssessment } };
		return this.consult(asked, further, base, consulted, rules, signal);
	}

	private async consult(
		req: ClassifyRequest,
		further: Classifier[],
		base: (v: Verdict, by: string, reason: string) => GateOutcome,
		consulted: Consulted[],
		rules: ClassifierResult,
		signal: AbortSignal,
	): Promise<GateOutcome> {
		const ceiling = this.opts.classifierAllowCeiling ?? RiskLevel.HIGH;
		const level = rules.riskLevel ?? RiskLevel.HIGH;
		for (const classifier of further) {
			const t0 = Date.now();
			let result: ClassifierResult;
			try {
				result = await classifier.classify(req, signal);
			} catch (e) {
				consulted.push({
					by: classifier.id,
					verdict: "escalate",
					reason: "classifier failed",
					latencyMs: Date.now() - t0,
					error: e instanceof Error ? e.message : String(e),
				});
				continue; // fail closed: ask the next, then the coordinator
			}
			consulted.push({
				by: classifier.id,
				verdict: result.verdict,
				reason: result.reason,
				latencyMs: Date.now() - t0,
			});
			if (result.verdict === "deny") {
				return base("deny", classifier.id, result.reason);
			}
			if (result.verdict === "allow" && level <= ceiling) {
				return base("allow", classifier.id, result.reason);
			}
		}
		return base("escalate", this.opts.rules.id, rules.reason);
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
			consulted: [],
			call: req.call,
		};
	}
}
