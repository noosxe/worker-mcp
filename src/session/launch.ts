import * as fs from "node:fs";
import * as path from "node:path";

import type { Config } from "../config.js";
import type { RuntimeDir } from "./runtime-dir.js";

/**
 * Source of the approval gate, written fresh for every worker. It is a
 * constant compiled into the server so no file on disk is trusted as code.
 */
export const GATE_EXTENSION_SOURCE = `// Gating extension for worker-mcp (v3)
// Intercepts all tool execution requests and prompts the coordinator for approval.
// Uses structured message format for server-side risk classification.

export default function(pi: any) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    // Send structured data for server-side risk classification
    const payload = JSON.stringify({ toolName: event.toolName, input: event.input });
    const approved = await ctx.ui.confirm(
      "worker-mcp-gate",
      payload
    );
    if (!approved) {
      return { block: true, reason: "Tool execution blocked by the coordinator agent." };
    }
  });
}
`;

export const GATE_FILE_NAME = "gate.ts";

/** Flags that keep pi from loading anything but the gate. */
export const PI_HARDENING_FLAGS = [
	"--no-extensions",
	"--no-mcp",
	"--no-approve",
] as const;

export class GateError extends Error {}

export interface Gate {
	/** Private 0700 directory holding the gate; remove it with `removeGate`. */
	dir: string;
	/** The gate extension file, mode 0600. */
	file: string;
}

/**
 * Write the gate into a fresh private directory under the instance's runtime
 * dir. Throws a `GateError` when it cannot be written or is not there
 * afterwards: the caller must not start pi.
 */
export function writeGate(runtime: RuntimeDir): Gate {
	let dir: string | undefined;
	try {
		dir = runtime.createWorkerDir();
		const file = path.join(dir, GATE_FILE_NAME);
		fs.writeFileSync(file, GATE_EXTENSION_SOURCE, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		fs.chmodSync(file, 0o600);
		if (fs.readFileSync(file, "utf8") !== GATE_EXTENSION_SOURCE) {
			throw new Error("gate file changed after it was written");
		}
		return { dir, file };
	} catch (e) {
		if (dir) removeGate({ dir, file: "" });
		throw new GateError(
			`Refusing to start pi without the approval gate: could not write it (${e instanceof Error ? e.message : String(e)}).`,
			{ cause: e },
		);
	}
}

/** Throws unless the gate file is still there; call right before spawning. */
export function assertGatePresent(gate: Gate): void {
	if (!fs.existsSync(gate.file)) {
		throw new GateError(
			"Refusing to start pi without the approval gate: the gate file is missing.",
		);
	}
}

/** Remove a gate directory. Safe to call more than once. */
export function removeGate(gate: Gate): void {
	try {
		fs.rmSync(gate.dir, { recursive: true, force: true });
	} catch {
		// best effort: the directory is private and holds only the gate
	}
}

// ---- worker environment ------------------------------------------------------

/** Copied from the server environment when present. `*` matches any suffix. */
export const ENV_ALLOWLIST: readonly string[] = [
	// basics
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LANGUAGE",
	"LC_*",
	"TZ",
	"TERM",
	"COLORTERM",
	"NO_COLOR",
	// temp and XDG
	"TMPDIR",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
	"XDG_RUNTIME_DIR",
	// TLS and Nix
	"SSL_CERT_FILE",
	"NIX_SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
	"NIX_PATH",
	"NIX_PROFILES",
	"LOCALE_ARCHIVE",
	// pi's own settings
	"PI_*",
];

/** Never passed to a worker, even when listed in the passthrough variable. */
export const ENV_FORCE_DROP: readonly string[] = [
	"SSH_AUTH_SOCK",
	"GPG_AGENT_INFO",
	"*_TOKEN",
	"*_SECRET*",
	"AWS_*",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"KUBECONFIG",
	"DOCKER_HOST",
	"WORKER_MCP_*",
];

/** `*` matches any run of characters; everything else is literal. */
function matches(pattern: string, name: string): boolean {
	if (!pattern.includes("*")) return pattern === name;
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`).test(name);
}

const matchesAny = (patterns: readonly string[], name: string) =>
	patterns.some((p) => matches(p, name));

/**
 * The environment for a worker, built from empty: allowlisted names, then the
 * configured extra names, minus anything force-dropped. A name listed exactly
 * in the config file (`forceDropExempt`) is the one thing that can pass
 * despite a force-drop pattern; environment variables and patterns cannot.
 */
export function buildWorkerEnv(
	source: NodeJS.ProcessEnv,
	envConfig: Pick<Config["env"], "allow" | "forceDropExempt">,
): Record<string, string> {
	const allowed = [...ENV_ALLOWLIST, ...envConfig.allow];
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (
			matchesAny(ENV_FORCE_DROP, name) &&
			!envConfig.forceDropExempt.includes(name)
		) {
			continue;
		}
		if (matchesAny(allowed, name)) env[name] = value;
	}
	return env;
}
