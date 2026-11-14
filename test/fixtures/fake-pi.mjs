#!/usr/bin/env node
// Stand-in for `pi --mode rpc`, used as WORKER_MCP_PI_PATH in tests.
// Dependency-free. Message shapes live in ./pi-protocol.mjs.
//
// Recording: when FAKE_PI_RECORD names a file, JSON lines are appended to it:
//   {"kind":"start","pid","ppid","argv","env","cwd"}   once per process
//   {"kind":"recv","type"}                              per command received
//   {"kind":"run","spec"}                               a scenario started
//   {"kind":"grandchild","pid"}                         from `grandchild`
//
// The gate: every `--extension <file>` is imported for real and its default
// export is called with a minimal `pi` API. A proposed tool call is passed to
// the extension's `tool_call` handlers, and the handler's `ctx.ui.confirm` goes
// out as an RPC `extension_ui_request`, exactly as pi does. Only the pi API
// surface is faked (`on`, `ctx.ui.*`); the gate source itself runs unmodified.
// (Loading a `.ts` gate relies on Node's built-in type stripping, Node >= 22.18.)
//
// Scenarios: a prompt starting with `scenario:<spec>` selects one, otherwise
// the FAKE_PI_SCENARIO env var does, otherwise `echo`.
//   echo[ <text>]               reply `fake-pi reply: <text>`
//   slow:<ms>[ <text>]          stream deltas for <ms>, then reply; abort ends it
//   tool:<name>:<json>          propose a tool call through the gate, report result
//   crash-mid-run               exit 1 after the first delta
//   ignore-sigterm              ignore SIGTERM and stay running until aborted
//   grandchild                  start a detached `sleep` in its own group
//   stdin-close                 close own stdin, then reply
//   big-output:<bytes>          reply with <bytes> characters of text
//   markdown-rules              reply with horizontal rules and table separators
// Scenarios for later phases (mutate, parallel-tools, dialog:*,
// no-gate-handshake, gate-error) are not implemented yet.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
	agentEnd,
	agentSettled,
	agentStart,
	confirmRequest,
	createLineSplitter,
	messageEnd,
	messageUpdate,
	response,
	toolExecutionEnd,
	toolExecutionStart,
	turnEnd,
	turnStart,
} from "./pi-protocol.mjs";

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const record = (obj) => {
	if (process.env.FAKE_PI_RECORD) {
		appendFileSync(process.env.FAKE_PI_RECORD, `${JSON.stringify(obj)}\n`);
	}
};

const argv = process.argv.slice(2);
record({
	kind: "start",
	pid: process.pid,
	ppid: process.ppid,
	argv,
	env: { ...process.env },
	cwd: process.cwd(),
});

// ---- gate extensions -------------------------------------------------------
const extensionPaths = [];
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--extension" || argv[i] === "-e") {
		extensionPaths.push(argv[++i]);
	}
}

const handlers = new Map();
const pi = {
	on(event, handler) {
		if (!handlers.has(event)) handlers.set(event, []);
		handlers.get(event).push(handler);
	},
};

const pendingDialogs = new Map();
function dialog(request) {
	return new Promise((resolve) => {
		pendingDialogs.set(request.id, resolve);
		send(request);
	});
}
const ctx = {
	hasUI: true,
	mode: "rpc",
	cwd: process.cwd(),
	ui: {
		// Resolves true only for an explicit confirmation, like pi.
		confirm: async (title, message) => {
			const reply = await dialog(confirmRequest(randomUUID(), title, message));
			return reply.cancelled ? false : reply.confirmed === true;
		},
		notify: () => {},
		setStatus: () => {},
	},
};

for (const extensionPath of extensionPaths) {
	const mod = await import(pathToFileURL(extensionPath).href);
	await mod.default(pi);
}

/** Run the tool_call handlers; resolves to `{ blocked, reason }`. */
async function gate(toolName, input) {
	const event = {
		type: "tool_call",
		toolCallId: randomUUID(),
		toolName,
		input,
	};
	for (const handler of handlers.get("tool_call") ?? []) {
		const result = await handler(event, ctx);
		if (result?.block) return { blocked: true, reason: result.reason };
	}
	return { blocked: false };
}

// ---- run state -------------------------------------------------------------
let run = null; // { timer, finish }

