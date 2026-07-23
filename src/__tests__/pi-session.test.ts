/* biome-ignore-all lint/suspicious/noExplicitAny: testing private methods */
import assert from "node:assert";
import { describe, test } from "node:test";
import { PiSession } from "../session/pi-session.js";
import { RiskLevel } from "../session/risk-classifier.js";

describe("PiSession - Unit Tests", () => {
	test("detectLoop - Normal text should not trigger loop detection", () => {
		const session = new PiSession("test", "./scratch");
		const detectLoop = (session as any).detectLoop.bind(session);

		assert.strictEqual(detectLoop("Hello world! How are you today?"), false);
		assert.strictEqual(
			detectLoop(
				"This is a long line of code that explains the requirements and has no repetitive sequences.",
			),
			false,
		);
	});

	test("detectLoop - Repeated short patterns should be blocked", () => {
		const session = new PiSession("test", "./scratch");
		const detectLoop = (session as any).detectLoop.bind(session);

		// Single character repeats (require >= 20)
		assert.strictEqual(detectLoop("\n".repeat(19)), false);
		assert.strictEqual(detectLoop("\n".repeat(20)), true);

		// Double character repeats (require >= 10)
		assert.strictEqual(detectLoop("ab".repeat(9)), false);
		assert.strictEqual(detectLoop("ab".repeat(10)), true);

		// 3-character repeats (require >= 8)
		assert.strictEqual(detectLoop("abc".repeat(7)), false);
		assert.strictEqual(detectLoop("abc".repeat(8)), true);

		// 4+ character repeats (require >= 5)
		assert.strictEqual(detectLoop("hello ".repeat(4)), false);
		assert.strictEqual(detectLoop("hello ".repeat(5)), true);
	});

	test("detectLoop - Safeguard character limit should trigger", () => {
		const session = new PiSession("test", "./scratch");
		const detectLoop = (session as any).detectLoop.bind(session);

		const limit = process.env.WORKER_MCP_MAX_OUTPUT_CHARS
			? Number.parseInt(process.env.WORKER_MCP_MAX_OUTPUT_CHARS, 10)
			: 64000;

		let longNonRepeating = "";
		for (let i = 0; i < Math.ceil(limit / 5) + 1000; i++) {
			longNonRepeating += `w${i} `;
		}

		assert.strictEqual(
			detectLoop(longNonRepeating.substring(0, limit - 1)),
			false,
		);
		assert.strictEqual(
			detectLoop(longNonRepeating.substring(0, limit + 1)),
			true,
		);
	});

	test("Buffer splitting - splits stdout chunks by newline", () => {
		const session = new PiSession("test", "./scratch");

		const parsedLines: string[] = [];
		(session as any).handleStdoutLine = (line: string) => {
			parsedLines.push(line);
		};

		const stdoutBufferReceiver = (chunk: Buffer) => {
			(session as any).stdoutBuffer += chunk.toString("utf8");
			let boundary = (session as any).stdoutBuffer.indexOf("\n");
			while (boundary !== -1) {
				const line = (session as any).stdoutBuffer
					.substring(0, boundary)
					.trim();
				(session as any).stdoutBuffer = (session as any).stdoutBuffer.substring(
					boundary + 1,
				);
				if (line) {
					(session as any).handleStdoutLine(line);
				}
				boundary = (session as any).stdoutBuffer.indexOf("\n");
			}
		};

		stdoutBufferReceiver(
			Buffer.from('{"type":"turn_start"}\n{"type":"message'),
		);
		assert.deepStrictEqual(parsedLines, ['{"type":"turn_start"}']);

		stdoutBufferReceiver(Buffer.from('_update","text":"Hello"}\n'));
		assert.deepStrictEqual(parsedLines, [
			'{"type":"turn_start"}',
			'{"type":"message_update","text":"Hello"}',
		]);
	});

	test("message_update snapshots are not retained", () => {
		const session = new PiSession("test", "./scratch");
		const h = (session as any).handleStdoutLine.bind(session);

		// Each snapshot carries the whole message so far, so retention is O(n^2).
		for (let i = 0; i < 50; i++) {
			h(
				JSON.stringify({
					type: "message_update",
					message: "x".repeat(i * 100),
				}),
			);
		}
		h('{"type":"message_end","message":{"role":"assistant"}}');

		const kinds = session.history.map((e: any) => e.type);
		assert.strictEqual(
			kinds.filter((k) => k === "message_update").length,
			0,
			"message_update is never read back — the history resource serves message_end",
		);
		assert.strictEqual(kinds.filter((k) => k === "message_end").length, 1);

		// The payload must not reach the log either.
		const logged = session.logs.join("\n");
		assert.ok(
			!logged.includes("x".repeat(200)),
			"log must not carry the snapshot",
		);
	});

	test("logs are bounded for a long-lived session", () => {
		const session = new PiSession("test", "./scratch");
		const h = (session as any).handleStdoutLine.bind(session);

		for (let i = 0; i < 5000; i++) h(`{"type":"turn_end","n":${i}}`);

		assert.ok(
			session.logs.length <= 2000,
			`logs must stay bounded, saw ${session.logs.length}`,
		);
		// The most recent activity is what survives.
		assert.ok(session.logs.join("\n").includes('"n":4999'));
	});

	test("start() rejects when the pi binary cannot be spawned", async () => {
		const previous = process.env.WORKER_MCP_PI_PATH;
		process.env.WORKER_MCP_PI_PATH = "worker-mcp-nonexistent-binary-xyz";

		try {
			const session = new PiSession("test", ".");
			await assert.rejects(
				() => session.start(),
				/Failed to start pi/,
				"a missing binary must not look like a healthy session",
			);
			assert.strictEqual(session.status, "CRASHED");
		} finally {
			if (previous === undefined) {
				delete process.env.WORKER_MCP_PI_PATH;
			} else {
				process.env.WORKER_MCP_PI_PATH = previous;
			}
		}
	});

	test("sendCommand on a session with no process says how to recover", () => {
		const session = new PiSession("test", "./scratch");
		session.status = "FINISHED"; // as restored from the registry

		assert.strictEqual(session.isAlive(), false);
		assert.throws(
			() => session.sendCommand("hi"),
			/no running pi process.*Respawn it with spawn_pi_session/s,
		);
		// It must not claim to be a healthy idle session afterwards.
		assert.notStrictEqual(session.status, "IDLE");
	});

	test("agent_end settles a running command and returns session to IDLE", () => {
		const session = new PiSession("test", "./scratch");

		let resolved: string | null = null;
		session.status = "RUNNING";
		(session as any).resolveCommand = (value: string) => {
			resolved = value;
		};

		(session as any).handleStdoutLine('{"type":"agent_end"}');

		assert.strictEqual(session.status, "IDLE");
		assert.strictEqual(resolved, "Agent finished task run successfully.");
		assert.strictEqual((session as any).resolveCommand, null);
	});

	test("turn_end does not settle a command mid tool-call loop", () => {
		const session = new PiSession("test", "./scratch");

		let resolved = false;
		session.status = "RUNNING";
		(session as any).resolveCommand = () => {
			resolved = true;
		};

		(session as any).handleStdoutLine('{"type":"turn_end"}');

		assert.strictEqual(resolved, false);
		assert.strictEqual(session.status, "RUNNING");
	});

	test("prompt acknowledgement does not settle the command", () => {
		const session = new PiSession("test", "./scratch");

		let resolved = false;
		session.status = "RUNNING";
		(session as any).resolveCommand = () => {
			resolved = true;
		};

		(session as any).handleStdoutLine(
			'{"type":"response","command":"prompt","success":true}',
		);

		// The ack only means pi accepted the prompt; the agent is still working.
		assert.strictEqual(resolved, false);
		assert.strictEqual(session.status, "RUNNING");

		(session as any).handleStdoutLine('{"type":"agent_end"}');
		assert.strictEqual(resolved, true);
		assert.strictEqual(session.status, "IDLE");
	});

	test("failed response rejects and clears both command handlers", () => {
		const session = new PiSession("test", "./scratch");

		let rejection: Error | null = null;
		session.status = "RUNNING";
		(session as any).rejectCommand = (err: Error) => {
			rejection = err;
		};
		(session as any).resolveCommand = () => {
			throw new Error("resolveCommand must not survive a rejection");
		};

		(session as any).handleStdoutLine(
			'{"type":"response","command":"prompt","success":false,"error":"Agent is already processing."}',
		);

		assert.strictEqual(
			(rejection as unknown as Error)?.message,
			"Agent is already processing.",
		);
		assert.strictEqual(session.status, "IDLE");
		assert.strictEqual((session as any).resolveCommand, null);
		assert.strictEqual((session as any).rejectCommand, null);

		// A later agent_end must not fire the stale resolve handler.
		(session as any).handleStdoutLine('{"type":"agent_end"}');
	});

	test("approveAction resolves once the agent ends", async () => {
		const session = new PiSession("test", "./scratch");

		(session as any).writeRaw = async () => {};
		session.status = "AWAITING_APPROVAL";
		session.pendingAction = {
			actionId: "a1",
			tool: "confirm",
			arguments: {},
			context: "",
		};

		const pending = session.approveAction("a1");
		assert.strictEqual(session.status, "RUNNING");

		// Intermediate turn boundaries must not settle the approval.
		(session as any).handleStdoutLine('{"type":"turn_end"}');
		assert.strictEqual(session.status, "RUNNING");

		(session as any).handleStdoutLine('{"type":"agent_end"}');

		assert.strictEqual(await pending, "Agent finished task run successfully.");
		assert.strictEqual(session.status, "IDLE");
	});

	test("terminate() clears the pending action", () => {
		const session = new PiSession("test", "./scratch");

		session.status = "AWAITING_APPROVAL";
		session.pendingAction = {
			actionId: "a1",
			tool: "confirm",
			arguments: {},
			context: "",
		};

		session.terminate();

		// get_pending_actions must not hand out an approval for a dead process.
		assert.strictEqual(session.pendingAction, null);
	});

	test("process exit clears a pending action left behind by a dead agent", () => {
		const session = new PiSession("test", "./scratch");

		session.status = "AWAITING_APPROVAL";
		session.pendingAction = {
			actionId: "a1",
			tool: "confirm",
			arguments: {},
			context: "",
		};

		(session as any).handleClose(1);

		assert.strictEqual(session.pendingAction, null);
		assert.strictEqual(session.status, "CRASHED");
	});

	test("a requested termination is not reported as a crash", () => {
		const session = new PiSession("test", "./scratch");

		session.terminate();
		// pi exits non-zero when killed; that is not a crash.
		(session as any).handleClose(143);

		assert.strictEqual(session.status, "FINISHED");
	});

	test("process exit clears both command handlers", () => {
		const session = new PiSession("test", "./scratch");

		let resolvedWith: string | null = null;
		session.status = "RUNNING";
		(session as any).resolveCommand = (value: string) => {
			resolvedWith = value;
		};
		(session as any).rejectCommand = () => {};

		(session as any).handleClose(0);

		assert.strictEqual(resolvedWith, "Process terminated");
		assert.strictEqual((session as any).resolveCommand, null);
		assert.strictEqual((session as any).rejectCommand, null);
	});

	test("auto-approves LOW risk action", async () => {
		const session = new PiSession("test", "./scratch");
		let writeRawCalled = false;
		let writeRawObj: any = null;
		(session as any).writeRaw = async (obj: any) => {
			writeRawCalled = true;
			writeRawObj = obj;
		};

		// extension_ui_request for `ls -la`
		const obj = {
			type: "extension_ui_request",
			method: "confirm",
			id: "a1",
			title: "worker-mcp-gate",
			message: JSON.stringify({
				toolName: "bash",
				input: { command: "ls -la" },
			}),
		};

		(session as any).handleStdoutLine(JSON.stringify(obj));

		assert.strictEqual(writeRawCalled, true);
		assert.strictEqual(writeRawObj.type, "extension_ui_response");
		assert.strictEqual(writeRawObj.confirmed, true);
		assert.strictEqual(session.status, "IDLE");
		assert.strictEqual(session.pendingAction, null);
	});

	test("auto-approves MEDIUM risk action with notification", async () => {
		const session = new PiSession("test", "./scratch");
		let writeRawCalled = false;
		(session as any).writeRaw = async (_obj: any) => {
			writeRawCalled = true;
		};

		// extension_ui_request for `pnpm install`
		const obj = {
			type: "extension_ui_request",
			method: "confirm",
			id: "a2",
			title: "worker-mcp-gate",
			message: JSON.stringify({
				toolName: "bash",
				input: { command: "pnpm install" },
			}),
		};

		(session as any).handleStdoutLine(JSON.stringify(obj));

		assert.strictEqual(writeRawCalled, true);
		const log = session.getAutoApprovedLog();
		assert.strictEqual(log.length, 1);
		assert.strictEqual(log[0].actionId, "a2");
		assert.strictEqual(log[0].riskLevel, RiskLevel.MEDIUM);
	});

	test("HIGH risk requires approval", async () => {
		const session = new PiSession("test", "./scratch");
		let writeRawCalled = false;
		(session as any).writeRaw = async (_obj: any) => {
			writeRawCalled = true;
		};

		// extension_ui_request for `rm file.txt`
		const obj = {
			type: "extension_ui_request",
			method: "confirm",
			id: "a3",
			title: "worker-mcp-gate",
			message: JSON.stringify({
				toolName: "bash",
				input: { command: "rm file.txt" },
			}),
		};

		(session as any).handleStdoutLine(JSON.stringify(obj));

		assert.strictEqual(writeRawCalled, false);
		assert.strictEqual(session.status, "AWAITING_APPROVAL");
		assert.notStrictEqual(session.pendingAction, null);
		assert.strictEqual(session.pendingAction?.riskLevel, RiskLevel.HIGH);
	});

	test("Custom risk policy handles overrides", async () => {
		const customPolicy = {
			autoApproveUpTo: RiskLevel.MEDIUM,
			notifyUpTo: RiskLevel.MEDIUM,
			overrides: [],
		};
		const session = new PiSession(
			"test",
			"./scratch",
			undefined,
			undefined,
			customPolicy,
		);
		let writeRawCalled = false;
		(session as any).writeRaw = async (_obj: any) => {
			writeRawCalled = true;
		};

		const obj = {
			type: "extension_ui_request",
			method: "confirm",
			id: "a4",
			title: "worker-mcp-gate",
			message: JSON.stringify({
				toolName: "bash",
				input: { command: "pnpm install" },
			}), // MEDIUM risk
		};

		(session as any).handleStdoutLine(JSON.stringify(obj));

		assert.strictEqual(writeRawCalled, true);
		const logs = session.logs.join("\n");
		assert.ok(
			logs.includes("[AUTO-APPROVED]") &&
				!logs.includes("[AUTO-APPROVED+NOTIFY]"),
		);
	});

	test("Auto-approved log is populated and bounded", async () => {
		const session = new PiSession("test", "./scratch");
		(session as any).writeRaw = async (_obj: any) => {};

		for (let i = 0; i < 505; i++) {
			const obj = {
				type: "extension_ui_request",
				method: "confirm",
				id: `a${i}`,
				title: "worker-mcp-gate",
				message: JSON.stringify({ toolName: "bash", input: { command: "ls" } }),
			};
			(session as any).handleStdoutLine(JSON.stringify(obj));
		}

		const log = session.getAutoApprovedLog();
		assert.strictEqual(log.length, 500);
		assert.strictEqual(log[0].actionId, "a5");
		assert.strictEqual(log[499].actionId, "a504");
	});

	test("Old format backward compatibility", async () => {
		const session = new PiSession("test", "./scratch");
		let writeRawCalled = false;
		(session as any).writeRaw = async (_obj: any) => {
			writeRawCalled = true;
		};

		// Old format doesn't parse via parseToolFromMessage
		const obj = {
			type: "extension_ui_request",
			method: "confirm",
			id: "a_old",
			title: "Allow Tool Execution",
			message: 'Allow the "bash" tool to run with arguments: {}',
		};

		(session as any).handleStdoutLine(JSON.stringify(obj));

		assert.strictEqual(writeRawCalled, false);
		assert.strictEqual(session.status, "AWAITING_APPROVAL");
		assert.notStrictEqual(session.pendingAction, null);
		assert.strictEqual(session.pendingAction?.riskLevel, undefined);
	});

	test("summarizes assistant output when summarize is true", async () => {
		const session = new PiSession("test", "./scratch");

		let resolved: string | null = null;
		session.status = "RUNNING";
		(session as any).summarize = true;
		(session as any).summarizeText = async (text: string) =>
			`Summary of: ${text}`;
		(session as any).resolveCommand = (value: string) => {
			resolved = value;
		};

		(session as any).handleStdoutLine(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{
							type: "text",
							text: "This is a detailed response about the task.",
						},
					],
				},
			}),
		);

		(session as any).handleStdoutLine('{"type":"agent_end"}');

		await new Promise((resolve) => setTimeout(resolve, 10));

		assert.strictEqual(session.status, "IDLE");
		assert.strictEqual(
			resolved,
			"Summary of: This is a detailed response about the task.",
		);
	});

	test("returns raw assistant output when summarize is false", () => {
		const session = new PiSession("test", "./scratch");

		let resolved: string | null = null;
		session.status = "RUNNING";
		(session as any).summarize = false;
		(session as any).resolveCommand = (value: string) => {
			resolved = value;
		};

		(session as any).handleStdoutLine(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{
							type: "text",
							text: "This is a detailed response about the task.",
						},
					],
				},
			}),
		);

		(session as any).handleStdoutLine('{"type":"agent_end"}');

		assert.strictEqual(session.status, "IDLE");
		assert.strictEqual(resolved, "This is a detailed response about the task.");
	});
});
