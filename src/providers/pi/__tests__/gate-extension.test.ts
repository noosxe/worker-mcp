import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import { buildPiArgs, PI_HARDENING_FLAGS } from "../argv.js";
import {
	encodeDecision,
	GATE_DIALOG_TITLE,
	GATE_EXTENSION_SOURCE,
	GATE_NONCE_ENV,
	GateError,
	parseGateRequest,
	writeGateFile,
} from "../gate-extension.js";

const NONCE = "00112233445566778899aabbccddeeff";

describe("gate extension source", () => {
	let dir: string;
	let file: string;
	before(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-mcp-gatesrc-"));
		file = writeGateFile(dir);
	});
	after(() => fs.rmSync(dir, { recursive: true, force: true }));

	/** Load the gate as pi would, with a stand-in for pi's extension API. */
	async function load(nonce: string | null = NONCE) {
		if (nonce === null) delete process.env[GATE_NONCE_ENV];
		else process.env[GATE_NONCE_ENV] = nonce;
		const handlers = new Map<string, (e: any, ctx: any) => any>();
		const mod = await import(`${pathToFileURL(file).href}?${Math.random()}`);
		mod.default({ on: (name: string, h: any) => handlers.set(name, h) });
		const statuses: [string, string][] = [];
		const inputs: { title: string; placeholder: string }[] = [];
		const replyFn: { current: (placeholder: string) => unknown } = {
			current: () => undefined,
		};
		const ctx = {
			ui: {
				setStatus: (k: string, v: string) => statuses.push([k, v]),
				input: async (title: string, placeholder: string) => {
					inputs.push({ title, placeholder });
					return replyFn.current(placeholder);
				},
			},
		};
		return {
			statuses,
			inputs,
			setReply: (f: (placeholder: string) => unknown) => {
				replyFn.current = f;
			},
			start: () => handlers.get("session_start")!({}, ctx),
			call: (event: any) => handlers.get("tool_call")!(event, ctx),
		};
	}

	test("is written private and read back", () => {
		assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
		assert.strictEqual(fs.readFileSync(file, "utf8"), GATE_EXTENSION_SOURCE);
		assert.throws(() => writeGateFile(dir), GateError, "never overwrites");
		assert.throws(
			() => writeGateFile(path.join(dir, "missing")),
			/without the approval gate/,
		);
	});

	test("reports ready with the nonce on session_start", async () => {
		const g = await load();
		await g.start();
		assert.deepStrictEqual(g.statuses, [["worker-mcp-gate", `ready:${NONCE}`]]);
	});

	test("removes the nonce from the environment so tools do not inherit it", async () => {
		await load();
		assert.strictEqual(process.env[GATE_NONCE_ENV], undefined);
	});

	test("without a nonce it never reports ready and blocks every call", async () => {
		const g = await load(null);
		await g.start();
		assert.deepStrictEqual(g.statuses, []);
		g.setReply(() => encodeDecision(NONCE, { kind: "allow" }));
		const out = await g.call({ toolName: "bash", input: {} });
		assert.strictEqual(out.block, true);
	});

	test("sends the call as a v3 request with the nonce", async () => {
		const g = await load();
		g.setReply(() => undefined);
		await g.call({ toolName: "bash", input: { command: "ls" } });
		assert.strictEqual(g.inputs[0].title, GATE_DIALOG_TITLE);
		assert.deepStrictEqual(JSON.parse(g.inputs[0].placeholder), {
			v: 3,
			nonce: NONCE,
			toolName: "bash",
			input: { command: "ls" },
		});
	});

	test("allow lets the call through", async () => {
		const g = await load();
		g.setReply(() => encodeDecision(NONCE, { kind: "allow" }));
		assert.strictEqual(
			await g.call({ toolName: "bash", input: {} }),
			undefined,
		);
	});

	test("deny blocks with the reason", async () => {
		const g = await load();
		g.setReply(() => encodeDecision(NONCE, { kind: "deny", reason: "nope" }));
		assert.deepStrictEqual(await g.call({ toolName: "bash", input: {} }), {
			block: true,
			reason: "nope",
		});
	});

	test("mutate rewrites the input in place", async () => {
		const g = await load();
		g.setReply(() =>
			encodeDecision(NONCE, { kind: "mutate", input: { command: "ls -1" } }),
		);
		const event = { toolName: "bash", input: { command: "ls", timeout: 5 } };
		assert.strictEqual(await g.call(event), undefined);
		assert.deepStrictEqual(event.input, { command: "ls -1" });
	});

	describe("anything but a valid decision with the right nonce blocks", () => {
		const bad: [string, () => unknown][] = [
			["a cancelled dialog", () => undefined],
			["an empty string", () => ""],
			["text that is not JSON", () => "allow"],
			["JSON null", () => "null"],
			["the wrong nonce", () => encodeDecision("ffffffff", { kind: "allow" })],
			["no nonce", () => JSON.stringify({ v: 3, decision: "allow" })],
			[
				"an old version",
				() => JSON.stringify({ v: 2, nonce: NONCE, decision: "allow" }),
			],
			[
				"an unknown decision",
				() => JSON.stringify({ v: 3, nonce: NONCE, decision: "yes" }),
			],
			[
				"a mutate without an input",
				() => JSON.stringify({ v: 3, nonce: NONCE, decision: "mutate" }),
			],
			["a number", () => 7],
		];
		for (const [name, reply] of bad) {
			test(name, async () => {
				const g = await load();
				g.setReply(reply);
				const out = await g.call({
					toolName: "bash",
					input: { command: "ls" },
				});
				assert.strictEqual(out?.block, true);
			});
		}

		test("a dialog that throws", async () => {
			const g = await load();
			g.setReply(() => {
				throw new Error("rpc broke");
			});
			const out = await g.call({ toolName: "bash", input: {} });
			assert.deepStrictEqual(out, {
				block: true,
				reason: "worker-mcp: gate error",
			});
		});
	});
});