function finishRun(text) {
	if (!run) return;
	clearInterval(run.timer);
	run = null;
	if (text !== undefined) send(messageEnd(text));
	send(turnEnd());
	send(agentEnd());
	// Real pi follows agent_end with agent_settled. It is off by default: today's
	// server settles a run on either event, so a trailing agent_settled can end
	// the next run early. A later phase that consumes it sets FAKE_PI_SETTLED=1.
	if (process.env.FAKE_PI_SETTLED === "1") send(agentSettled());
}

function streamFor(ms, text, { crashAfterFirst = false } = {}) {
	let i = 0;
	const started = Date.now();
	run.timer = setInterval(() => {
		// Distinct tokens, so the server's repetition detector stays quiet.
		send(messageUpdate(`w${i++} `));
		if (crashAfterFirst) process.exit(1);
		if (Date.now() - started >= ms) finishRun(text);
	}, 25);
}

const reply = (text) => `fake-pi reply: ${text}`;

function parseScenario(message) {
	const prefixed = message.startsWith("scenario:");
	const spec = prefixed
		? message.slice("scenario:".length)
		: (process.env.FAKE_PI_SCENARIO ?? "echo");
	return { spec, text: message, prefixed };
}

async function startPrompt(message) {
	const { spec, text, prefixed } = parseScenario(message);
	if (spec === "ignore-sigterm") process.on("SIGTERM", () => {});
	record({ kind: "run", spec });
	send(agentStart());
	send(turnStart());

	let m;
	if ((m = spec.match(/^tool:([^:]+):([\s\S]*)$/))) {
		const [, toolName, json] = m;
		const input = JSON.parse(json);
		run = { timer: null };
		const result = await gate(toolName, input);
		if (!run) return; // aborted while waiting for the gate
		if (result.blocked) {
			finishRun(`tool ${toolName} blocked: ${result.reason}`);
			return;
		}
		const toolCallId = randomUUID();
		send(toolExecutionStart(toolCallId, toolName, input));
		send(toolExecutionEnd(toolCallId, toolName));
		finishRun(`tool ${toolName} ran with ${json}`);
	} else if ((m = spec.match(/^slow:(\d+)(?: ([\s\S]*))?$/))) {
		run = { timer: null };
		streamFor(Number(m[1]), reply(m[2] ?? "slow done"));
	} else if (spec === "crash-mid-run") {
		run = { timer: null };
		streamFor(60_000, "unreachable", { crashAfterFirst: true });
	} else if (spec === "ignore-sigterm") {
		run = { timer: null };
		streamFor(600_000, "unreachable");
	} else if (spec === "grandchild") {
		// Like pi's bash tool: a child in its own process group.
		const child = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
		child.unref();
		record({ kind: "grandchild", pid: child.pid });
		run = { timer: null };
		finishRun(`grandchild pid: ${child.pid}`);
	} else if (spec === "stdin-close") {
		run = { timer: null };
		finishRun(reply("closing stdin"));
		process.stdin.destroy();
		// Nothing can reach this process any more; stay up until killed.
		setInterval(() => {}, 60_000);
	} else if ((m = spec.match(/^big-output:(\d+)$/))) {
		const size = Number(m[1]);
		const unit = "0123456789abcdefghijklmnopqrstuvwxyz\n";
		run = { timer: null };
		finishRun(unit.repeat(Math.ceil(size / unit.length)).slice(0, size));
	} else if (spec === "markdown-rules") {
		run = { timer: null };
		finishRun(
			[
				"Title",
				"----",
				"",
				"| a | b |",
				"|---|---|",
				"| 1 | 2 |",
				"",
				"----",
			].join("\n"),
		);
	} else {
		// echo[ <text>], or an unprefixed prompt
		const echo = spec.match(/^echo(?: ([\s\S]*))?$/);
		run = { timer: null };
		finishRun(reply(echo && prefixed ? (echo[1] ?? "") : text));
	}
}

// ---- RPC loop ----------------------------------------------------------------
process.stdin.setEncoding("utf8");
process.stdin.on(
	"data",
	createLineSplitter((line) => {
		const msg = JSON.parse(line);
		record({ kind: "recv", type: msg.type });
		if (msg.type === "prompt") {
			send(response(msg.id, "prompt"));
			void startPrompt(msg.message);
		} else if (msg.type === "abort") {
			send(response(msg.id, "abort"));
			finishRun();
		} else if (msg.type === "set_model") {
			send(response(msg.id, "set_model"));
		} else if (msg.type === "extension_ui_response") {
			const resolve = pendingDialogs.get(msg.id);
			pendingDialogs.delete(msg.id);
			resolve?.(msg);
		}
	}),
);
process.stdin.on("end", () => process.exit(0));
