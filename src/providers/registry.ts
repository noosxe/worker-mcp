import type { Config } from "../config.js";
import { createPiProvider } from "./pi/provider.js";
import type { WorkerProvider } from "./types.js";

/** Raised when a provider is unknown, disabled or may not be opened. */
export class ProviderError extends Error {}

/** What a provider is built from: the server's validated configuration. */
export interface ProviderContext {
	config: Config;
}

export type ProviderFactory = (ctx: ProviderContext) => Promise<WorkerProvider>;

/**
 * Providers shipped in this package, keyed by id. Loaded lazily through a
 * static import of a module in this package: never a path from config, which
 * would be code execution from settings.
 */
export const BUILTIN_PROVIDERS: Readonly<Record<string, ProviderFactory>> = {
	pi: async ({ config }) => createPiProvider(config),
};

export interface RegistryOptions {
	/** Ids a worker may use; defaults to every known one. */
	enabled?: readonly string[];
	/** Used when a spawn names no provider. */
	defaultId?: string;
	/** Handed to every factory; the server's configuration. */
	context?: ProviderContext;
	/** Replaces the built-in set (tests). */
	factories?: Readonly<Record<string, ProviderFactory>>;
}

export class ProviderRegistry {
	private readonly factories: Readonly<Record<string, ProviderFactory>>;
	private readonly enabled: readonly string[];
	private readonly cache = new Map<string, Promise<WorkerProvider>>();
	readonly defaultId: string | undefined;
	private readonly context: ProviderContext | undefined;

	constructor(opts: RegistryOptions = {}) {
		this.factories = opts.factories ?? BUILTIN_PROVIDERS;
		this.context = opts.context;
		const known = Object.keys(this.factories);
		this.enabled = opts.enabled ?? known;
		for (const id of this.enabled) {
			if (!Object.hasOwn(this.factories, id)) {
				throw new ProviderError(
					`Unknown provider "${id}" in the enabled list.`,
				);
			}
		}
		this.defaultId = opts.defaultId ?? this.enabled[0];
		if (this.defaultId && !this.enabled.includes(this.defaultId)) {
			throw new ProviderError(
				`The default provider "${this.defaultId}" is not enabled.`,
			);
		}
	}

	/** Enabled provider ids, in order. */
	ids(): string[] {
		return [...this.enabled];
	}

	/** The provider with this id, or the default one when `id` is omitted. */
	get(id?: string): Promise<WorkerProvider> {
		const wanted = id ?? this.defaultId;
		if (!wanted)
			return Promise.reject(new ProviderError("No provider enabled."));
		if (!this.enabled.includes(wanted)) {
			return Promise.reject(
				new ProviderError(
					`Provider "${wanted}" is not available. Enabled: ${this.enabled.join(", ") || "none"}.`,
				),
			);
		}
		let loaded = this.cache.get(wanted);
		if (!loaded) {
			if (!this.context) {
				return Promise.reject(
					new ProviderError("The registry has no configuration."),
				);
			}
			loaded = this.factories[wanted](this.context);
			this.cache.set(wanted, loaded);
		}
		return loaded;
	}
}

export interface OpenPolicy {
	sandbox: "none" | "workspace";
	/** Server setting: let a provider with no gate run inside the sandbox. */
	allowUngatedInSandbox: boolean;
}

/**
 * Fail-closed rule: a provider that cannot gate each tool call is refused,
 * unless the worker runs inside the sandbox and the server allows it.
 */
export function assertOpenable(
	provider: Pick<WorkerProvider, "id" | "capabilities">,
	policy: OpenPolicy,
): void {
	if (provider.capabilities.approvals !== "none") return;
	if (policy.sandbox === "workspace" && policy.allowUngatedInSandbox) return;
	throw new ProviderError(
		`Provider "${provider.id}" cannot gate tool calls, so it is refused outside the workspace sandbox.`,
	);
}
