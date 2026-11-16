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
//   late-settled:<ms>[ <text>]  reply like echo, then send agent_settled <ms> later
//   recall                      reply with the user messages of the restored session
//   crash-mid-run               exit 1 after the first delta
//   crash-noisy                 print npm and runtime warnings and one real error to
//                               stderr (plus noise after it), then exit 1 mid-run
//   ignore-sigterm              ignore SIGTERM and stay running until aborted
//   ignore-abort                keep streaming and ignore the abort command
//   grandchild                  start a detached `sleep` in its own group
//   stdin-close                 close own stdin, then reply
//   big-output:<bytes>          reply with <bytes> characters of text
//   markdown-rules              reply with horizontal rules and table separators
//   mutate:<name>:<json>        like tool:, but reports the input the call ran with
//                               after the gate (which may have rewritten it)
//   parallel-tools:<name>:<json>  two calls through the gate before either is
//                               answered (the input gets "n": 1 and "n": 2)
//   bash:<command>              like pi's bash tool: propose it through the gate,
//                               run what comes back (the gate may have wrapped
//                               it) with bash, report exit code and output
//   read:<path>                 like pi's read tool: propose it, then read the
//                               file in this process and report its content
//   race:<json>                 a batch like pi's: [{"tool":"read"|"bash","input":{}},...]
//                               pi rates every call first and then runs them
//                               at once, unless a tool was registered with
//                               executionMode "sequential" (then one at a time,
//                               rated just before it runs); FAKE_PI_PARALLEL=1
//                               ignores that. A read takes 400 ms, like I/O.
//   sequence:<json>             [{"tool":"bash","input":{}},...] one call after the other
//                               through the gate, then one reply that lists each outcome
//   dialog:<method>             send a non-gate select/input/editor/confirm and
//                               report how it was answered
// Startup scenarios, chosen with FAKE_PI_SCENARIO (they act before any prompt):
//   no-gate-handshake           never send the gate's ready status
//   gate-error                  report an extension_error for the gate file
//   exit-at-start               exit 1 at once, as pi does for a bad -e path
// Sessions: `--session-dir <dir>` (and `--session-id <id>`) make fake-pi keep a
// pi-shaped session file (format version 3), with pi's timing: nothing is
// written before the first user message, then everything so far at once; one
// append per entry at message end; an assistant message holding a tool call is
// on disk before the gate is asked; the tool result only when the tool ends.
// The file is `<timestamp>_<id>.jsonl`; an existing one is found by id and cwd
// and its context restored (scenario `recall` replies with the user messages
// of the active branch). Without these flags nothing is written, as today.
// FAKE_PI_SESSION_KILL=after-user|after-tool-call|after-gate SIGKILLs the
// process at that point of a run (after-user: user message written;
// after-tool-call: assistant tool call written, gate not asked; after-gate:
// gate answered, tool not finished).
// FAKE_PI_USAGE=<n> makes assistant messages carry usage with n input tokens.
// After loading the extensions fake-pi fires `session_start` the way pi does,
// so a gate that reports readiness from that hook is seen on the wire.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { register } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import {
	agentEnd,
	editorRequest,
	extensionError,
	inputRequest,
	selectRequest,
	setStatusRequest,
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
if (argv.includes("--version")) {
	console.log("fake-pi 0.0.0");
	process.exit(0);
}
record({
	kind: "start",
	pid: process.pid,
	ppid: process.ppid,
	argv,
	env: { ...process.env },
	cwd: process.cwd(),
});
// Like pi after it has read its credentials: they stay in this process's
// environment (visible in /proc/<pid>/environ) but not in its children's.
delete process.env.FAKE_PI_CRED;

// ---- session file ----------------------------------------------------------
const argValue = (flag) => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};
const sessionDir = argValue("--session-dir");
const session = sessionDir
	? {
			dir: path.resolve(sessionDir),
			id: argValue("--session-id") ?? randomUUID(),
			file: null, // set when the file exists
			leaf: null,
			entries: new Map(),
		}
	: null;
