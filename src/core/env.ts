import type { Config } from "../config.js";

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
