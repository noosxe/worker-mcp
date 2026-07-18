import { test, describe } from "node:test";
import assert from "node:assert";
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

		assert.strictEqual(detectLoop("a".repeat(15999)), false);
		assert.strictEqual(detectLoop("a".repeat(16001)), true);
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
				const line = (session as any).stdoutBuffer.substring(0, boundary).trim();
				(session as any).stdoutBuffer = (session as any).stdoutBuffer.substring(
					boundary + 1,
				);
				if (line) {
					(session as any).handleStdoutLine(line);
				}
				boundary = (session as any).stdoutBuffer.indexOf("\n");
			}
		};

		stdoutBufferReceiver(Buffer.from('{"type":"turn_start"}\n{"type":"message'));
		assert.deepStrictEqual(parsedLines, ['{"type":"turn_start"}']);

		stdoutBufferReceiver(Buffer.from('_update","text":"Hello"}\n'));
		assert.deepStrictEqual(parsedLines, [
			'{"type":"turn_start"}',
			'{"type":"message_update","text":"Hello"}',
		]);
	});
});
