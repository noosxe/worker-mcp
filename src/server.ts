import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { RiskLevel } from "./session/risk-classifier.js";
import type { RiskPolicy } from "./session/risk-policy.js";
import type { SessionManager } from "./session/session-manager.js";
import { TaskSettler } from "./task-settle.js";

const DEFAULT_TASK_TTL_MS = 60 * 60 * 1000;

/** Build the MCP server for a session manager. Does not connect a transport. */

export function createServer(
	sessionManager: SessionManager,
	version: string,
): Server {
	const taskStore = new InMemoryTaskStore();
	const taskSettler = new TaskSettler(taskStore);

	// Initialize the MCP Server
	const server = new Server(
		{
			name: "worker-mcp",
			version: version,
		},
		{
			capabilities: {
				resources: {},
				tools: {},
				tasks: {
					list: {},
					cancel: {},
					requests: {
						tools: { call: {} },
					},
				},
			},
			taskStore,
			defaultTaskPollInterval: 5000,
		},
	);

	// Wire MCP task cancellation to pi session abort
	const originalUpdateTaskStatus = taskStore.updateTaskStatus.bind(taskStore);
	taskStore.updateTaskStatus = async (
		taskId,
		status,
		statusMessage,
		sessionId,
	) => {
		await originalUpdateTaskStatus(taskId, status, statusMessage, sessionId);
		if (status === "cancelled") {
			const session = sessionManager.findSessionByTaskId(taskId);
			if (session && session.status === "RUNNING") {
				session.abortCommand();
			}
		}
	};

	// Wire session status changes to task status updates
	sessionManager.onSessionStatusChange = (sessionId, status, message) => {
		let taskId: string | null;
		try {
			taskId = sessionManager.getSession(sessionId).getActiveTaskId();
		} catch {
			return;
		}
		if (!taskId) return;

		if (status === "AWAITING_APPROVAL") {
			taskStore
				.updateTaskStatus(taskId, "input_required", message)
				.catch(() => {});
		} else if (status === "CRASHED") {
			void taskSettler.settle(taskId, "failed", {
				content: [
					{ type: "text" as const, text: message ?? "Session crashed" },
				],
				isError: true,
			});
		}
	};

	// approve/reject continue a run whose task was left input_required. Settle
	// that task once the run really stops (and not at another approval prompt).
	async function finishTaskAfter(
		session: ReturnType<SessionManager["getSession"]>,
		action: () => Promise<string>,
	): Promise<string> {
		const taskId = session.getActiveTaskId();
		let result: string;
		try {
			result = await action();
		} catch (err) {
			if (taskId && !session.isAlive()) {
				await taskSettler.settle(taskId, "failed", {
					content: [
						{
							type: "text" as const,
							text: err instanceof Error ? err.message : String(err),
						},
					],
					isError: true,
				});
			}
			throw err;
		}
		if (taskId && session.status !== "AWAITING_APPROVAL") {
			await taskSettler.settle(taskId, "completed", {
				content: [{ type: "text" as const, text: result }],
			});
		}
		return result;
	}

	// Define tools list
	server.setRequestHandler(ListToolsRequestSchema, async () => {
		return {
			tools: [
				{
					name: "spawn_pi_session",
					description:
						"Spawn a new pi coding agent session in the specified workspace directory.",
					inputSchema: {
						type: "object",
						properties: {
							sessionId: {
								type: "string",
								description: "A unique identifier for the session.",
							},
							cwd: {
								type: "string",
								description:
									"The absolute directory path where the pi agent will execute.",
							},
							model: {
								type: "string",
								description:
									"LLM model name override (e.g. ollama/qwen2.5-coder:7b or anthropic/claude-3-5-sonnet).",
							},
							systemPrompt: {
								type: "string",
								description: "Custom system instructions to append/override.",
							},
							riskPolicy: {
								type: "object",
								description:
									"Risk-based auto-approval policy. Controls which tool calls are auto-approved based on risk level. If not specified, defaults to auto-approve LOW risk and notify on MEDIUM risk.",
								properties: {
									autoApproveUpTo: {
										type: "number",
										description:
											"Actions at or below this risk level (0=LOW, 1=MEDIUM, 2=HIGH, 3=CRITICAL) are auto-approved silently. Default: 0 (LOW).",
									},
									notifyUpTo: {
										type: "number",
										description:
											"Actions at or below this level (but above autoApproveUpTo) are auto-approved with a logged notification. Default: 1 (MEDIUM).",
									},
									overrides: {
										type: "array",
										description:
											"Custom overrides for specific command patterns.",
										items: {
											type: "object",
											properties: {
												pattern: {
													type: "string",
													description:
														"Glob pattern to match against command string or tool name.",
												},
												pathPattern: {
													type: "string",
													description:
														"Optional glob pattern to match against the target file path. When set, both pattern and pathPattern must match for the override to apply.",
												},
												action: {
													type: "string",
													enum: ["allow", "block"],
													description:
														"Force allow (auto-approve) or block (require approval).",
												},
												maxRiskLevel: {
													type: "number",
													description:
														"Only apply this override if the classified risk is at or below this level (0=LOW, 1=MEDIUM, 2=HIGH, 3=CRITICAL). Omit to apply at any risk level.",
												},
											},
											required: ["pattern", "action"],
										},
									},
								},
							},
						},
						required: ["sessionId", "cwd"],
					},
				},
				{
					name: "send_pi_command",
					description: "Send a prompt or slash command to a running session.",
					inputSchema: {
						type: "object",
						properties: {
							sessionId: {
								type: "string",
								description: "The ID of the target session.",
							},
							command: {
								type: "string",
								description:
									"The text prompt or slash command (e.g. '/model', '/reload', or 'Implement main function').",
							},
							summarize: {
								type: "boolean",
								description:
									"Deprecated and ignored: the full output is always returned, with a note.",
							},
							timeout: {
								type: "number",
								description:
									"Max time (ms) to wait for completion in blocking mode. If exceeded, returns with command still running.",
							},
						},
						required: ["sessionId", "command"],
					},
					execution: {
						taskSupport: "optional",
					},
				},
				{
					name: "cancel_pi_command",
					description:
						"Abort the currently running command in a session. Sends abort to the agent; force-terminates after 2s if it doesn't settle.",
					inputSchema: {
						type: "object",
						properties: {
							sessionId: {
								type: "string",
								description: "The ID of the session whose command to cancel.",
							},
						},
						required: ["sessionId"],
					},
				},
				{
					name: "terminate_pi_session",
					description:
						"Stop a session and remove it, freeing its id for reuse. Use this to clear a session that has crashed, wedged, or is no longer needed.",
					inputSchema: {
						type: "object",
						properties: {
							sessionId: {
								type: "string",
								description: "The ID of the session to terminate.",
							},
						},
						required: ["sessionId"],
					},
				},
				{
					name: "list_pi_sessions",
					description: "List all active sessions and their status.",
					inputSchema: {
						type: "object",
						properties: {},
					},
				},
				{
					name: "get_pending_actions",
					description:
						"Retrieve details of a tool call or action currently awaiting approval.",
					inputSchema: {
						type: "object",
						properties: {
							sessionId: {
								type: "string",
								description: "The target session ID.",
							},
						},
						required: ["sessionId"],
					},
				},
				{
					name: "approve_action",
					description: "Approve an intercepted tool execution.",
					inputSchema: {
						type: "object",
						properties: {
							sessionId: {
								type: "string",
								description: "The target session ID.",
							},
							actionId: {
								type: "string",
								description: "The ID of the intercepted tool call/action.",
							},
							summarize: {
								type: "boolean",
								description:
									"Deprecated and ignored: the full output is always returned, with a note.",
							},
						},
						required: ["sessionId", "actionId"],
					},
				},
				{
					name: "reject_action",
					description:
						"Deny an intercepted tool execution and feed feedback/refusal back to the agent.",
					inputSchema: {
						type: "object",
						properties: {
							sessionId: {
								type: "string",
								description: "The target session ID.",
							},
							actionId: {
								type: "string",
								description: "The ID of the intercepted tool call/action.",
							},
							reason: {
								type: "string",
								description:
									"Optional feedback or reason for rejection to guide the agent.",
							},
							summarize: {
								type: "boolean",
								description:
									"Deprecated and ignored: the full output is always returned, with a note.",
							},
						},
						required: ["sessionId", "actionId"],
					},
				},
				{
					name: "set_risk_policy",
					description:
						"Update the risk-based auto-approval policy for a session at runtime. Controls which actions are auto-approved based on risk level.",
					inputSchema: {
						type: "object",
						properties: {
							sessionId: {
								type: "string",
								description: "The target session ID.",
							},
							riskPolicy: {
								type: "object",
								description: "The new risk policy to apply.",
								properties: {
									autoApproveUpTo: {
										type: "number",
										description:
											"Risk level threshold for silent auto-approval (0=LOW, 1=MEDIUM, 2=HIGH, 3=CRITICAL).",
									},
									notifyUpTo: {
										type: "number",
										description:
											"Risk level threshold for auto-approval with notification.",
									},
									overrides: {
										type: "array",
										description: "Custom overrides.",
										items: {
											type: "object",
											properties: {
												pattern: {
													type: "string",
													description:
														"Glob pattern to match against command string or tool name.",
												},
												pathPattern: {
													type: "string",
													description:
														"Optional glob pattern to match against the target file path.",
												},
												action: {
													type: "string",
													enum: ["allow", "block"],
												},
												maxRiskLevel: {
													type: "number",
													description:
														"Only apply this override if the classified risk is at or below this level (0=LOW, 1=MEDIUM, 2=HIGH, 3=CRITICAL).",
												},
											},
											required: ["pattern", "action"],
										},
									},
								},
								required: ["autoApproveUpTo", "notifyUpTo"],
							},
						},
						required: ["sessionId", "riskPolicy"],
					},
				},
				{
					name: "get_auto_approved_log",
					description:
						"Retrieve the audit log of actions that were auto-approved by the risk policy. Useful for reviewing what the worker did without coordinator intervention.",
					inputSchema: {
						type: "object",
						properties: {
							sessionId: {
								type: "string",
								description: "The target session ID.",
							},
							pattern: {
								type: "string",
								description:
									"Optional filter: only return log entries whose matched override pattern equals this value.",
							},
						},
						required: ["sessionId"],
					},
				},
			],
		};
	});

	// Handle tool executions
	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const { name, arguments: args } = request.params;

		try {
			switch (name) {
				case "spawn_pi_session": {
					const { sessionId, cwd, model, systemPrompt, riskPolicy } = args as {
						sessionId: string;
						cwd: string;
						model?: string;
						systemPrompt?: string;
						riskPolicy?: RiskPolicy;
					};
					const session = await sessionManager.createSession(
						sessionId,
						cwd,
						model,
						systemPrompt,
						riskPolicy,
					);
					return {
						content: [
							{
								type: "text",
								text: `Successfully initialized and started session ${sessionId} in ${cwd} (Status: ${session.status})`,
							},
						],
					};
				}

				case "send_pi_command": {
					const { sessionId, command, summarize, timeout } = args as {
						sessionId: string;
						command: string;
						summarize?: boolean;
						timeout?: number;
					};
					const session = sessionManager.getSession(sessionId);

					// Only a task-augmented request gets a task. Clients that don't use
					// MCP tasks must get a normal tool result with the output.
					if (request.params.task) {
						// Start the command first: it throws when the session is busy, and
						// a task created beforehand would be orphaned and would replace
						// the live task's id.
						// Observe the outcome right away: it must never be an unhandled
						// rejection, even if the task isn't created yet when it settles.
						const outcome = session.sendCommand(command, summarize).then(
							(result) => ({ ok: true as const, result }),
							(err: unknown) => ({ ok: false as const, err }),
						);
						let task;
						try {
							task = await extra.taskStore!.createTask({
								ttl: extra.taskRequestedTtl ?? DEFAULT_TASK_TTL_MS,
								pollInterval: 5000,
							});
						} catch (err) {
							// Don't leave a run going that no task tracks.
							session.abortCommand();
							throw err;
						}
						const taskId = task.taskId;
						session.setActiveTaskId(taskId);

						void outcome.then(async (o) => {
							if (o.ok) {
								// A run that stops at an approval prompt is not finished: the
								// task stays input_required until it is approved or rejected.
								if (session.status === "AWAITING_APPROVAL") return;
								await taskSettler.settle(taskId, "completed", {
									content: [{ type: "text" as const, text: o.result }],
								});
							} else {
								await taskSettler.settle(taskId, "failed", {
									content: [
										{
											type: "text" as const,
											text:
												o.err instanceof Error ? o.err.message : String(o.err),
										},
									],
									isError: true,
								});
							}
						});

						return { task };
					}

					// Blocking path with optional timeout
					if (
						timeout !== undefined &&
						(typeof timeout !== "number" ||
							!Number.isFinite(timeout) ||
							timeout <= 0)
					) {
						throw new Error(
							"timeout must be a positive number of milliseconds",
						);
					}
					const effectiveTimeout =
						timeout ??
						sessionManager.config.limits.commandTimeoutMs ??
						undefined;

					if (effectiveTimeout != null) {
						const result = await Promise.race([
							session.sendCommand(command, summarize),
							new Promise<null>((resolve) =>
								setTimeout(() => resolve(null), effectiveTimeout),
							),
						]);

						if (result === null) {
							return {
								content: [
									{
										type: "text" as const,
										text: `RUNNING: Command is still executing after ${effectiveTimeout}ms timeout. Session status: ${session.status}. Use list_pi_sessions to check progress.`,
									},
								],
							};
						}

						return {
							content: [{ type: "text" as const, text: result }],
						};
					}

					// No timeout — block indefinitely (backward compatible)
					const result = await session.sendCommand(command, summarize);
					return {
						content: [{ type: "text" as const, text: result }],
					};
				}

				case "cancel_pi_command": {
					const { sessionId } = args as { sessionId: string };
					const session = sessionManager.getSession(sessionId);

					if (session.status !== "RUNNING") {
						return {
							content: [
								{
									type: "text",
									text: `Session ${sessionId} is not currently running a command (status: ${session.status}).`,
								},
							],
						};
					}

					const activeTaskId = session.getActiveTaskId();
					if (activeTaskId) {
						try {
							await taskStore.updateTaskStatus(
								activeTaskId,
								"cancelled",
								"Cancelled by coordinator",
							);
						} catch (err) {
							// The task may already be terminal or expired; still abort.
							console.error(
								`Could not cancel task ${activeTaskId}: ${err instanceof Error ? err.message : String(err)}`,
							);
						}
					}

					session.abortCommand();

					return {
						content: [
							{
								type: "text",
								text: `Abort signal sent to session ${sessionId}. The agent will attempt graceful shutdown.`,
							},
						],
					};
				}

				case "terminate_pi_session": {
					const { sessionId } = args as { sessionId: string };
					sessionManager.terminateSession(sessionId);
					return {
						content: [
							{
								type: "text",
								text: `Terminated session ${sessionId}. Its id is free to reuse.`,
							},
						],
					};
				}

				case "list_pi_sessions": {
					const list = sessionManager.listSessions();
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(list, null, 2),
							},
						],
					};
				}

				case "get_pending_actions": {
					const { sessionId } = args as { sessionId: string };
					const session = sessionManager.getSession(sessionId);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(session.pendingAction, null, 2),
							},
						],
					};
				}

				case "approve_action": {
					const { sessionId, actionId, summarize } = args as {
						sessionId: string;
						actionId: string;
						summarize?: boolean;
					};
					const session = sessionManager.getSession(sessionId);
					const result = await finishTaskAfter(session, () =>
						session.approveAction(actionId, summarize),
					);
					return {
						content: [
							{
								type: "text",
								text: result,
							},
						],
					};
				}

				case "reject_action": {
					const { sessionId, actionId, reason, summarize } = args as {
						sessionId: string;
						actionId: string;
						reason?: string;
						summarize?: boolean;
					};
					const session = sessionManager.getSession(sessionId);
					const result = await finishTaskAfter(session, () =>
						session.rejectAction(actionId, reason, summarize),
					);
					return {
						content: [
							{
								type: "text",
								text: result,
							},
						],
					};
				}

				case "set_risk_policy": {
					const { sessionId, riskPolicy } = args as {
						sessionId: string;
						riskPolicy: RiskPolicy;
					};
					sessionManager.setRiskPolicy(sessionId, riskPolicy);
					return {
						content: [
							{
								type: "text",
								text: `Risk policy updated for session ${sessionId}. Auto-approve up to: ${RiskLevel[riskPolicy.autoApproveUpTo] ?? riskPolicy.autoApproveUpTo}, Notify up to: ${RiskLevel[riskPolicy.notifyUpTo] ?? riskPolicy.notifyUpTo}, Overrides: ${riskPolicy.overrides?.length ?? 0}`,
							},
						],
					};
				}

				case "get_auto_approved_log": {
					const { sessionId, pattern } = args as {
						sessionId: string;
						pattern?: string;
					};
					const session = sessionManager.getSession(sessionId);
					let log = session.getAutoApprovedLog();
					if (pattern) {
						log = log.filter((entry) => entry.matchedOverride === pattern);
					}
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(log, null, 2),
							},
						],
					};
				}

				default:
					throw new Error(`Unknown tool: ${name}`);
			}
		} catch (error) {
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: error instanceof Error ? error.message : String(error),
					},
				],
			};
		}
	});

	// List available resources
	server.setRequestHandler(ListResourcesRequestSchema, async () => {
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
	server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
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
	});

	return server;
}
