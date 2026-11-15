import * as fs from "node:fs";
import * as path from "node:path";

import { type Config } from "../config.js";
import { ChildRegistry } from "../core/child.js";
import { type RunStore } from "../core/run.js";
import { ToolError } from "../errors.js";
import { isInside } from "../gate/paths.js";
import { newWorkerId, WORKER_ID_PATTERN, WORKER_NAME_PATTERN } from "../ids.js";
import { ProviderRegistry } from "../providers/registry.js";
import { RuntimeDir } from "./runtime-dir.js";
import { type PolicyReport, Session, runStoreFor } from "./session.js";

export interface ManagerOptions {
	/** The clock; tests inject one to age workers without waiting. */
	now?: () => number;
	/** How often idle workers are looked for (default: a quarter of the limit, at most 60 s). */
	reaperIntervalMs?: number;
}

/** One line of an error message: no stack, no stderr dump. */
function firstLine(e: unknown): string {
	const text = e instanceof Error ? e.message : String(e);
	return text.split("\n")[0].slice(0, 300);
}

export class SessionManager {
	private sessions: Map<string, Session> = new Map();
	private readonly runtime: RuntimeDir;
	/** Every worker process of this server starts and ends here. */
	readonly children: ChildRegistry;
	private readonly providers: ProviderRegistry;
	/** Every run of every worker, kept after the worker is gone. */
	readonly runs: RunStore;
	private readonly now: () => number;
	private reaper: ReturnType<typeof setInterval> | null = null;
	private readonly reaperIntervalMs: number;

	/**
	 * Does no I/O: workers live only as long as this server, and the runtime
	 * directory is created when the first worker needs it.
	 */
	constructor(
		readonly config: Config,
		private readonly env: NodeJS.ProcessEnv = {},
		runtime?: RuntimeDir,
		options: ManagerOptions = {},
	) {
		this.runtime = runtime ?? new RuntimeDir(config.runtimeDir);
		this.children = new ChildRegistry({ env, envConfig: config.env });
		this.runs = runStoreFor(config);
		this.now = options.now ?? Date.now;
		this.reaperIntervalMs =
			options.reaperIntervalMs ??
			Math.max(1000, Math.min(60_000, config.limits.idleTimeoutMs / 4));
		this.providers = new ProviderRegistry({
			enabled: ["pi"],
			context: { config },
		});
	}

	/**
	 * The real path of a workspace, or a `CWD_NOT_ALLOWED` error: it must
	 * exist, be a directory and, when roots are configured, lie inside one
	 * (compared by real path, so a symlink cannot lead out of a root).
	 */
	public resolveCwd(cwd: string): string {
		if (!path.isAbsolute(cwd)) {
			throw new ToolError(
				"INVALID_ARGUMENT",
				"cwd must be an absolute path; give the full path of the workspace.",
			);
		}
		let real: string;
		try {
			real = fs.realpathSync(cwd);
		} catch {
			throw new ToolError(
				"CWD_NOT_ALLOWED",
				"The workspace directory does not exist; create it or give another cwd.",
			);
		}
		if (!fs.statSync(real).isDirectory()) {
			throw new ToolError(
				"CWD_NOT_ALLOWED",
				"cwd is not a directory; give the workspace directory itself.",
			);
		}
		const roots = this.config.limits.allowedRoots;
		if (roots.length > 0) {
			const inside = roots.some((root) => {
				try {
					return isInside(fs.realpathSync(root), real);
				} catch {
					return false; // a root that does not exist allows nothing
				}
			});
			if (!inside) {
				throw new ToolError(
					"CWD_NOT_ALLOWED",
					"cwd is outside the directories this server allows; use a directory inside an allowed root.",
				);
			}
		}
		return real;
	}

