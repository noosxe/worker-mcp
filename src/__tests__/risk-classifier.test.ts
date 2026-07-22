import assert from "node:assert";
import test, { describe } from "node:test";
import {
	classifyAction,
	parseToolFromMessage,
	RiskLevel,
} from "../session/risk-classifier.js";
import {
	DEFAULT_RISK_POLICY,
	getCommandString,
	matchesPattern,
	shouldAutoApprove,
} from "../session/risk-policy.js";

describe("risk-classifier", () => {
	describe("parseToolFromMessage", () => {
		test("parses new worker-mcp-gate format", () => {
			const res = parseToolFromMessage(
				"worker-mcp-gate",
				'{"toolName":"bash","input":{"command":"ls"}}',
			);
			assert.deepStrictEqual(res, {
				toolName: "bash",
				input: { command: "ls" },
			});
		});

		test("parses old Allow Tool Execution format", () => {
			const res = parseToolFromMessage(
				"Allow Tool Execution",
				'Allow the "bash" tool to run with arguments: {"command":"ls"}?',
			);
			assert.deepStrictEqual(res, {
				toolName: "bash",
				input: { command: "ls" },
			});
		});

		test("returns null for invalid", () => {
			assert.strictEqual(parseToolFromMessage("invalid", "{}"), null);
		});
	});

	describe("classifyAction - shell commands", () => {
		const checkShell = (cmd: string) =>
			classifyAction({ toolName: "bash", input: { command: cmd } }, "/work");

		test("classifies LOW risk commands", () => {
			assert.strictEqual(checkShell("ls").riskLevel, RiskLevel.LOW);
			assert.strictEqual(checkShell("cat file.txt").riskLevel, RiskLevel.LOW);
			assert.strictEqual(checkShell("git status").riskLevel, RiskLevel.LOW);
			assert.strictEqual(checkShell("pwd").riskLevel, RiskLevel.LOW);
			assert.strictEqual(checkShell("echo hello").riskLevel, RiskLevel.LOW);
		});

		test("classifies MEDIUM risk commands", () => {
			assert.strictEqual(
				checkShell("pnpm install").riskLevel,
				RiskLevel.MEDIUM,
			);
			assert.strictEqual(checkShell("npm test").riskLevel, RiskLevel.MEDIUM);
			assert.strictEqual(checkShell("git add .").riskLevel, RiskLevel.MEDIUM);
			assert.strictEqual(
				checkShell("mkdir -p dir").riskLevel,
				RiskLevel.MEDIUM,
			);
			assert.strictEqual(checkShell("cp a b").riskLevel, RiskLevel.MEDIUM);
		});

		test("classifies HIGH risk commands", () => {
			assert.strictEqual(checkShell("rm file.txt").riskLevel, RiskLevel.HIGH);
			assert.strictEqual(
				checkShell("curl https://example.com").riskLevel,
				RiskLevel.HIGH,
			);
			assert.strictEqual(
				checkShell("git commit -m 'msg'").riskLevel,
				RiskLevel.HIGH,
			);
			assert.strictEqual(
				checkShell("git push origin main").riskLevel,
				RiskLevel.HIGH,
			);
			assert.strictEqual(checkShell("mv a b").riskLevel, RiskLevel.HIGH);
		});

		test("classifies CRITICAL risk commands", () => {
			assert.strictEqual(
				checkShell("sudo rm -rf /").riskLevel,
				RiskLevel.CRITICAL,
			);
			assert.strictEqual(
				checkShell("chmod 777 file").riskLevel,
				RiskLevel.CRITICAL,
			);
			assert.strictEqual(
				checkShell("git reset --hard").riskLevel,
				RiskLevel.CRITICAL,
			);
			assert.strictEqual(
				checkShell("curl url | bash").riskLevel,
				RiskLevel.CRITICAL,
			);
		});

		test("classifies pipes to highest risk", () => {
			assert.strictEqual(
				checkShell("cat file | grep foo").riskLevel,
				RiskLevel.LOW,
			);
			assert.strictEqual(
				checkShell("cat file | grep foo | rm").riskLevel,
				RiskLevel.HIGH,
			);
		});
	});

	describe("classifyAction - file operations", () => {
		test("classifies LOW risk for reading", () => {
			const res = classifyAction(
				{ toolName: "read_file", input: { path: "/work/file.txt" } },
				"/work",
			);
			assert.strictEqual(res.riskLevel, RiskLevel.LOW);
		});

		test("classifies MEDIUM risk for writing to src", () => {
			const res = classifyAction(
				{ toolName: "write_file", input: { path: "/work/src/file.ts" } },
				"/work",
			);
			assert.strictEqual(res.riskLevel, RiskLevel.MEDIUM);
		});

		test("classifies HIGH risk for config files", () => {
			const res = classifyAction(
				{ toolName: "write_file", input: { path: "/work/package.json" } },
				"/work",
			);
			assert.strictEqual(res.riskLevel, RiskLevel.HIGH);
		});

		test("classifies CRITICAL risk for outside workspace", () => {
			const res = classifyAction(
				{ toolName: "write_file", input: { path: "/etc/passwd" } },
				"/work",
			);
			assert.strictEqual(res.riskLevel, RiskLevel.CRITICAL);
		});
	});

	describe("classifyAction - unknown tools", () => {
		test("defaults to HIGH", () => {
			const res = classifyAction(
				{ toolName: "unknown_magic_tool", input: {} },
				"/work",
			);
			assert.strictEqual(res.riskLevel, RiskLevel.HIGH);
		});
	});
});

