#!/usr/bin/env node
// Minimal stand-in for `pi --mode rpc`. Prompt text picks the behaviour:
//   "slow ..."     never finishes until it receives an abort
//   "approve ..."  asks for approval of a risky shell command first
//   anything else  replies immediately
// When FAKE_PI_LOG is set, every message received is appended to that file.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const reply = (text) => {
	send({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }] },
	});
	send({ type: "agent_end" });
};

let pendingPrompt = null;

rl.on("line", (line) => {
	const msg = JSON.parse(line);
	if (process.env.FAKE_PI_LOG) {
		appendFileSync(process.env.FAKE_PI_LOG, `${msg.type}\n`);
	}
	if (msg.type === "prompt") {
		send({ id: msg.id, type: "response", command: "prompt", success: true });
		send({ type: "agent_start" });
		if (msg.message.startsWith("slow")) {
			pendingPrompt = "slow";
		} else if (msg.message.startsWith("approve")) {
			pendingPrompt = "approve";
			send({
				type: "extension_ui_request",
				id: "ui-1",
				method: "confirm",
				title: "worker-mcp-gate",
				message: JSON.stringify({
					toolName: "bash",
					input: { command: "rm -rf build" },
				}),
			});
		} else {
			reply(`fake-pi reply: ${msg.message}`);
		}
	} else if (msg.type === "abort" && pendingPrompt === "slow") {
		pendingPrompt = null;
		send({ type: "agent_end" });
	} else if (
		msg.type === "extension_ui_response" &&
		pendingPrompt === "approve"
	) {
		pendingPrompt = null;
		reply(msg.confirmed ? "approved and done" : "rejected");
	}
});
rl.on("close", () => process.exit(0));