	public async createSession(
		name: string | undefined,
		cwd: string,
		model?: string,
		systemPrompt?: string,
		riskPolicy?: unknown,
	): Promise<Session> {
		if (name !== undefined && !WORKER_NAME_PATTERN.test(name)) {
			throw new ToolError(
				"INVALID_ARGUMENT",
				"name must be 1-64 characters from A-Z, a-z, 0-9, '_' and '-'.",
			);
		}
		if (name !== undefined && WORKER_ID_PATTERN.test(name)) {
			throw new ToolError(
				"INVALID_ARGUMENT",
				"name looks like a worker id (w_ and 8 characters); choose another name.",
			);
		}
		const realCwd = this.resolveCwd(cwd);

		let provider;
		try {
			provider = await this.providers.get("pi");
		} catch (e) {
			throw new ToolError("PROVIDER_UNAVAILABLE", firstLine(e));
		}

		// Everything from here to `sessions.set` is synchronous: nothing can
		// register a worker, or take its name or slot, in between.
		let replaced: Session | undefined;
		if (name !== undefined) {
			const existing = this.findByName(name);
			if (existing) {
				// A worker still starting is live. Only one whose process is gone
				// may be replaced.
				if (existing.isAlive() || existing.isStarting()) {
					throw new ToolError(
						"INVALID_ARGUMENT",
						`A worker named ${name} is already running; choose another name or terminate it first.`,
					);
				}
				this.sessions.delete(existing.sessionId);
				replaced = existing;
			}
		}
		const max = this.config.limits.maxWorkers;
		if (this.sessions.size >= max) {
			throw new ToolError(
				"LIMIT_REACHED",
				`${max} workers are already running (the limit); terminate one or wait for an idle one to be closed.`,
			);
		}
		let id = newWorkerId();
		while (this.sessions.has(id)) id = newWorkerId();
		const session = new Session(id, realCwd, model, systemPrompt, riskPolicy, {
			config: this.config,
			runtime: this.runtime,
			env: this.env,
			children: this.children,
			provider,
			runs: this.runs,
			name,
			now: this.now,
			onGone: (s) => {
				if (this.sessions.get(s.sessionId) === s) {
					this.sessions.delete(s.sessionId);
				}
			},
		});
		this.sessions.set(id, session);
		void replaced?.terminate();
		this.startReaper();

		try {
			await session.start();
		} catch (e) {
			// A session that never started must not hold a slot or a name.
			this.sessions.delete(id);
			const message = firstLine(e);
			throw new ToolError(
				/approval gate|gate/i.test(message)
					? "GATE_UNAVAILABLE"
					: "PROVIDER_UNAVAILABLE",
				`${message}. Check the provider and its configuration (worker-mcp --print-config), then spawn again.`,
			);
		}

		return session;
	}

	private findByName(name: string): Session | undefined {
		for (const s of this.sessions.values()) if (s.name === name) return s;
		return undefined;
	}

	/** A worker by its id or its name. */
	public getSession(ref: string): Session {
		const session =
			(WORKER_ID_PATTERN.test(ref) ? this.sessions.get(ref) : undefined) ??
			this.findByName(ref);
		if (!session) {
			throw new ToolError(
				"WORKER_NOT_FOUND",
				`No live worker ${ref}; call list_pi_sessions to see the workers, or spawn one.`,
			);
		}
		return session;
	}

	/** Every live worker. */
	public allSessions(): Session[] {
		return [...this.sessions.values()];
	}

	/** The session a run belongs to, or null once it is gone. */
	public findSessionByWorker(workerId: string): Session | null {
		return this.sessions.get(workerId) ?? null;
	}

	/** The worker holding a pending approval, or null. */
	public findSessionByApproval(approvalId: string): Session | null {
		for (const s of this.sessions.values()) {
			if (s.hasPendingApproval(approvalId)) return s;
		}
		return null;
	}

	/** Replace a worker's policy, limited to the ceiling. Reports what changed. */
	public setRiskPolicy(ref: string, riskPolicy: unknown): PolicyReport {
		return this.getSession(ref).applyRiskPolicy(riskPolicy);
	}

	public listSessions() {
		return Array.from(this.sessions.values()).map((s) => ({
			workerId: s.sessionId,
			sessionId: s.sessionId,
			name: s.name ?? null,
			cwd: s.cwd,
			status: s.status,
			pendingActions: s.pendingActions.length,
			currentRunId: s.activeRun?.id ?? null,
		}));
	}

	public async terminateSession(ref: string): Promise<void> {
		const session = this.getSession(ref);
		this.sessions.delete(session.sessionId);
		await session.terminate();
	}

	/**
	 * Close every worker that has had no run for `limits.idleTimeoutMs`. Its
	 * runs stay readable. Returns the ids closed.
	 */
	public async reapIdle(): Promise<string[]> {
		const limit = this.config.limits.idleTimeoutMs;
		const now = this.now();
		const idle = [...this.sessions.values()].filter((s) => {
			const since = s.idleSince();
			return since !== null && now - since >= limit;
		});
		for (const s of idle) this.sessions.delete(s.sessionId);
		await Promise.all(idle.map((s) => s.terminate()));
		return idle.map((s) => s.sessionId);
	}

	private startReaper(): void {
		if (this.reaper) return;
		this.reaper = setInterval(() => {
			this.reapIdle().catch((e) => {
				console.error("Idle reaper failed:", firstLine(e));
			});
		}, this.reaperIntervalMs);
		this.reaper.unref?.();
	}

	/**
	 * Terminate every worker, wait for the processes (and what they started) to
	 * be gone, and remove the runtime directory. Never rejects.
	 */
	public async terminateAll(): Promise<void> {
		if (this.reaper) clearInterval(this.reaper);
		this.reaper = null;
		const all = [...this.sessions.values()].map((s) => s.terminate("shutdown"));
		this.sessions.clear();
		await Promise.all([...all, this.children.terminateAll()]);
		this.runtime.dispose();
	}

	/** Second-signal path: SIGKILL everything now, without waiting. */
	public killAllNow(): void {
		this.children.killAllNow();
		this.runtime.dispose();
	}
}
