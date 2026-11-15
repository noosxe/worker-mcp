import type { PendingApprovalInfo, RunView } from "./core/run.js";

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

/** `text` as untrusted output of run `runId`. */
export function wrapUntrusted(runId: string, text: string): string {
	return `<worker_output run="${runId}" trust="untrusted">${escapeUntrusted(text)}</worker_output>`;
}

/** The call an approval is about, as fields rather than a sentence. */
export interface ApprovalView {
	approvalId: string;
	/** Deprecated: the same as `approvalId`. */
	actionId: string;
	runId: string;
	tool: string;
	kind: string;
	/** The shell command, untrusted. */
	command?: string;
	/** Paths the call touches, untrusted. */
	paths: { path: string; inWorkspace: boolean; protected: boolean }[];
	riskLabel?: string;
	/** Why the gate sent it to the coordinator. */
	reason?: string;
	hardLimit?: boolean;
	expiresInMs: number;
}

export function approvalView(
	runId: string,
	a: PendingApprovalInfo,
	now = Date.now(),
): ApprovalView {
	return {
		approvalId: a.actionId,
		actionId: a.actionId,
		runId,
		tool: escapeUntrusted(a.tool),
		kind: a.kind,
		command:
			a.command === undefined ? undefined : wrapUntrusted(runId, a.command),
		paths: a.paths.map((p) => ({
			path: wrapUntrusted(runId, p.path),
			inWorkspace: p.inWorkspace,
			protected: p.protected,
		})),
		riskLabel: a.riskLabel,
		reason: a.reason,
		hardLimit: a.hardLimit,
		expiresInMs: Math.max(0, a.expiresAt - now),
	};
}

/** A run view with every worker-written field wrapped. */
export type RenderedRunView = Omit<
	RunView,
	"output" | "activity" | "pendingApprovals"
> & {
	pendingApprovals: ApprovalView[];
	/** Each line is wrapped separately. */
	activity: string[];
	output: Omit<RunView["output"], "text"> & { text: string };
};

export function renderRunView(view: RunView): RenderedRunView {
	return {
		...view,
		pendingApprovals: view.pendingApprovals.map((a) =>
			approvalView(view.runId, a),
		),
		activity: view.activity.map((l) => wrapUntrusted(view.runId, l)),
		gate: {
			...view.gate,
			notable: view.gate.notable.map((l) => wrapUntrusted(view.runId, l)),
		},
		output: {
			...view.output,
			text: wrapUntrusted(view.runId, view.output.text),
		},
	};
}
