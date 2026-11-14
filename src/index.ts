#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ConfigError, formatConfig, loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { SessionManager } from "./session/session-manager.js";

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

// Build the effective config first: invalid settings stop the server here.
let loaded: ReturnType<typeof loadConfig>;
try {
	loaded = loadConfig(process.argv.slice(2), process.env);
} catch (error) {
	console.error(
		error instanceof ConfigError || error instanceof Error
			? error.message
			: String(error),
	);
	process.exit(1);
}

if (loaded.flags.version) {
	console.log(`worker-mcp v${version}`);
	process.exit(0);
}

if (loaded.flags.help) {
	console.log(`worker-mcp - Model Context Protocol server supervising local worker agents

Usage:
  worker-mcp [options]

Options:
  -v, --version               Show version
  -h, --help                  Show help
      --print-config          Print the effective configuration and exit
      --config <path>         JSON config file (default: $XDG_CONFIG_HOME/worker-mcp/config.json)
      --pi-path <path>        Path to the pi binary
      --command-timeout-ms <n>  Default blocking-call timeout
      --max-output-chars <n>  Output size cap
      --env-passthrough <names>  Extra worker env names, comma-separated
      --state-dir <path>      State directory
      --runtime-dir <path>    Directory for the private runtime dir
      --max-auto-approve <level>  Ceiling on auto-approval: LOW, MEDIUM or HIGH

Settings may also come from WORKER_MCP_* environment variables; see the README.
`);
	process.exit(0);
}

if (loaded.flags.printConfig) {
	process.stdout.write(formatConfig(loaded.config));
	process.exit(0);
}

const sessionManager = new SessionManager(loaded.config, process.env);
const server = createServer(sessionManager, version);

// Terminate every worker (and what each started) and exit. Safe to call more
// than once; a repeated signal while waiting kills at once.
let shuttingDown = false;
function shutdown(code: number, reason: string, isSignal = false) {
	if (shuttingDown) {
		// Closing stdin and the MCP transport fire together: only a repeated
		// signal means "stop waiting".
		if (!isSignal) return;
		console.error(`${reason} Killing workers immediately.`);
		sessionManager.killAllNow();
		process.exit(code);
	}
	shuttingDown = true;
	console.error(`${reason} Terminating all active worker processes...`);
	sessionManager
		.terminateAll()
		.catch((error) => {
			console.error("Error while terminating workers:", error);
		})
		.finally(() => process.exit(code));
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

process.on("SIGINT", () => shutdown(0, "Shutdown signal received.", true));
process.on("SIGTERM", () => shutdown(0, "Shutdown signal received.", true));
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
