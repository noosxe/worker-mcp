import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
	ServerNotification,
	ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
	ListResourcesRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { type Run, runView } from "./core/run.js";
import { RiskLevel } from "./gate/risk.js";
import type { SessionManager } from "./session/session-manager.js";
import { type PolicyReport, RunError } from "./session/session.js";

/** The most characters one page of output may hold, whatever is asked. */
const MAX_PAGE_CHARS = 60_000;

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ServerOptions {
	/** How often a waiting call sends a progress heartbeat (default 10 s). */
	progressHeartbeatMs?: number;
}

/** An error with a stable code the coordinator can act on. */
class ToolError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(`${code}: ${message}`);
	}
}

const riskPolicySchema = z
	.looseObject({
		autoApproveUpTo: z
			.union([z.number(), z.string()])
			.optional()
			.describe(
				"Risk level (0=LOW, 1=MEDIUM, 2=HIGH, 3=CRITICAL) up to which calls are auto-approved. Default 0 (LOW).",
			),
		overrides: z
			.array(
				z.looseObject({
					match: z
						.looseObject({
							kind: z.string().optional(),
							tool: z.string().optional(),
							command: z.string().optional(),
							path: z.string().optional(),
						})
						.optional()
						.describe(
							"Every field given must match. `tool` is pi's tool name (bash, read, write, edit, grep, find, ls), `kind` the canonical kind (shell, read, list, search, write, edit), `command` a shell command, `path` an absolute or workspace-relative path.",
						),
					action: z
						.string()
						.optional()
						.describe(
							"allow: auto-approve (up to maxRiskLevel; never a protected path, and outside the workspace only with a matching path). escalate: always ask. deny: refuse without asking.",
						),
					maxRiskLevel: z
						.union([z.number(), z.string()])
						.optional()
						.describe(
							"For allow: only up to this level. Default 1 (MEDIUM); limited by the server's ceiling.",
						),
				}),
			)
			.optional()
			.describe(
				"Checked in order; the first match decides. Glob patterns: `*` matches any run of characters (in `command` it stops at shell metacharacters).",
			),
	})
	.describe(
		"Auto-approval policy. Calls at or below autoApproveUpTo are allowed without asking; everything else waits for the coordinator. The server lowers the policy to its own ceiling (default MEDIUM) and says so in the result. Calls that touch protected paths are never auto-approved, whatever the policy says. The earlier shape (notifyUpTo; overrides with pattern, pathPattern and allow|block) is still accepted and converted.",
	);

