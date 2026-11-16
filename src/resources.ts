import {
	type McpServer,
	ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Run } from "./core/run.js";
import { ToolError } from "./errors.js";
import { wrapTree, wrapUntrusted } from "./render.js";
import type { SessionManager } from "./session/session-manager.js";
import { gateEntries } from "./tools.js";

const MAX_LOG_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_BYTES = 1024 * 1024;

const one = (v: string | string[]): string => (Array.isArray(v) ? v[0] : v);

/** Keep the end of `s` when it is longer than `max`. */
function tail(s: string, max: number): string {
	return s.length > max ? `[earlier text left out]\n${s.slice(-max)}` : s;
}

function renderTranscript(run: Run): string {
	const lines = run.activity.map((a) => a.text);
	const out = [
		`# Run ${run.id}`,
		"",
		`- worker: ${run.workerId}`,
		`- state: ${run.state}`,
		...(run.intent === undefined ? [] : [`- intent: ${run.intent}`]),
		"",
		"## Tool calls",
		"",
		lines.length > 0
			? wrapUntrusted(run.id, lines.join("\n"))
			: "None recorded.",
		"",
		"## Output",
		"",
		run.output.total > 0 ? wrapUntrusted(run.id, run.output.all) : "No output.",
	].join("\n");
	return tail(out, MAX_TRANSCRIPT_BYTES);
}

/**
 * Resources are for people and for debugging, not for the model: the
 * tools return the same data. Everything a worker wrote is wrapped as
 * untrusted. `list_changed` goes out when workers come and go.
 */
export function registerResources(
	server: McpServer,
	manager: SessionManager,
): void {
	const store = manager.runs;

	const workerLog = (ref: string) => {
		const session = manager.getSession(ref);
		return wrapUntrusted(
			session.sessionId,
			tail(session.logs.join("\n"), MAX_LOG_BYTES),
			"worker",
		);
	};

	server.registerResource(
		"worker-log",
		new ResourceTemplate("worker-mcp://workers/{workerId}/log", {
			list: () => ({
				resources: manager.allSessions().map((s) => ({
					uri: `worker-mcp://workers/${s.sessionId}/log`,
					name: `Worker ${s.sessionId} log`,
					mimeType: "text/plain",
				})),
			}),
		}),
		{
			title: "Worker log",
			description:
				"The server's log of one worker (its metadata and stderr). Untrusted text.",
			mimeType: "text/plain",
		},
		async (uri, vars) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: "text/plain",
					text: workerLog(one(vars.workerId)),
				},
			],
		}),
	);

	server.registerResource(
		"run-transcript",
		new ResourceTemplate("worker-mcp://runs/{runId}/transcript", {
			list: () => ({
				resources: store.all().map((r) => ({
					uri: `worker-mcp://runs/${r.id}/transcript`,
					name: `Run ${r.id} transcript`,
					mimeType: "text/markdown",
				})),
			}),
		}),
		{
			title: "Run transcript",
			description:
				"A run's tool calls and output as Markdown. Untrusted worker text.",
			mimeType: "text/markdown",
		},
		async (uri, vars) => {
			const run = store.get(one(vars.runId));
			if (!run) {
				const id = one(vars.runId);
				throw new ToolError(
					"RUN_NOT_FOUND",
					manager.missingId("run", id) ??
						`No run ${id}; its result has expired or the id never existed.`,
				);
			}
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: "text/markdown",
						text: renderTranscript(run),
					},
				],
			};
		},
	);

	server.registerResource(
		"gate-log",
		new ResourceTemplate("worker-mcp://gate/{workerId}", {
			list: () => ({
				resources: manager.allSessions().map((s) => ({
					uri: `worker-mcp://gate/${s.sessionId}`,
					name: `Worker ${s.sessionId} gate log`,
					mimeType: "application/json",
				})),
			}),
		}),
		{
			title: "Gate log",
			description:
				"What the approval gate decided for one worker, as JSON. Previews are untrusted worker text.",
			mimeType: "application/json",
		},
		async (uri, vars) => {
			const session = manager.getSession(one(vars.workerId));
			const entries = wrapTree(
				gateEntries(session, { limit: 500 }),
				session.sessionId,
				"worker",
			);
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: "application/json",
						text: JSON.stringify(entries, null, 2),
					},
				],
			};
		},
	);

	manager.onWorkersChanged(() => server.sendResourceListChanged());
}
