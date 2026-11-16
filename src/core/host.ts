import * as fs from "node:fs";

import { assertOpenable, type OpenPolicy } from "../providers/registry.js";
import type {
	ApprovalDecision,
	CloseReason,
	ProviderHost,
	RawToolCall,
	WorkerEvent,
	WorkerHandle,
	WorkerProvider,
	WorkerSpec,
} from "../providers/types.js";
import type { RuntimeDir } from "../session/runtime-dir.js";
import type {
	ChildRegistry,
	ManagedChild,
	ProviderChildSpec,
} from "./child.js";
import { type Logger, noopLogger } from "./log.js";
import type { SandboxProfile } from "./sandbox.js";

export type Approver = (
	call: RawToolCall,
	signal: AbortSignal,
) => Promise<ApprovalDecision>;

/** What the core gives one provider worker: spawn under policy, gate, events. */
export class WorkerHost implements ProviderHost {
	private readonly spawned: ManagedChild[] = [];

	constructor(
		private readonly deps: {
			children: ChildRegistry;
			privateDir: string;
			/** The worker's session directory, when its conversation is kept. */
			sessionDir?: string;
			/** Decided by the core for every process of this worker. */
			sandbox?: "none" | "workspace";
			sandboxProfile?: SandboxProfile;
			/** Set when the shell commands run in the second sandbox. */
			isolateCommand?: (command: string) => string;
			emit: (event: WorkerEvent) => void;
			approve: Approver;
			log: Logger;
		},
	) {}

	/** Pids of the processes this worker has running now. */
	pids(): number[] {
		return this.spawned.flatMap((c) => (c.pid === undefined ? [] : [c.pid]));
	}

	get privateDir(): string {
		return this.deps.privateDir;
	}

	get log(): Logger {
		return this.deps.log;
	}

	spawn(spec: ProviderChildSpec): ManagedChild {
		const child = this.deps.children.spawn({
			...spec,
			sandbox: this.deps.sandbox ?? "none",
			sandboxProfile: this.deps.sandboxProfile,
			privateDir: this.deps.privateDir,
			sessionDir: this.deps.sessionDir,
		});
		this.spawned.push(child);
		// A per-run provider starts many processes: forget the ones that ended.
		void child.exited.then(() => {
			const i = this.spawned.indexOf(child);
			if (i !== -1) this.spawned.splice(i, 1);
		});
		return child;
	}

	emit(event: WorkerEvent): void {
		try {
			this.deps.emit(event);
		} catch (e) {
			this.deps.log.warn(
				`event sink failed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	async requestApproval(
		call: RawToolCall,
		signal: AbortSignal,
	): Promise<ApprovalDecision> {
		try {
			return this.isolate(call, await this.deps.approve(call, signal));
		} catch (e) {
			// Failing closed: a gate that errors denies.
			return {
				kind: "deny",
				reason: `the approval gate failed: ${e instanceof Error ? e.message : String(e)}`,
			};
		}
	}

	/**
	 * An allowed shell command runs in the second sandbox: the decision becomes
	 * a mutation with the wrapped command (what the gate rated is what the
	 * worker asked for; the wrapper only takes things away). A command that
	 * cannot be wrapped is denied.
	 */
	private isolate(
		call: RawToolCall,
		decision: ApprovalDecision,
	): ApprovalDecision {
		const tool = this.deps.sandboxProfile?.shellTool;
		const wrap = this.deps.isolateCommand;
		if (!wrap || !tool || call.toolName !== tool.name) return decision;
		if (decision.kind === "deny") return decision;
		const input = decision.kind === "mutate" ? decision.input : call.input;
		const command = input[tool.command];
		if (typeof command !== "string") {
			return {
				kind: "deny",
				reason: "the shell command could not be isolated: it is not a string",
			};
		}
		return {
			kind: "mutate",
			input: { ...input, [tool.command]: wrap(command) },
		};
	}

	/** Terminate every process this worker started. Idempotent. */
	async terminateChildren(graceMs?: number): Promise<void> {
		await Promise.all(this.spawned.map((c) => c.terminate(graceMs)));
	}

	removePrivateDir(): void {
		try {
			fs.rmSync(this.deps.privateDir, { recursive: true, force: true });
		} catch {
			// best effort: the directory is private to this worker
		}
	}
}

export interface OpenWorkerOptions {
	provider: WorkerProvider;
	spec: WorkerSpec;
	children: ChildRegistry;
	runtime: RuntimeDir;
	policy: OpenPolicy;
	emit: (event: WorkerEvent) => void;
	approve: Approver;
	log?: Logger;
}

export interface OpenedWorker {
	handle: WorkerHandle;
	host: WorkerHost;
	/**
	 * Close the provider's side, then make sure every process it started is
	 * gone and remove the private dir. Idempotent; never rejects.
	 */
	close(opts: { graceMs: number; reason: CloseReason }): Promise<void>;
}

/**
 * Open a worker through its provider. The core refuses a provider that cannot
 * gate, and when `open()` fails (including a gate that never became active)
 * kills whatever the provider started: a half-open worker never lingers.
 */
export async function openWorker(
	opts: OpenWorkerOptions,
): Promise<OpenedWorker> {
	assertOpenable(opts.provider, opts.policy);
	const log = opts.log ?? noopLogger;
	let privateDir: string;
	try {
		privateDir = opts.runtime.createWorkerDir();
	} catch (e) {
		throw new Error(
			`Refusing to start ${opts.provider.id} without the approval gate: could not create its private directory (${e instanceof Error ? e.message : String(e)}).`,
			{ cause: e },
		);
	}
	const host = new WorkerHost({
		children: opts.children,
		privateDir,
		sessionDir: opts.spec.session?.dir,
		sandbox: opts.policy.sandbox,
		sandboxProfile: opts.provider.sandboxProfile,
		isolateCommand:
			opts.policy.sandbox === "workspace" &&
			opts.policy.toolIsolation &&
			opts.provider.sandboxProfile
				? (command) =>
						opts.children.isolateCommand(
							command,
							opts.provider.sandboxProfile as SandboxProfile,
							// The commands a worker runs must not read its conversation.
							opts.spec.session ? [opts.spec.session.dir] : [],
						)
				: undefined,
		emit: opts.emit,
		approve: opts.approve,
		log,
	});
	let handle: WorkerHandle;
	try {
		handle = await opts.provider.open(opts.spec, host);
	} catch (e) {
		await host.terminateChildren(0);
		host.removePrivateDir();
		throw e;
	}
	let closing: Promise<void> | null = null;
	return {
		handle,
		host,
		close(closeOpts) {
			closing ??= (async () => {
				try {
					await handle.close(closeOpts);
				} catch (e) {
					log.warn(
						`provider close failed: ${e instanceof Error ? e.message : String(e)}`,
					);
				}
				await host.terminateChildren(closeOpts.graceMs);
				host.removePrivateDir();
			})();
			return closing;
		},
	};
}
