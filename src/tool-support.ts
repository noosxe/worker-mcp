import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
	CallToolResult,
	ServerNotification,
	ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import { type Run, runView } from "./core/run.js";
import { ToolError } from "./errors.js";
import { PolicyError } from "./gate/policy.js";
import { RiskLevel } from "./gate/risk.js";
import type { PolicyData, RunData, WorkerData } from "./outputs.js";
import { runData, wrapTree, wrapUntrusted } from "./render.js";
import { MAX_PAGE_CHARS } from "./schemas.js";
import type { SessionManager } from "./session/session-manager.js";
import {
	type PolicyReport,
	RunError,
	type Session,
} from "./session/session.js";

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Where a failed argument is, and why: `prompt: too big`. */
function describeIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			if (issue.code === "unrecognized_keys") {
				return `unknown argument ${issue.keys.join(", ")}`;
			}
			const where = issue.path.join(".");
			return `${where || "arguments"}: ${issue.message}`;
		})
		.join("; ");
}

/**
 * Make `server` report invalid arguments as `INVALID_ARGUMENT`, in the same
 * shape as every other error, instead of the SDK's own wording. The SDK has
 * no public hook for this; a test pins the behaviour so a changed SDK shows
 * up at once.
 */
export function useStableValidationErrors(server: McpServer): void {
	const patched = server as unknown as {
		validateToolInput: (
			tool: { inputSchema?: z.ZodType },
			args: unknown,
			toolName: string,
		) => Promise<unknown>;
	};
	patched.validateToolInput = async (tool, args, toolName) => {
		if (!tool.inputSchema) return undefined;
		const parsed = await tool.inputSchema.safeParseAsync(args ?? {});
		if (!parsed.success) {
			throw new ToolError(
				"INVALID_ARGUMENT",
				`${describeIssues(parsed.error)}. Fix the arguments of ${toolName} and call it again.`,
			);
		}
		return parsed.data;
	};
}

/** A message of one line: no stack trace, nothing the caller cannot act on. */
function oneLine(message: string): string {
	return message.split("\n")[0].slice(0, 500);
}

/** A session `RunError` as the stable message the tools return. */
function coded(error: RunError): string {
	switch (error.code) {
		case "WORKER_BUSY":
			return `WORKER_BUSY: ${error.message}`;
		case "APPROVAL_NOT_FOUND":
			return `APPROVAL_NOT_FOUND: ${error.message}`;
		case "WORKER_NOT_RUNNING":
			return `WORKER_NOT_FOUND: ${oneLine(error.message)}`;
		default:
			return `PROVIDER_UNAVAILABLE: ${oneLine(error.message)}. Call get_run for the run's details, or spawn a new worker.`;
	}
}

export function failure(error: unknown): CallToolResult {
	let message: string;
	if (error instanceof ToolError) message = error.message;
	else if (error instanceof PolicyError) {
		message = `INVALID_ARGUMENT: ${oneLine(error.message)}. Fix the policy and call the tool again.`;
	} else if (error instanceof RunError) {
		message = coded(error);
	} else {
		// A run that failed, or anything unforeseen: the worker's side.
		const detail = error instanceof Error ? error.message : String(error);
		message = `PROVIDER_UNAVAILABLE: ${oneLine(detail)}. Call get_run for the run's details, or spawn a new worker.`;
	}
	return { isError: true, content: [{ type: "text", text: message }] };
}

/** Run a handler; every failure becomes an error result, never a crash. */
export function guarded<A>(
	fn: (args: A, extra: Extra) => Promise<CallToolResult>,
) {
	return async (args: A, extra: Extra): Promise<CallToolResult> => {
		try {
			return await fn(args, extra);
		} catch (error) {
			return failure(error);
		}
	};
}

export const text = (t: string): CallToolResult => ({
	content: [{ type: "text", text: t }],
});

/**
 * A result of a neutral tool: `data` as `structuredContent` (worker-written
 * fields raw, under `untrusted…` keys) and, as the one text block, a summary
 * line followed by the same data with those fields wrapped.
 */
export function ok<T extends object>(
	summary: string,
	data: T,
	fallbackId = "none",
	attr: "run" | "worker" = "run",
): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: `${summary}\n${JSON.stringify(wrapTree(data, fallbackId, attr), null, 2)}`,
			},
		],
		structuredContent: data as Record<string, unknown>,
	};
}