describe("gate wire helpers", () => {
	test("parseGateRequest accepts only a v3 request with this nonce", () => {
		const good = JSON.stringify({
			v: 3,
			nonce: NONCE,
			toolName: "bash",
			input: { command: "ls" },
		});
		assert.deepStrictEqual(parseGateRequest(good, NONCE), {
			toolName: "bash",
			input: { command: "ls" },
		});
		for (const bad of [
			undefined,
			"",
			"not json",
			"null",
			"[]",
			JSON.stringify({ v: 3, nonce: "other", toolName: "bash", input: {} }),
			JSON.stringify({ v: 2, nonce: NONCE, toolName: "bash", input: {} }),
			JSON.stringify({ v: 3, nonce: NONCE, input: {} }),
		]) {
			assert.strictEqual(parseGateRequest(bad, NONCE), null, String(bad));
		}
		// A missing or odd input becomes an empty one, still gated.
		assert.deepStrictEqual(
			parseGateRequest(
				JSON.stringify({ v: 3, nonce: NONCE, toolName: "x", input: 5 }),
				NONCE,
			),
			{ toolName: "x", input: {} },
		);
	});

	test("decisions round-trip through the encoder", () => {
		assert.deepStrictEqual(
			JSON.parse(encodeDecision(NONCE, { kind: "allow" })),
			{
				v: 3,
				nonce: NONCE,
				decision: "allow",
			},
		);
		assert.deepStrictEqual(
			JSON.parse(encodeDecision(NONCE, { kind: "deny", reason: "r" })),
			{ v: 3, nonce: NONCE, decision: "deny", reason: "r" },
		);
	});
});

describe("pi argv", () => {
	test("always carries the hardening flags and the gate, and the system prompt", () => {
		const args = buildPiArgs({
			gateFile: "/g/gate.ts",
			systemPrompt: "be brief",
		});
		assert.deepStrictEqual(args.slice(0, 2), ["--mode", "rpc"]);
		for (const flag of PI_HARDENING_FLAGS) assert.ok(args.includes(flag));
		assert.strictEqual(args[args.indexOf("-e") + 1], "/g/gate.ts");
		assert.strictEqual(args[args.indexOf("--system-prompt") + 1], "be brief");
		assert.ok(!buildPiArgs({ gateFile: "/g" }).includes("--system-prompt"));
	});
});