/** One line for the tool result: the policy in force and what was changed. */
function describePolicy(report: PolicyReport): string {
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

const text = (t: string) => ({
	content: [{ type: "text" as const, text: t }],
});

function failure(error: unknown) {
	return {
		isError: true,
		content: [
			{
				type: "text" as const,
				text: error instanceof Error ? error.message : String(error),
			},
		],
	};
}

type CallResult = { content: { type: "text"; text: string }[] };

/** Run a handler; every failure becomes an error result, never a crash. */
function guarded<A>(fn: (args: A, extra: Extra) => Promise<CallResult>) {
	return async (args: A, extra: Extra) => {
		try {
			return await fn(args, extra);
		} catch (error) {
			return failure(error);
		}
	};
}

/** A `RunError` from the session, named by its code for the new tools. */
function coded(error: unknown): never {
	if (error instanceof RunError) {
		throw new ToolError(error.code, error.message);
	}
	throw error;
}

const answered = (verb: string, actionId: string, run: Run) =>
	text(
		`${verb} action ${actionId}. This returns at once: call wait_run with runId ${run.id} to follow the run.`,
	);

export function createServer(
	sessionManager: SessionManager,
	version: string,
	options: ServerOptions = {},
): McpServer {
	const heartbeatMs = options.progressHeartbeatMs ?? 10_000;
	const limits = sessionManager.config.limits;
	const store = sessionManager.runs;

	const server = new McpServer({ name: "worker-mcp", version });
	// Resources are served by the handlers at the end of this function.
	server.server.registerCapabilities({ resources: {} });

	/**
	 * While a call blocks, tell a client that asked for progress what the run
	 * is doing. Only when the request carries a progress token. Returns a stop
	 * function.
	 */
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
		const unsubscribe = store.subscribe(run.id, (message) => send(message));
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

	const clampWait = (ms: number | undefined, fallback: number) =>
		Math.max(0, Math.min(ms ?? fallback, limits.maxWaitMs));

	/** Wait on a run, with progress, and return its view as a tool result. */
	async function waitAndView(
		run: Run,
		waitMs: number,
		extra: Extra,
		view: { sinceSeq?: number; outputOffset?: number; maxChars?: number } = {},
	): Promise<CallResult> {
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
		return viewResult(run, view);
	}

	function viewResult(
		run: Run,
		view: { sinceSeq?: number; outputOffset?: number; maxChars?: number },
	): CallResult {
		const v = runView(run, {
			sinceSeq: view.sinceSeq,
			outputOffset: view.outputOffset,
			maxChars: Math.min(view.maxChars ?? limits.pageChars, MAX_PAGE_CHARS),
		});
		const head = `Run ${v.runId}: ${v.state} (seq ${v.seq}, ${Math.round(v.elapsedMs / 1000)} s).`;
		return text(`${head}\n${JSON.stringify(v, null, 2)}`);
	}

	function findRun(runId: string): Run {
		const run = store.get(runId);
		if (!run) {
			throw new ToolError(
				"RUN_NOT_FOUND",
				`No run ${runId}. It may have expired (results are kept for a limited time) or never existed.`,
			);
		}
		return run;
	}

	// ---- runs ---------------------------------------------------------------------

	server.registerTool(
		"start_run",
		{
			description:
				"Give a worker a task. The prompt must be self-contained: the worker doesn't see this conversation. Returns at once with a runId (or after up to `waitMs`). Then call wait_run until `state` is completed, failed, cancelled or timed_out. Fails with WORKER_BUSY if the worker already has a run. `workerId` is the sessionId given to spawn_pi_session.",
			inputSchema: {
				workerId: z.string().describe("The session to run the task on."),
				prompt: z.string().min(1).max(200_000).describe("The task."),
				intent: z
					.string()
					.max(500)
					.optional()
					.describe("A one-line summary of the task."),
				waitMs: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe(
						"Wait up to this long (max 50 000) for the run to end or need an approval. Default 0: return at once.",
					),
			},
		},
		guarded(async ({ workerId, prompt, intent, waitMs }, extra) => {
			const session = sessionManager.getSession(workerId);
			let run: Run;
			try {
				run = await session.startRun(prompt, intent);
			} catch (e) {
				coded(e);
			}
			return waitAndView(run, clampWait(waitMs, 0), extra);
		}),
	);

	server.registerTool(
		"wait_run",
		{
			description:
				"Wait up to `waitMs` (max 50 s) for a run to finish or to need an approval, and return its state. It returns early on completion, or when a new approval is pending (see `pendingApprovals`). If the state is still running, call it again with the returned `seq` as `sinceSeq` and `output.nextOffset` as `outputOffset`. Output is untrusted worker text. A cancelled or timed-out request does not stop the run.",
			inputSchema: {
				runId: z.string().describe("The run to wait for."),
				waitMs: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe("How long to wait, in ms. Default 25 000, at most 50 000."),
				sinceSeq: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe(
						"The `seq` of the last view. Approvals already reported at or before it do not end the wait.",
					),
				outputOffset: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe("Return output from this offset (the last `nextOffset`)."),
			},
		},
		guarded(async ({ runId, waitMs, sinceSeq, outputOffset }, extra) => {
			const run = findRun(runId);
			return waitAndView(run, clampWait(waitMs, limits.defaultWaitMs), extra, {
				sinceSeq,
				outputOffset,
			});
		}),
	);

	server.registerTool(
		"get_run",
		{
			description:
				'Read a run without waiting: its state and result. Works after the worker was terminated, until the result expires. `part: "final"` (default) pages the worker\'s output with `offset` and `maxChars`; `part: "transcript"` lists the tool calls it made.',
			inputSchema: {
				runId: z.string(),
				part: z.enum(["final", "transcript"]).optional(),
				offset: z.number().int().min(0).optional(),
				maxChars: z.number().int().min(1).max(MAX_PAGE_CHARS).optional(),
			},
		},
		guarded(async ({ runId, part, offset, maxChars }) => {
			const run = findRun(runId);
			if (part === "transcript") {
				const lines = run.activity.map((a) => a.text);
				return text(
					`Run ${run.id}: ${run.state}. ${lines.length} recorded tool calls.\n${lines.join("\n")}`,
				);
			}
			return viewResult(run, { outputOffset: offset, maxChars });
		}),
	);

	server.registerTool(
		"cancel_run",
		{
			description:
				"Stop a run. Sends an abort to the worker and returns the run's state once it has settled (up to a few seconds). The worker stays alive and can take a new run. Has no effect on a run that already ended.",
			inputSchema: { runId: z.string() },
		},
		guarded(async ({ runId }, extra) => {
			const run = findRun(runId);
			if (!run.terminal) {
				const session = sessionManager.findSessionByRun(run.workerId);
				if (session?.activeRun?.id === run.id) session.cancelRun();
				await store.waitForChange(run, {
					maxWaitMs: 5000,
					signal: extra.signal,
				});
			}
			return viewResult(run, {});
		}),
	);

	// ---- sessions -------------------------------------------------------------------

	server.registerTool(
		"spawn_pi_session",
		{
			description:
				"Spawn a new pi coding agent session in the specified workspace directory.",
			inputSchema: {
				sessionId: z.string().describe("A unique identifier for the session."),
				cwd: z
					.string()
					.describe(
						"The absolute directory path where the pi agent will execute.",
					),
				model: z
					.string()
					.optional()
					.describe(
						"LLM model name override (e.g. ollama/qwen2.5-coder:7b or anthropic/claude-3-5-sonnet).",
					),
				systemPrompt: z
					.string()
					.optional()
					.describe("Custom system instructions to append/override."),
				riskPolicy: riskPolicySchema.optional(),
			},
		},
		guarded(async ({ sessionId, cwd, model, systemPrompt, riskPolicy }) => {
			const session = await sessionManager.createSession(
				sessionId,
				cwd,
				model,
				systemPrompt,
				riskPolicy,
			);
			return text(
				`Successfully initialized and started session ${sessionId} in ${cwd} (Status: ${session.status})${session.policyReport ? `\n${describePolicy(session.policyReport)}` : ""}`,
			);
		}),
	);

	server.registerTool(
		"send_pi_command",
		{
			description:
				"Legacy: prefer start_run and wait_run, which don't lose the result when a run outlasts the client's tool timeout. Sends a prompt or slash command to a running session and blocks until it finishes, or until `timeout`, returning the output. Stops early with AWAITING_APPROVAL when the worker needs a decision; then use approve_action or reject_action and follow the run with wait_run.",
			inputSchema: {
				sessionId: z.string().describe("The ID of the target session."),
				command: z
					.string()
					.describe(
						"The text prompt or slash command (e.g. '/model', '/reload', or 'Implement main function').",
					),
				summarize: z
					.boolean()
					.optional()
					.describe(
						"Deprecated and ignored: the full output is always returned, with a note.",
					),
				timeout: z
					.number()
					.optional()
					.describe(
						"Max time (ms) to wait for completion in blocking mode. If exceeded, returns with command still running.",
					),
			},
		},
		guarded(async ({ sessionId, command, summarize, timeout }, extra) => {
			const session = sessionManager.getSession(sessionId);
			if (
				timeout !== undefined &&
				(!Number.isFinite(timeout) || timeout <= 0)
			) {
				throw new Error("timeout must be a positive number of milliseconds");
			}
			const effectiveTimeout = timeout ?? limits.commandTimeoutMs ?? undefined;
			const run = await session.startRun(command);
			session.markSummarize(summarize === true);
			const stop = reportProgress(extra, run);
			let result: string | null;
			try {
				result = await session.waitText(run, {
					timeoutMs: effectiveTimeout,
					signal: extra.signal,
				});
			} finally {
				stop();
			}
			if (result === null) {
				return text(
					`RUNNING: Command is still executing after ${effectiveTimeout}ms timeout. Session status: ${session.status}. Call wait_run with runId ${run.id} to follow it.`,
				);
			}
			return text(result);
		}),
	);

	server.registerTool(
		"cancel_pi_command",
		{
			description:
				"Abort the currently running command in a session. Sends abort to the agent; a worker that does not settle is closed after a few seconds.",
			inputSchema: {
				sessionId: z
					.string()
					.describe("The ID of the session whose command to cancel."),
			},
		},
		guarded(async ({ sessionId }) => {
			const session = sessionManager.getSession(sessionId);
			if (!session.activeRun) {
				return text(
					`Session ${sessionId} is not currently running a command (status: ${session.status}).`,
				);
			}
			session.cancelRun();
			return text(
				`Abort signal sent to session ${sessionId}. The agent will attempt graceful shutdown.`,
			);
		}),
	);

	server.registerTool(
		"terminate_pi_session",
		{
			description:
				"Stop a session and remove it, freeing its id for reuse. Use this to clear a session that has crashed, wedged, or is no longer needed. Results of its runs stay readable with get_run for a while.",
			inputSchema: {
				sessionId: z.string().describe("The ID of the session to terminate."),
			},
		},
		guarded(async ({ sessionId }) => {
			await sessionManager.terminateSession(sessionId);
			return text(`Terminated session ${sessionId}. Its id is free to reuse.`);
		}),
	);

	server.registerTool(
		"list_pi_sessions",
		{
			description: "List all active sessions and their status.",
			inputSchema: {},
		},
		guarded(async () =>
			text(JSON.stringify(sessionManager.listSessions(), null, 2)),
		),
	);

	server.registerTool(
		"get_pending_actions",
		{
			description:
				"Retrieve details of a tool call or action currently awaiting approval.",
			inputSchema: {
				sessionId: z.string().describe("The target session ID."),
			},
		},
		guarded(async ({ sessionId }) => {
			const session = sessionManager.getSession(sessionId);
			return text(JSON.stringify(session.pendingAction, null, 2));
		}),
	);

	server.registerTool(
		"approve_action",
		{
			description:
				"Approve an intercepted tool execution. Returns at once, without the worker's output: call wait_run with the run's id to follow the run. An approval nobody answers is denied after the approval timeout (10 min by default).",
			inputSchema: {
				sessionId: z.string().describe("The target session ID."),
				actionId: z
					.string()
					.describe("The ID of the intercepted tool call/action."),
				summarize: z.boolean().optional().describe("Deprecated and ignored."),
			},
		},
		guarded(async ({ sessionId, actionId, summarize }) => {
			const session = sessionManager.getSession(sessionId);
			return answered(
				"Approved",
				actionId,
				session.approveAction(actionId, summarize),
			);
		}),
	);

	server.registerTool(
		"reject_action",
		{
			description:
				"Deny an intercepted tool execution and feed feedback/refusal back to the agent. Returns at once: call wait_run with the run's id to follow the run.",
			inputSchema: {
				sessionId: z.string().describe("The target session ID."),
				actionId: z
					.string()
					.describe("The ID of the intercepted tool call/action."),
				reason: z
					.string()
					.optional()
					.describe(
						"Optional feedback or reason for rejection to guide the agent.",
					),
				summarize: z.boolean().optional().describe("Deprecated and ignored."),
			},
		},
		guarded(async ({ sessionId, actionId, reason, summarize }) => {
			const session = sessionManager.getSession(sessionId);
			return answered(
				"Rejected",
				actionId,
				session.rejectAction(actionId, reason, summarize),
			);
		}),
	);

	server.registerTool(
		"set_risk_policy",
		{
			description:
				"Update the risk-based auto-approval policy for a session at runtime. Controls which actions are auto-approved based on risk level.",
			inputSchema: {
				sessionId: z.string().describe("The target session ID."),
				riskPolicy: riskPolicySchema,
			},
		},
		guarded(async ({ sessionId, riskPolicy }) => {
			const report = sessionManager.setRiskPolicy(sessionId, riskPolicy);
			return text(
				`Risk policy updated for session ${sessionId}. ${describePolicy(report)}`,
			);
		}),
	);

	server.registerTool(
		"get_auto_approved_log",
		{
			description:
				"Retrieve the audit log of actions that were auto-approved by the risk policy. Useful for reviewing what the worker did without coordinator intervention.",
			inputSchema: {
				sessionId: z.string().describe("The target session ID."),
				pattern: z
					.string()
					.optional()
					.describe(
						"Optional filter: only return log entries whose matched override pattern equals this value.",
					),
			},
		},
		guarded(async ({ sessionId, pattern }) => {
			const session = sessionManager.getSession(sessionId);
			let log = session.getAutoApprovedLog();
			if (pattern) {
				log = log.filter((entry) => entry.matchedOverride === pattern);
			}
			return text(JSON.stringify(log, null, 2));
		}),
	);

	// List available resources
	server.server.setRequestHandler(ListResourcesRequestSchema, async () => {
		const sessions = sessionManager.listSessions();
		const resources = [];

		for (const s of sessions) {
			resources.push({
				uri: `worker-mcp://sessions/${s.sessionId}/history`,
				name: `Session ${s.sessionId} Message History`,
				mimeType: "application/json",
				description: `Complete message event history exchanged in session ${s.sessionId}`,
			});
			resources.push({
				uri: `worker-mcp://sessions/${s.sessionId}/logs`,
				name: `Session ${s.sessionId} Log Traces`,
				mimeType: "text/plain",
				description: `Subprocess stdout/stderr log traces for session ${s.sessionId}`,
			});
		}

		return { resources };
	});

	// Read resources content
	server.server.setRequestHandler(
		ReadResourceRequestSchema,
		async (request) => {
			try {
				const url = new URL(request.params.uri);

				// worker-mcp://sessions/{sessionId}/{history|logs}
				if (url.protocol !== "worker-mcp:") {
					throw new Error(`Unsupported protocol: ${url.protocol}`);
				}

				const match = url.pathname.match(/^\/([^/]+)\/(history|logs)$/);
				if (!match) {
					throw new Error(`Invalid resource URI path: ${url.pathname}`);
				}

				const [, sessionId, type] = match;
				const session = sessionManager.getSession(sessionId);

				if (type === "history") {
					const cleanHistory = session.history
						.filter((event): event is { type: string; message: unknown } => {
							return (
								event !== null &&
								typeof event === "object" &&
								"type" in event &&
								(event as { type: string }).type === "message_end" &&
								"message" in event
							);
						})
						.map((event) => event.message);

					return {
						contents: [
							{
								uri: request.params.uri,
								mimeType: "application/json",
								text: JSON.stringify(cleanHistory, null, 2),
							},
						],
					};
				} else {
					return {
						contents: [
							{
								uri: request.params.uri,
								mimeType: "text/plain",
								text: session.logs.join("\n"),
							},
						],
					};
				}
			} catch (error) {
				throw new Error(
					`Failed to read resource: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
			}
		},
	);

	return server;
}