/** One line for the tool result: the policy in force and what was changed. */
export function describePolicy(report: PolicyReport): string {
	const p = report.policy;
	const lines = [
		`Auto-approve up to: ${RiskLevel[p.autoApproveUpTo]}, overrides: ${p.overrides.length}.`,
	];
	if (report.clamped.length > 0) {
		lines.push(
			`Lowered to the server's ceiling: ${report.clamped.join("; ")}.`,
		);
	}
	lines.push(...report.notes.map((n) => `Note: ${n}.`));
	return lines.join(" ");
}

export function policyData(report: PolicyReport["policy"]): PolicyData {
	return {
		autoApproveUpTo: RiskLevel[report.autoApproveUpTo],
		overrides: report.overrides as unknown as Record<string, unknown>[],
		classifiers: report.classifiers,
	};
}

export interface ServerOptions {
	/** How often a waiting call sends a progress heartbeat (default 10 s). */
	progressHeartbeatMs?: number;
}

export interface ToolContext {
	manager: SessionManager;
	/** Wait up to `waitMs` on `run` (with progress), then describe it. */
	waitAndView(
		run: Run,
		waitMs: number,
		extra: Extra,
		view?: { sinceSeq?: number; outputOffset?: number; maxChars?: number },
	): Promise<RunData>;
	/** A run's data without waiting. */
	viewRun(
		run: Run,
		view?: { sinceSeq?: number; outputOffset?: number; maxChars?: number },
	): RunData;
	reportProgress(extra: Extra, run: Run): () => void;
	clampWait(ms: number | undefined, fallback: number): number;
	findRun(runId: string): Run;
	workerData(session: Session): WorkerData;
}

/** One line about a run, for the text block. */
export function runSummary(v: RunData): string {
	return `Run ${v.runId}: ${v.state} (seq ${v.seq}, ${Math.round(v.elapsedMs / 1000)} s).`;
}

export function createContext(
	manager: SessionManager,
	options: ServerOptions,
): ToolContext {
	const heartbeatMs = options.progressHeartbeatMs ?? 10_000;
	const limits = manager.config.limits;
	const store = manager.runs;

	function reportProgress(extra: Extra, run: Run): () => void {
		const token = extra["_meta"]?.progressToken;
		if (token === undefined) return () => {};
		let last = 0;
		const send = (message: string) => {
			last = Math.max(last + 1, run.seq);
			extra
				.sendNotification({
					method: "notifications/progress",
					params: { progressToken: token, progress: last, message },
				})
				.catch(() => {});
		};
		// What the worker did is untrusted, whatever channel carries it.
		const unsubscribe = store.subscribe(run.id, (message) =>
			send(wrapUntrusted(run.id, message)),
		);
		const beat = setInterval(
			() =>
				send(
					`${run.state}, ${Math.round((Date.now() - run.createdAt) / 1000)} s`,
				),
			heartbeatMs,
		);
		beat.unref?.();
		return () => {
			unsubscribe();
			clearInterval(beat);
		};
	}

	const viewRun: ToolContext["viewRun"] = (run, view = {}) =>
		runData(
			runView(run, {
				sinceSeq: view.sinceSeq,
				outputOffset: view.outputOffset,
				maxChars: Math.min(view.maxChars ?? limits.pageChars, MAX_PAGE_CHARS),
			}),
		);

	return {
		manager,
		reportProgress,
		viewRun,
		clampWait: (ms, fallback) =>
			Math.max(0, Math.min(ms ?? fallback, limits.maxWaitMs)),
		async waitAndView(run, waitMs, extra, view = {}) {
			if (waitMs > 0) {
				const stop = reportProgress(extra, run);
				try {
					await store.waitForChange(run, {
						sinceSeq: view.sinceSeq,
						maxWaitMs: waitMs,
						signal: extra.signal,
					});
				} finally {
					stop();
				}
			}
			return viewRun(run, view);
		},
		findRun(runId) {
			const run = store.get(runId);
			if (!run) {
				throw new ToolError(
					"RUN_NOT_FOUND",
					`No run ${runId}; it may have expired (results are kept for a limited time), so start a new run if you still need the result.`,
				);
			}
			return run;
		},
		workerData(session) {
			const runs = store.runsOf(session.sessionId);
			return {
				workerId: session.sessionId,
				name: session.name ?? null,
				provider: session.providerId,
				cwd: session.cwd,
				model: session.model,
				status: session.status,
				sandbox: "none",
				capabilities: session.capabilities,
				effectivePolicy: policyData(session.riskPolicy),
				currentRunId: session.activeRun?.id ?? null,
				pendingApprovals: session.pendingActions.length,
				recentRuns: runs
					.slice(-5)
					.map((r) => ({ runId: r.id, state: r.state })),
			};
		},
	};
}