const entryId = () => randomUUID().slice(0, 8);
const kill = (point) => {
	if (process.env.FAKE_PI_SESSION_KILL === point) {
		process.kill(process.pid, "SIGKILL");
	}
};

/** Like pi: look the file up by id and cwd; skip lines that do not parse. */
function loadSession() {
	let names = [];
	try {
		names = readdirSync(session.dir).filter((n) => n.endsWith(".jsonl"));
	} catch {}
	for (const name of names.toSorted()) {
		const file = path.join(session.dir, name);
		let lines;
		try {
			lines = readFileSync(file, "utf8").split("\n");
		} catch {
			continue;
		}
		let header;
		try {
			header = JSON.parse(lines[0]);
		} catch {
			continue;
		}
		if (header?.type !== "session" || header.id !== session.id) continue;
		if (header.cwd !== process.cwd()) continue;
		for (const line of lines.slice(1)) {
			try {
				const e = JSON.parse(line);
				if (typeof e?.id !== "string") continue;
				session.entries.set(e.id, e);
				session.leaf = e.id;
			} catch {}
		}
		session.file = file;
		return;
	}
}

/** The active branch, oldest first: the leaf's parent chain. */
function sessionBranch() {
	const chain = [];
	let e = session.entries.get(session.leaf);
	while (e && !chain.includes(e)) {
		chain.push(e);
		e = session.entries.get(e.parentId);
	}
	return chain.toReversed();
}

function appendEntry(type, fields) {
	const entry = {
		type,
		id: entryId(),
		parentId: session.leaf,
		timestamp: new Date().toISOString(),
		...fields,
	};
	session.entries.set(entry.id, entry);
	session.leaf = entry.id;
	return entry;
}

const sessionMessage = (message) => ({
	message: { ...message, timestamp: Date.now() },
});

/** Append one entry; the first one creates the file with the setup entries. */
function writeMessage(message) {
	if (!session) return;
	const fresh = !session.file;
	const lines = [];
	if (fresh) {
		const now = new Date();
		const header = {
			type: "session",
			version: 3,
			id: session.id,
			timestamp: now.toISOString(),
			cwd: process.cwd(),
		};
		session.file = path.join(
			session.dir,
			`${now.toISOString().replace(/[:.]/g, "-")}_${session.id}.jsonl`,
		);
		lines.push(header);
		lines.push(
			appendEntry("model_change", { provider: "fake", modelId: "fake-model" }),
			appendEntry("thinking_level_change", { thinkingLevel: "high" }),
			appendEntry(
				"message",
				sessionMessage({
					role: "system",
					content: [{ type: "text", text: "" }],
				}),
			),
		);
	}
	// FAKE_PI_USAGE=<tokens>: assistant messages report that many input tokens,
	// like real pi's `usage`. Without it they carry none (a session with no usage).
	if (message.role === "assistant" && process.env.FAKE_PI_USAGE) {
		const tokens = Number(process.env.FAKE_PI_USAGE);
		message = {
			...message,
			usage: {
				input: tokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: tokens,
			},
		};
	}
	lines.push(appendEntry("message", sessionMessage(message)));
	const data = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
	if (fresh) writeFileSync(session.file, data, { flag: "wx" });
	else appendFileSync(session.file, data);
}

if (session) {
	loadSession();
	record({
		kind: "session",
		id: session.id,
		resumed: session.file !== null,
		messages: session.file ? sessionBranch().length : 0,
	});
}

const textOf = (content) =>
	(Array.isArray(content) ? content : [])
		.map((c) => (c?.type === "text" ? c.text : ""))
		.join("");

/** The assistant message with a tool call; on disk before the gate is asked. */
function sessionToolCall(name, input) {
	const callId = `call_${entryId()}`;
	writeMessage({
		role: "assistant",
		stopReason: "toolUse",
		content: [{ type: "toolCall", id: callId, name, arguments: input }],
	});
	kill("after-tool-call");
	return callId;
}

function sessionToolResult(callId, name, text, isError = false) {
	writeMessage({
		role: "toolResult",
		toolCallId: callId,
		toolName: name,
		content: [{ type: "text", text }],
		isError,
	});
}

