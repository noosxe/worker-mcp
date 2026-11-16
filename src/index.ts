#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ConfigError, formatConfig, loadConfig } from "./config.js";
import { describeError, setLogLevel } from "./core/log.js";
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
      --pi-default-model <model>  Model for workers spawned without one, as <provider>/<model>
      --pi-startup-timeout-ms <n>  How long a spawn waits for pi's gate (default 60000)
      --command-timeout-ms <n>  No longer used; accepted so existing setups keep working
      --run-timeout-ms <n>    Wall-clock limit for one run (default 1800000)
      --max-wait-ms <n>       Longest a wait_run call blocks (default 50000)
      --run-start-timeout-ms <n>  How long a worker may take to accept a prompt (default 15000)
      --max-workers <n>       Most workers alive at once (default 4)
      --idle-timeout-ms <n>   Close a worker with no run for this long (default 1800000)
      --allowed-roots <paths> Comma-separated directories a worker's cwd must lie in (default: any)
      --approval-timeout-ms <n>  How long an approval waits before it is denied (default 600000)
      --max-output-chars <n>  Output size cap
      --env-passthrough <names>  Extra worker env names, comma-separated
      --state-dir <path>      State directory
      --runtime-dir <path>    Directory for the private runtime dir
      --max-auto-approve <level>  Ceiling on auto-approval: LOW, MEDIUM or HIGH
      --gate-mode <mode>      manual (default) or auto (classifiers decide what the rules escalate)
      --http-allow-ceiling <level>  Highest level a classifier may allow (default HIGH)
      --on-classifier-failure <escalate|deny>  What an unanswered classifier means (default escalate)
      --persist-runs <on|off> Keep a record of each run on disk so it can be read after a restart (default on)
      --persist-sessions <on|off> Keep each worker's conversation on disk (default on; spawn_worker resumeFrom continues one)
      --record-retention-ms <n>  Delete run records older than this (default 604800000, 7 days)
      --max-recorded-runs <n> Most run records kept on disk (default 500)
      --session-retention-ms <n>  Delete saved conversations with no activity for this long (default 259200000, 3 days)
      --max-session-bytes <n> Most bytes all saved conversations may take (default 268435456, 256 MiB)
      --resume-max-context-tokens <n>  Refuse to resume a conversation above this many tokens (default 150000)
      --audit <on|off>        Write the audit log file (default on)
      --audit-file <path>     Audit log file (default <state dir>/audit.jsonl)
      --log-level <level>     debug, info (default), warn or error; tool inputs and worker output only at debug

Settings may also come from WORKER_MCP_* environment variables; see the README.
`);
	process.exit(0);
}

if (loaded.flags.printConfig) {
	process.stdout.write(formatConfig(loaded.config));
	process.exit(0);
}

setLogLevel(loaded.config.logLevel);

// Builds the classifiers: a missing or insecure token file stops the server here.
let sessionManager: SessionManager;
try {
	sessionManager = new SessionManager(loaded.config, process.env, undefined, {
		version,
	});
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
sessionManager.start();
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
			console.error(`Error while terminating workers: ${describeError(error)}`);
		})
		.finally(() => process.exit(code));
}

// Run server using stdio transport
async function main() {
	const transport = new StdioServerTransport();
	// oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Server callback, not an EventTarget
	server.server.onclose = () => shutdown(0, "MCP connection closed.");
	// The client going away closes stdin; without this the workers' pipes keep
	// the process alive.
	process.stdin.on("end", () => shutdown(0, "Standard input closed."));
	process.stdin.on("error", (error) => {
		console.error(`Standard input error: ${describeError(error)}`);
		shutdown(1, "Standard input failed.");
	});
	await server.connect(transport);
	for (const warning of loaded.warnings) console.error(`Warning: ${warning}`);
	console.error("worker-mcp server running on stdio");
}

// A rotated secret takes effect without a restart. Without token files SIGHUP
// keeps its usual meaning: the controlling terminal is gone, so shut down.
process.on("SIGHUP", () => {
	if (!sessionManager.gate.hasTokenFiles) {
		shutdown(0, "Hangup received.", true);
		return;
	}
	const { reloaded, failed } = sessionManager.reloadTokens();
	console.error(
		`Reloaded ${reloaded} classifier token file(s)${failed ? `, ${failed} failed (old token kept)` : ""}.`,
	);
});
process.on("SIGINT", () => shutdown(0, "Shutdown signal received.", true));
process.on("SIGTERM", () => shutdown(0, "Shutdown signal received.", true));
process.on("unhandledRejection", (reason) => {
	console.error(`Unhandled rejection: ${describeError(reason)}`);
	shutdown(1, "Unhandled rejection.");
});
process.on("uncaughtException", (error) => {
	console.error(`Uncaught exception: ${describeError(error)}`);
	shutdown(1, "Uncaught exception.");
});

main().catch((error) => {
	console.error(`Fatal error in main: ${describeError(error)}`);
	shutdown(1, "Fatal error.");
});
