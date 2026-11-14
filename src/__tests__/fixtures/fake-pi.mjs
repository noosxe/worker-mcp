#!/usr/bin/env node
// Minimal stand-in for `pi --mode rpc`: answers every prompt with a fixed
// assistant message, then settles the run.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

rl.on("line", (line) => {
	const msg = JSON.parse(line);
	if (msg.type === "prompt") {
		send({ id: msg.id, type: "response", command: "prompt", success: true });
		send({ type: "agent_start" });
		send({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `fake-pi reply: ${msg.message}` }],
			},
		});
		send({ type: "agent_end" });
	}
});
rl.on("close", () => process.exit(0));