// ---- gate extensions -------------------------------------------------------
const extensionPaths = [];
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--extension" || argv[i] === "-e") {
		extensionPaths.push(argv[++i]);
	}
}

// The gate imports pi's tool definitions from pi's package: point that at a stub.
register(
	`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
		if (specifier === "@earendil-works/pi-coding-agent") {
			return { url: ${JSON.stringify(new URL("./pi-package-stub.mjs", import.meta.url).href)}, shortCircuit: true };
		}
		return next(specifier, context);
	}`)}`,
	import.meta.url,
);

const registeredTools = new Map();
const handlers = new Map();
const pi = {
	getActiveTools: () => ["read", "bash", "edit", "write"],
	registerTool(tool) {
		registeredTools.set(tool.name, tool);
	},
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
		// Resolves the entered string, or undefined when cancelled, like pi.
		input: async (title, placeholder) => {
			const reply = await dialog(
				inputRequest(randomUUID(), title, placeholder),
			);
			return reply.cancelled ? undefined : reply.value;
		},
		notify: () => {},
		setStatus: (key, text) => send(setStatusRequest(randomUUID(), key, text)),
	},
};

const startup = process.env.FAKE_PI_SCENARIO;
if (startup === "exit-at-start") {
	process.stderr.write("Error: Failed to load extension\n");
	process.exit(1);
}
for (const extensionPath of extensionPaths) {
	const mod = await import(pathToFileURL(extensionPath).href);
	await mod.default(pi);
}
if (startup === "gate-error") {
	send(extensionError(extensionPaths[0], "tool_call", "gate crashed"));
}
// pi starts the session after loading extensions: session_start fires then.
if (startup !== "no-gate-handshake") {
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ type: "session_start", reason: "startup" }, ctx);
	}
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
	// A handler may rewrite event.input in place.
	return { blocked: false, input: event.input };
}

// ---- run state -------------------------------------------------------------
let run = null; // { timer, finish }
let ignoreAbort = false;

function finishRun(text, { settled = true } = {}) {
	if (!run) return;
	clearInterval(run.timer);
	run = null;
	if (text !== undefined) {
		writeMessage({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text }],
		});
		send(messageEnd(text));
	}
	send(turnEnd());
	send(agentEnd());
	// Real pi follows agent_end with agent_settled; a run is over at that event.
	if (settled) send(agentSettled());
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
	// A resumed worker's first prompt has the server's note in front of the
	// task, separated by a blank line: the scenario is then after that.
	const at = message.startsWith("scenario:")
		? 0
		: message.startsWith("[worker-mcp] ")
			? message.indexOf("\n\nscenario:") + 2
			: -1;
	const prefixed = at >= 2 || message.startsWith("scenario:");
	const spec = prefixed
		? message.slice(Math.max(at, 0) + "scenario:".length)
		: (process.env.FAKE_PI_SCENARIO ?? "echo");
	return { spec, text: message, prefixed };
}

async function startPrompt(message) {
	const { spec, text, prefixed } = parseScenario(message);
	if (spec === "ignore-sigterm") process.on("SIGTERM", () => {});
	if (spec === "ignore-abort") ignoreAbort = true;
	record({ kind: "run", spec });
	writeMessage({ role: "user", content: [{ type: "text", text: message }] });
	kill("after-user");
	send(agentStart());
	send(turnStart());

	let m;
	if ((m = spec.match(/^tool:([^:]+):([\s\S]*)$/))) {
		const [, toolName, json] = m;
		const input = JSON.parse(json);
		run = { timer: null };
		const callId = sessionToolCall(toolName, input);
		const result = await gate(toolName, input);
		if (!run) return; // aborted while waiting for the gate
		if (result.blocked) {
			if (session) sessionToolResult(callId, toolName, result.reason, true);
			finishRun(`tool ${toolName} blocked: ${result.reason}`);
			return;
		}
		kill("after-gate");
		const toolCallId = randomUUID();
		send(toolExecutionStart(toolCallId, toolName, input));
		send(toolExecutionEnd(toolCallId, toolName));
		if (session) sessionToolResult(callId, toolName, "");
		finishRun(`tool ${toolName} ran with ${json}`);
	} else if ((m = spec.match(/^mutate:([^:]+):([\s\S]*)$/))) {
		const [, toolName, json] = m;
		run = { timer: null };
		const callId = sessionToolCall(toolName, JSON.parse(json));
		const result = await gate(toolName, JSON.parse(json));
		if (!run) return;
		if (result.blocked) {
			if (session) sessionToolResult(callId, toolName, result.reason, true);
			finishRun(`tool ${toolName} blocked: ${result.reason}`);
			return;
		}
		kill("after-gate");
		const toolCallId = randomUUID();
		send(toolExecutionStart(toolCallId, toolName, result.input));
		send(toolExecutionEnd(toolCallId, toolName));
		if (session) sessionToolResult(callId, toolName, "");
		finishRun(`tool ${toolName} ran with ${JSON.stringify(result.input)}`);
	} else if ((m = spec.match(/^bash:([\s\S]+)$/))) {
		run = { timer: null };
		const callId = sessionToolCall("bash", { command: m[1] });
		const result = await gate("bash", { command: m[1] });
		if (!run) return;
		if (result.blocked) {
			if (session) sessionToolResult(callId, "bash", result.reason, true);
			finishRun(`blocked: ${result.reason}`);
			return;
		}
		kill("after-gate");
		const r = spawnSync("bash", ["-c", result.input.command], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (session) {
			sessionToolResult(
				callId,
				"bash",
				`${r.stdout}${r.stderr}`,
				r.status !== 0,
			);
		}
		finishRun(`exit=${r.status}\n${r.stdout}${r.stderr}`);
	} else if ((m = spec.match(/^race:([\s\S]+)$/))) {
		run = { timer: null };
		const calls = JSON.parse(m[1]);
		const sequential =
			!process.env.FAKE_PI_PARALLEL &&
			calls.some(
				(c) => registeredTools.get(c.tool)?.executionMode === "sequential",
			);
		// oxlint-disable-next-line unicorn/consistent-function-scoping -- kept next to its use
		const exec = async (c) => {
			if (c.tool === "read") {
				await new Promise((r) => setTimeout(r, 400));
				try {
					return `content=${readFileSync(c.input.path, "utf8")}`;
				} catch (e) {
					return `error=${e.code}`;
				}
			}
			const out = [];
			await new Promise((resolve) => {
				const child = spawn("bash", ["-c", c.input.command], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				child.stdout.on("data", (d) => out.push(d));
				child.stderr.on("data", (d) => out.push(d));
				child.on("close", resolve);
			});
			return `exit-ok\n${Buffer.concat(out)}`;
		};
		const results = [];
		if (sequential) {
			for (const c of calls) {
				const r = await gate(c.tool, c.input);
				if (!run) return;
				results.push(
					r.blocked
						? `blocked: ${r.reason}`
						: await exec({ ...c, input: r.input }),
				);
			}
		} else {
			// Every call is rated before any of them runs.
			const rated = [];
			for (const c of calls) {
				const r = await gate(c.tool, c.input);
				if (!run) return;
				rated.push(
					r.blocked ? { blocked: r.reason } : { ...c, input: r.input },
				);
			}
			results.push(
				...(await Promise.all(
					rated.map((c) => (c.blocked ? `blocked: ${c.blocked}` : exec(c))),
				)),
			);
		}
		finishRun(results.join("\n---\n"));
	} else if ((m = spec.match(/^read:([\s\S]+)$/))) {
		run = { timer: null };
		const result = await gate("read", { path: m[1] });
		if (!run) return;
		if (result.blocked) {
			finishRun(`blocked: ${result.reason}`);
			return;
		}
		try {
			finishRun(`content=${readFileSync(m[1], "utf8")}`);
		} catch (e) {
			finishRun(`error=${e.code}`);
		}
	} else if ((m = spec.match(/^sequence:([\s\S]+)$/))) {
		const calls = JSON.parse(m[1]);
		run = { timer: null };
		const outcomes = [];
		for (const { tool, input } of calls) {
			const result = await gate(tool, input);
			if (!run) return;
			if (result.blocked) {
				outcomes.push(`${tool} blocked`);
				continue;
			}
			const toolCallId = randomUUID();
			send(toolExecutionStart(toolCallId, tool, input));
			send(toolExecutionEnd(toolCallId, tool));
			outcomes.push(`${tool} ran`);
		}
		finishRun(outcomes.join(", "));
	} else if ((m = spec.match(/^parallel-tools:([^:]+):([\s\S]*)$/))) {
		const [, toolName, json] = m;
		const base = JSON.parse(json);
		run = { timer: null };
		// Both go out before either is answered.
		const results = await Promise.all(
			[1, 2].map(async (n) => {
				const input = { ...base, n };
				const result = await gate(toolName, input);
				return result.blocked
					? `${n}: blocked: ${result.reason}`
					: `${n}: ran with ${JSON.stringify(result.input)}`;
			}),
		);
		if (!run) return;
		finishRun(results.join(" | "));
	} else if ((m = spec.match(/^dialog:(select|input|editor|confirm)$/))) {
		run = { timer: null };
		const id = randomUUID();
		const request = {
			select: selectRequest(id, "pick one", ["a", "b"]),
			input: inputRequest(id, "a question", "type here"),
			editor: editorRequest(id, "edit", "text"),
			confirm: confirmRequest(id, "sure?", "really"),
		}[m[1]];
		const answer = await dialog(request);
		if (!run) return;
		finishRun(`dialog ${m[1]} ${answer.cancelled ? "cancelled" : "answered"}`);
	} else if ((m = spec.match(/^slow:(\d+)(?: ([\s\S]*))?$/))) {
		run = { timer: null };
		streamFor(Number(m[1]), reply(m[2] ?? "slow done"));
	} else if ((m = spec.match(/^late-settled:(\d+)(?: ([\s\S]*))?$/))) {
		// pi's agent_settled can trail agent_end; it may land inside the next run.
		run = { timer: null };
		finishRun(reply(m[2] ?? "late"), { settled: false });
		setTimeout(() => send(agentSettled()), Number(m[1]));
	} else if (spec === "recall") {
		// The user messages the restored context holds (needs a session).
		run = { timer: null };
		const said = session
			? sessionBranch()
					.filter((e) => e.type === "message" && e.message?.role === "user")
					.slice(0, -1)
					.map((e) => textOf(e.message.content))
			: [];
		finishRun(`recalled: ${JSON.stringify(said)}`);
	} else if (spec === "crash-mid-run") {
		run = { timer: null };
		streamFor(60_000, "unreachable", { crashAfterFirst: true });
	} else if (spec === "crash-noisy") {
		run = { timer: null };
		process.stderr.write("fatal: could not open the session file\n");
		process.stderr.write("npm warn exec The following package was not found\n");
		process.stderr.write(
			"(node:123) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.\n",
		);
		process.stderr.write(
			"(Use `node --trace-deprecation ...` to show where)\n",
		);
		streamFor(60_000, "unreachable", { crashAfterFirst: true });
	} else if (spec === "ignore-sigterm" || spec === "ignore-abort") {
		run = { timer: null };
		streamFor(600_000, "unreachable");
	} else if ((m = spec.match(/^exec:([\s\S]+)$/))) {
		// Runs a shell command with no gate in between: what a worker that got
		// around the gate could do. Reports its exit code and output.
		run = { timer: null };
		const r = spawnSync("sh", ["-c", m[1]], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		finishRun(`exit=${r.status}\n${r.stdout}${r.stderr}`);
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
		record({
			kind: "recv",
			type: msg.type,
			...(msg.type === "set_model"
				? { provider: msg.provider, modelId: msg.modelId }
				: {}),
		});
		if (msg.type === "prompt") {
			send(response(msg.id, "prompt"));
			void startPrompt(msg.message);
		} else if (msg.type === "abort") {
			send(response(msg.id, "abort"));
			if (!ignoreAbort) finishRun();
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
