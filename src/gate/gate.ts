import { randomBytes } from "node:crypto";
import * as os from "node:os";

import { AuditRing, digest, previewOf, type GateLogEntry } from "./audit.js";
import {
	canonicalize,
	workspaceRoot,
	type CanonicalToolCall,
	type RawToolCall,
	type ToolMap,
} from "./canonical.js";
import {
	ClassifierChain,
	type Classifier,
	type GateOutcome,
	type MaybePromise,
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
	/** Further classifiers, consulted after the rules (a later phase). */
	classifiers?: Classifier[];
	ringSize?: number;
}

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
		});
	}

	get policy(): RiskPolicy {
		return this.current;
	}

	/** Replace the policy, limited to the ceiling. Returns what was lowered. */
	setPolicy(policy: RiskPolicy): { policy: RiskPolicy; clamped: string[] } {
		const result = clampPolicy(policy, this.ceiling);
		this.current = result.policy;
		return result;
	}

	/**
	 * Decide one tool call. Never throws: anything unexpected is an escalation
	 * that nothing can auto-approve. The result is synchronous unless a further
	 * classifier had to be consulted.
	 */
	decide(raw: RawToolCall, actionId?: string): MaybePromise<GateOutcome> {
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
			this.record(outcome, actionId);
			return outcome;
		}
		let decided: MaybePromise<GateOutcome>;
		try {
			decided = this.chain.decide({
				requestId,
				call,
				context: {
					workerId: this.options.workerId ?? "",
					provider: raw.provider,
					cwd: this.workspace,
				},
			});
		} catch (e) {
			decided = this.failed(raw, requestId, e, call);
		}
		if (decided instanceof Promise) {
			return decided
				.catch((e) => this.failed(raw, requestId, e, call))
				.then((o) => {
					this.record(o, actionId);
					return o;
				});
		}
		this.record(decided, actionId);
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
		this.log.push({
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

	private record(o: GateOutcome, actionId?: string): void {
		const entry: GateLogEntry = {
			ts: new Date().toISOString(),
			requestId: o.requestId,
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
		};
		this.log.push(entry);
	}
}
