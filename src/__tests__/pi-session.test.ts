/* biome-ignore-all lint/suspicious/noExplicitAny: testing private methods */
import assert from "node:assert";
import { describe, test } from "node:test";
import { PiSession } from "../session/pi-session.js";

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

		let longNonRepeating = "";
		for (let i = 0; i < 3000; i++) {
			longNonRepeating += `word${i} `;
		}

		assert.strictEqual(detectLoop(longNonRepeating.substring(0, 15999)), false);
		assert.strictEqual(detectLoop(longNonRepeating.substring(0, 16001)), true);
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
});
