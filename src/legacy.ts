import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";

import { ToolError } from "./errors.js";
import { wrapUntrusted } from "./render.js";
import { schemas } from "./schemas.js";
import {
	describePolicy,
	failure,
	guarded,
	text,
	type ToolContext,
} from "./tool-support.js";
import { ANNOTATIONS, gateEntries } from "./tools.js";

/**
 * The deprecated pi-named tools of 0.4, kept as aliases of the neutral ones
 * for one minor. They are listed only while `config.legacyTools` is on, and
 * they keep their old text results.
 */
export const LEGACY_TOOLS = {
	spawn_pi_session: "spawn_worker",
	send_pi_command: "start_run and wait_run",
	cancel_pi_command: "cancel_run",
	terminate_pi_session: "terminate_worker",
	list_pi_sessions: "list_workers",
	get_auto_approved_log: "get_gate_log",
} as const;

export function registerLegacyTools(server: McpServer, ctx: ToolContext): void {
	const { manager } = ctx;
	const limits = manager.config.limits;

	server.registerTool(
		"spawn_pi_session",
		{
			annotations: {
				...ANNOTATIONS.spawn_worker,
				title: "Spawn a pi worker (deprecated)",
			},
			title: "Spawn a pi worker (deprecated)",
			description:
				"Deprecated, use spawn_worker: it takes `provider`, `name` and `policy`. Spawns a pi coding agent in the workspace directory `cwd` and returns its worker id (w_…). `sessionId` is the old spelling of `name`; `riskPolicy` of `policy`.",
			inputSchema: schemas.spawn,
		},
		guarded(
			async ({ name, sessionId, cwd, model, systemPrompt, riskPolicy }) => {
				if (
					name !== undefined &&
					sessionId !== undefined &&
					name !== sessionId
				) {
					throw new ToolError(
						"INVALID_ARGUMENT",
						"name and sessionId differ; give only name.",
					);
				}
				const session = await manager.createSession(
					name ?? sessionId,
					cwd,
					model,
					systemPrompt,
					riskPolicy,
					"pi",
				);
				const label = session.name ? ` (name ${session.name})` : "";
				return text(
					`Successfully initialized and started worker ${session.sessionId}${label} in ${session.cwd} (Status: ${session.status})${session.policyReport ? `\n${describePolicy(session.policyReport)}` : ""}`,
				);
			},
		),
	);

	server.registerTool(
		"send_pi_command",
		{
			annotations: {
				...ANNOTATIONS.start_run,
				title: "Send a command to a pi worker (deprecated)",
			},
			title: "Send a command to a pi worker (deprecated)",
			description:
				"Deprecated, use start_run and wait_run: they don't lose the result when a run outlasts the client's tool timeout. Sends a prompt to a worker (id or name) and waits up to `timeout` ms (at most 50 s). Returns the output (untrusted, wrapped in <worker_output> tags) when the run is done, otherwise the runId and a note to call wait_run. Stops early with AWAITING_APPROVAL when the worker needs a decision. `summarize` is ignored.",
			inputSchema: schemas.send,
		},
		guarded(async ({ sessionId, command, summarize, timeout }, extra) => {
			const session = manager.getSession(sessionId);
			const waitMs = Math.min(
				timeout ?? limits.commandTimeoutMs ?? limits.maxWaitMs,
				limits.maxWaitMs,
			);
			const run = await session.startRun(command);
			session.markSummarize(summarize === true);
			const stop = ctx.reportProgress(extra, run);
			let result: string | null;
			try {
				result = await session.waitText(run, {
					timeoutMs: waitMs,
					signal: extra.signal,
				});
			} finally {
				stop();
			}
			if (result === null) {
				return text(
					`RUNNING: Command is still executing after ${waitMs}ms. Session status: ${session.status}. Call wait_run with runId ${run.id} to follow it.`,
				);
			}
			return text(result);
		}),
	);

	server.registerTool(
		"cancel_pi_command",
		{
			annotations: {
				...ANNOTATIONS.cancel_run,
				title: "Cancel a pi worker's command (deprecated)",
			},
			title: "Cancel a pi worker's command (deprecated)",
			description:
				"Deprecated, use cancel_run: it takes the runId. Aborts the command a worker (id or name) is running. Sends abort to the agent; a worker that does not settle is closed after a few seconds.",
			inputSchema: schemas.cancelCommand,
		},
		guarded(async ({ sessionId }) => {
			const session = manager.getSession(sessionId);
			if (!session.activeRun) {
				return text(
					`Worker ${session.sessionId} is not currently running a command (status: ${session.status}).`,
				);
			}
			session.cancelRun();
			return text(
				`Abort signal sent to worker ${session.sessionId}. The agent will attempt graceful shutdown.`,
			);
		}),
	);

	server.registerTool(
		"terminate_pi_session",
		{
			annotations: {
				...ANNOTATIONS.terminate_worker,
				title: "Terminate a pi worker (deprecated)",
			},
			title: "Terminate a pi worker (deprecated)",
			description:
				"Deprecated, use terminate_worker. Stops a worker (id or name) and removes it, freeing its name and its place under the worker limit. Results of its runs stay readable with get_run for a while.",
			inputSchema: schemas.terminate,
		},
		guarded(async ({ sessionId }) => {
			const session = manager.getSession(sessionId);
			await manager.terminateSession(session.sessionId);
			return text(
				`Terminated worker ${session.sessionId}${session.name ? ` (${session.name})` : ""}.`,
			);
		}),
	);

	server.registerTool(
		"list_pi_sessions",
		{
			annotations: {
				...ANNOTATIONS.list_workers,
				title: "List pi workers (deprecated)",
			},
			title: "List pi workers (deprecated)",
			description:
				"Deprecated, use list_workers. Lists the live workers: id, name, workspace, status, current run and the number of approvals waiting.",
			inputSchema: schemas.list,
		},
		guarded(async () => text(JSON.stringify(manager.listSessions(), null, 2))),
	);

	server.registerTool(
		"get_auto_approved_log",
		{
			annotations: {
				...ANNOTATIONS.get_gate_log,
				title: "Auto-approved log (deprecated)",
			},
			title: "Auto-approved log (deprecated)",
			description:
				"Deprecated, use get_gate_log: it shows every decision, not only auto-approvals. Lists the calls the risk policy allowed without asking (newest last, at most `limit`, max 200). `pattern` keeps the entries whose preview contains it. The previews are untrusted worker data.",
			inputSchema: schemas.autoApprovedLog,
		},
		guarded(async ({ sessionId, pattern, limit }) => {
			const session = manager.getSession(sessionId);
			let entries = gateEntries(session, { limit: 500 }).filter(
				(e) => e.decision === "allow" && e.decidedBy !== "coordinator",
			);
			if (pattern)
				entries = entries.filter((e) => e.untrustedPreview.includes(pattern));
			entries = entries.slice(-(limit ?? 200));
			return text(
				JSON.stringify(
					entries.map((e) => ({
						...e,
						untrustedPreview: undefined,
						preview: wrapUntrusted(
							session.sessionId,
							e.untrustedPreview,
							"worker",
						),
					})),
					null,
					2,
				),
			);
		}),
	);
}

/**
 * With the aliases off a call to one gets an error that says why, not a bare
 * "unknown tool". The SDK has no hook for this; a test pins it.
 */
export function explainDisabledAliases(server: McpServer): void {
	// oxlint-disable-next-line no-underscore-dangle -- the SDK keeps its handlers here
	const handlers = (server.server as unknown as Record<string, unknown>)[
		"_requestHandlers"
	] as Map<string, (req: unknown, extra: unknown) => unknown> | undefined;
	const original = handlers?.get("tools/call");
	if (!handlers || !original) return;
	server.server.setRequestHandler(
		CallToolRequestSchema,
		async (request: CallToolRequest, extra) => {
			const name = request.params.name;
			if (Object.hasOwn(LEGACY_TOOLS, name)) {
				return failure(
					new ToolError(
						"INVALID_ARGUMENT",
						`${name} is a deprecated alias and is switched off (WORKER_MCP_LEGACY_TOOLS=0). Use ${LEGACY_TOOLS[name as keyof typeof LEGACY_TOOLS]}.`,
					),
				);
			}
			return (await original(request, extra)) as never;
		},
	);
}
