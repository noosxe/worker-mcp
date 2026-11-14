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
import type { ChildRegistry, ChildSpec, ManagedChild } from "./child.js";
import { type Logger, noopLogger } from "./log.js";

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
			emit: (event: WorkerEvent) => void;
			approve: Approver;
			log: Logger;
		},
	) {}

	get privateDir(): string {
		return this.deps.privateDir;
	}

	get log(): Logger {
		return this.deps.log;
	}

	spawn(spec: ChildSpec): ManagedChild {
		const child = this.deps.children.spawn(spec);
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
			return await this.deps.approve(call, signal);
		} catch (e) {
			// Failing closed: a gate that errors denies.
			return {
				kind: "deny",
				reason: `the approval gate failed: ${e instanceof Error ? e.message : String(e)}`,
			};
		}
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
