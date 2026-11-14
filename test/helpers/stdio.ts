import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { Connection } from "./behaviour.js";
import { type Isolation, REPO_ROOT, waitUntil } from "./isolation.js";

export type Runtime = "node" | "bun";

export const RUNTIME: Runtime =
	process.env.WORKER_MCP_TEST_RUNTIME === "bun" ? "bun" : "node";

if (
	process.env.WORKER_MCP_TEST_RUNTIME &&
	!["node", "bun"].includes(process.env.WORKER_MCP_TEST_RUNTIME)
) {
	throw new Error("WORKER_MCP_TEST_RUNTIME must be 'node' or 'bun'");
}

export const DIST_ENTRY = path.join(REPO_ROOT, "dist", "index.js");

if (!fs.existsSync(DIST_ENTRY)) {
	throw new Error("dist/index.js is missing: run `pnpm run build` first");
}

/** SDK client over a stdio transport to `<runtime> dist/index.js`. */
export async function connectStdio(iso: Isolation): Promise<Connection> {
	const transport = new StdioClientTransport({
		command: RUNTIME,
		args: [DIST_ENTRY],
		env: iso.env,
		stderr: "ignore",
	});
	const client = new Client({ name: "stdio-test-client", version: "0.0.0" });
	await client.connect(transport);
	return { client, close: () => client.close() };
}

/**
 * A server process driven with hand-written JSON-RPC, for tests that need the
 * process itself (stdout contents, signals, stdin EOF, exit timing).
 */
export class RawServer {
	readonly child: ChildProcess;
	readonly stdoutLines: string[] = [];
	readonly stderr: string[] = [];
	private nextId = 1;
	private pending = new Map<number, (msg: any) => void>();
	private buffer = "";
	exited: Promise<{ code: number | null; signal: string | null }>;

	constructor(iso: Isolation) {
		this.child = spawn(RUNTIME, [DIST_ENTRY], {
			env: iso.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stdout!.setEncoding("utf8");
		this.child.stdout!.on("data", (chunk: string) => {
			this.buffer += chunk;
			let index = this.buffer.indexOf("\n");
			while (index !== -1) {
				const line = this.buffer.slice(0, index);
				this.buffer = this.buffer.slice(index + 1);
				this.stdoutLines.push(line);
				try {
					const msg = JSON.parse(line);
					if (msg.id !== undefined) this.pending.get(msg.id)?.(msg);
				} catch {
					// reported by the stdout-purity test
				}
				index = this.buffer.indexOf("\n");
			}
		});
		this.child.stderr!.setEncoding("utf8");
		this.child.stderr!.on("data", (chunk: string) => this.stderr.push(chunk));
		this.child.stdin!.on("error", () => {});
		this.exited = new Promise((resolve) =>
			this.child.once("exit", (code, signal) => resolve({ code, signal })),
		);
	}

	private write(msg: object) {
		this.child.stdin!.write(`${JSON.stringify(msg)}\n`);
	}

	request(method: string, params: object = {}, timeoutMs = 10_000) {
		const id = this.nextId++;
		return new Promise<any>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`no response to ${method}`)),
				timeoutMs,
			);
			this.pending.set(id, (msg) => {
				clearTimeout(timer);
				resolve(msg);
			});
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	async initialize() {
		const res = await this.request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "raw-test-client", version: "0.0.0" },
		});
		this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
		return res;
	}

	callTool(name: string, args: object) {
		return this.request("tools/call", { name, arguments: args });
	}

	hasExited() {
		return this.child.exitCode !== null || this.child.signalCode !== null;
	}

	/** Make sure nothing is left running. */
	async dispose() {
		if (!this.hasExited()) this.child.kill("SIGKILL");
		await waitUntil(() => this.hasExited(), 3000, "server to exit").catch(
			() => {},
		);
	}
}