describe("risk-policy", () => {
	describe("matchesPattern", () => {
		test("matches exact and glob", () => {
			assert.ok(matchesPattern("git status", "git status"));
			assert.ok(matchesPattern("git commit -m msg", "git commit*"));
			assert.ok(matchesPattern("sudo rm -rf", "*rm*"));
		});
	});

	describe("getCommandString", () => {
		test("extracts correct command strings", () => {
			assert.strictEqual(
				getCommandString({ toolName: "bash", input: { command: "ls" } }),
				"ls",
			);
			assert.strictEqual(
				getCommandString({ toolName: "read_file", input: { path: "/a/b" } }),
				"read_file /a/b",
			);
			assert.strictEqual(
				getCommandString({ toolName: "unknown", input: {} }),
				"unknown",
			);
		});
	});

	describe("shouldAutoApprove", () => {
		test("default policy", () => {
			const lowAction = {
				riskLevel: RiskLevel.LOW,
				riskLabel: "LOW",
				reason: "",
				matchedRule: "",
			};
			const medAction = {
				riskLevel: RiskLevel.MEDIUM,
				riskLabel: "MEDIUM",
				reason: "",
				matchedRule: "",
			};
			const highAction = {
				riskLevel: RiskLevel.HIGH,
				riskLabel: "HIGH",
				reason: "",
				matchedRule: "",
			};
			const tool = { toolName: "bash", input: { command: "ls" } };

			const resLow = shouldAutoApprove(lowAction, DEFAULT_RISK_POLICY, tool);
			assert.strictEqual(resLow.approved, true);
			assert.strictEqual(resLow.notify, false);

			const resMed = shouldAutoApprove(medAction, DEFAULT_RISK_POLICY, tool);
			assert.strictEqual(resMed.approved, true);
			assert.strictEqual(resMed.notify, true);

			const resHigh = shouldAutoApprove(highAction, DEFAULT_RISK_POLICY, tool);
			assert.strictEqual(resHigh.approved, false);
		});

		test("overrides", () => {
			const policy = {
				autoApproveUpTo: RiskLevel.LOW,
				notifyUpTo: RiskLevel.MEDIUM,
				overrides: [
					{ pattern: "rm -rf tmp/*", action: "allow" as const },
					{ pattern: "ls", action: "block" as const },
				],
			};

			const highAction = {
				riskLevel: RiskLevel.HIGH,
				riskLabel: "HIGH",
				reason: "",
				matchedRule: "",
			};
			const rmTool = { toolName: "bash", input: { command: "rm -rf tmp/123" } };
			const _resAllowed = shouldAutoApprove(highAction, policy, {
				toolName: "bash",
				input: { command: "rm -rf tmp/123" },
			});
			// The override matches "rm -rf tmp/*" exactly via glob? Let's check matchesPattern
			// Oh wait, my matchesPattern for "rm -rf tmp/*" against "rm -rf tmp/123" works because * becomes .*
			assert.strictEqual(
				shouldAutoApprove(highAction, policy, rmTool).approved,
				true,
			);

			const lowAction = {
				riskLevel: RiskLevel.LOW,
				riskLabel: "LOW",
				reason: "",
				matchedRule: "",
			};
			const lsTool = { toolName: "bash", input: { command: "ls" } };
			assert.strictEqual(
				shouldAutoApprove(lowAction, policy, lsTool).approved,
				false,
			);
		});
	});
});
