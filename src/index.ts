#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./server.js";
import { SessionManager } from "./session/session-manager.js";
import { validateEnv } from "./validation.js";

// Parse version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = join(__dirname, "..", "package.json");

let version = "0.2.0";
try {
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	version = pkg.version || version;
} catch {
	// fallback
}

// Handle version/help flags
if (process.argv.includes("--version") || process.argv.includes("-v")) {
	console.log(`worker-mcp v${version}`);
	process.exit(0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(`worker-mcp - Model Context Protocol server supervising local worker agents

Usage:
  worker-mcp [options]

Options:
  -v, --version  Show version
  -h, --help     Show help
`);
	process.exit(0);
}

// Reject bad numeric settings up front instead of misbehaving later.
try {
	validateEnv();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

const sessionManager = new SessionManager();
const server = createServer(sessionManager, version);

// Terminate every worker and exit. Safe to call more than once.
let shuttingDown = false;
function shutdown(code: number, reason: string) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.error(`${reason} Terminating all active worker processes...`);
	try {
		sessionManager.terminateAll();
	} catch (error) {
		console.error("Error while terminating workers:", error);
	}
	process.exit(code);
}

// Run server using stdio transport
async function main() {
	const transport = new StdioServerTransport();
	// oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Server callback, not an EventTarget
	server.onclose = () => shutdown(0, "MCP connection closed.");
	// The client going away closes stdin; without this the workers' pipes keep
	// the process alive.
	process.stdin.on("end", () => shutdown(0, "Standard input closed."));
	process.stdin.on("error", (error) => {
		console.error("Standard input error:", error);
		shutdown(1, "Standard input failed.");
	});
	await server.connect(transport);
	console.error("worker-mcp server running on stdio");
}

process.on("SIGINT", () => shutdown(0, "Shutdown signal received."));
process.on("SIGTERM", () => shutdown(0, "Shutdown signal received."));
process.on("unhandledRejection", (reason) => {
	console.error("Unhandled rejection:", reason);
	shutdown(1, "Unhandled rejection.");
});
process.on("uncaughtException", (error) => {
	console.error("Uncaught exception:", error);
	shutdown(1, "Uncaught exception.");
});

main().catch((error) => {
	console.error("Fatal error in main:", error);
	shutdown(1, "Fatal error.");
});
