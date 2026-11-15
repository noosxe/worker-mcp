import type { PendingApprovalInfo, RunView } from "./core/run.js";
import type { ApprovalData, ConsultedData, RunData } from "./outputs.js";

/**
 * Everything a worker wrote that the coordinator reads is untrusted: it came
 * from a model that may have been steered by a file or a web page. It is
 * wrapped in a labelled element so it cannot pass for the server's own words,
 * and the closing tag cannot occur inside it.
 */

/** Any `<worker_output` or `</worker_output` (any case, any spacing) is defused. */
const TAG = /<(\s*\/?\s*)worker_output/gi;

export function escapeUntrusted(text: string): string {
	return text.replace(TAG, "&lt;$1worker_output");
}

/** `text` as untrusted output of run `runId` (or of worker `id`, with `attr`). */
export function wrapUntrusted(
	runId: string,
	text: string,
	attr: "run" | "worker" = "run",
): string {
	return `<worker_output ${attr}="${runId}" trust="untrusted">${escapeUntrusted(text)}</worker_output>`;
}

/**
 * Fields written by a worker sit under keys named `untrusted…`. In
 * `structuredContent` they stay raw; in the text block `wrapTree` wraps every
 * string below such a key, so the label survives either channel. The run a
 * wrapper names is the nearest enclosing object's `runId`, else `fallback`.
 */
export function wrapTree<T>(
	data: T,
	fallback: string,
	attr: "run" | "worker" = "run",
): T {
	const walk = (value: unknown, id: string, untrusted: boolean): unknown => {
		if (typeof value === "string") {
			return untrusted ? wrapUntrusted(id, value, attr) : value;
		}
		if (Array.isArray(value)) return value.map((v) => walk(v, id, untrusted));
		if (value && typeof value === "object") {
			const obj = value as Record<string, unknown>;
			const here = typeof obj.runId === "string" ? obj.runId : id;
			return Object.fromEntries(
				Object.entries(obj).map(([k, v]) => [
					k,
					walk(v, here, untrusted || k.startsWith("untrusted")),
				]),
			);
		}
		return value;
	};
	return walk(data, fallback, false) as T;
}

/** A classifier's answer: its reason may echo the call, so it is untrusted. */
export function consultedData(c: {
	by: string;
	verdict: string;
	confidence?: number;
	reason: string;
	cached?: boolean;
	error?: string;
}): ConsultedData {
	return {
		by: c.by,
		verdict: c.verdict,
		confidence: c.confidence,
		untrustedReason: c.reason,
		cached: c.cached,
		error: c.error,
	};
}

export function approvalData(
	runId: string,
	a: PendingApprovalInfo,
	now = Date.now(),
): ApprovalData {
	return {
		approvalId: a.actionId,
		runId,
		tool: escapeUntrusted(a.tool),
		kind: a.kind,
		untrustedCommand: a.command,
		untrustedPaths: a.paths.map((p) => ({
			path: p.path,
			inWorkspace: p.inWorkspace,
			protected: p.protected,
		})),
		riskLabel: a.riskLabel,
		reason: a.reason,
		hardLimit: a.hardLimit,
		escalatedBecause: a.escalatedBecause,
		consulted: a.consulted?.map(consultedData),
		expiresInMs: Math.max(0, a.expiresAt - now),
	};
}

export function runData(view: RunView): RunData {
	return {
		runId: view.runId,
		workerId: view.workerId,
		state: view.state,
		seq: view.seq,
		elapsedMs: view.elapsedMs,
		pendingApprovals: view.pendingApprovals.map((a) =>
			approvalData(view.runId, a),
		),
		untrustedActivity: view.activity,
		untrustedFinalText: view.output.text,
		output: {
			offset: view.output.offset,
			nextOffset: view.output.nextOffset,
			totalChars: view.output.totalChars,
			truncated: view.output.truncated,
			more: view.output.more,
		},
		error: view.error,
		usage: view.usage,
		gate: {
			autoAllowed: view.gate.autoAllowed,
			autoDenied: view.gate.autoDenied,
			escalated: view.gate.escalated,
			untrustedNotable: view.gate.notable,
		},
		next: view.next,
	};
}
