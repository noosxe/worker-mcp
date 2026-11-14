import { type Config } from "../config.js";
import { ChildRegistry } from "../core/child.js";
import { ProviderRegistry } from "../providers/registry.js";
import { assertValidSessionId } from "../validation.js";
import { RuntimeDir } from "./runtime-dir.js";
import { Session, type PolicyReport, type SessionStatus } from "./session.js";

export class SessionManager {
	private sessions: Map<string, Session> = new Map();
	private readonly runtime: RuntimeDir;
	/** Every worker process of this server starts and ends here. */
	readonly children: ChildRegistry;
	private readonly providers: ProviderRegistry;
	public onSessionStatusChange?: (
		sessionId: string,
		status: SessionStatus,
		message?: string,
	) => void;

	/**
	 * Does no I/O: workers live only as long as this server, and the runtime
	 * directory is created when the first worker needs it.
	 */
	constructor(
		readonly config: Config,
		private readonly env: NodeJS.ProcessEnv = {},
		runtime?: RuntimeDir,
	) {
		this.runtime = runtime ?? new RuntimeDir(config.runtimeDir);
		this.children = new ChildRegistry({ env, envConfig: config.env });
		this.providers = new ProviderRegistry({
			enabled: ["pi"],
			context: { config },
		});
	}

	public async createSession(
		sessionId: string,
		cwd: string,
		model?: string,
		systemPrompt?: string,
		riskPolicy?: unknown,
	): Promise<Session> {
		assertValidSessionId(sessionId);
		const existing = this.sessions.get(sessionId);
		if (existing) {
			// A session with no subprocess is dead however its status reads.
			const active =
				existing.isAlive() &&
				existing.status !== "FINISHED" &&
				existing.status !== "CRASHED";
			if (active) {
				throw new Error(`Session ${sessionId} already exists and is active.`);
			}
			await existing.terminate();
		}

		const provider = await this.providers.get("pi");
		const session = new Session(
			sessionId,
			cwd,
			model,
			systemPrompt,
			riskPolicy,
			{
				config: this.config,
				runtime: this.runtime,
				env: this.env,
				children: this.children,
				provider,
			},
		);
		session.onStatusChange = (sid, status, message) => {
			this.onSessionStatusChange?.(sid, status, message);
		};
		this.sessions.set(sessionId, session);

		try {
			await session.start();
		} catch (e) {
			// A session that never started still holds its id, and its status is
			// whatever it was before start() threw — often "IDLE", which reads as
			// active and makes the id permanently unusable. Roll the registration
			// back so the caller can simply retry.
			this.sessions.delete(sessionId);
			throw e;
		}

		return session;
	}

	public getSession(sessionId: string): Session {
		assertValidSessionId(sessionId);
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}
		return session;
	}

	public findSessionByTaskId(taskId: string): Session | null {
		for (const session of this.sessions.values()) {
			if (session.getActiveTaskId() === taskId) {
				return session;
			}
		}
		return null;
	}

	/** Replace a worker's policy, limited to the ceiling. Reports what changed. */
	public setRiskPolicy(sessionId: string, riskPolicy: unknown): PolicyReport {
		return this.getSession(sessionId).applyRiskPolicy(riskPolicy);
	}

	public listSessions() {
		return Array.from(this.sessions.values()).map((s) => ({
			sessionId: s.sessionId,
			cwd: s.cwd,
			status: s.status,
			pendingAction: s.pendingAction,
		}));
	}

	public async terminateSession(sessionId: string): Promise<void> {
		const session = this.getSession(sessionId);
		this.sessions.delete(sessionId);
		await session.terminate();
	}

	/**
	 * Terminate every worker, wait for the processes (and what they started) to
	 * be gone, and remove the runtime directory. Never rejects.
	 */
	public async terminateAll(): Promise<void> {
		const all = [...this.sessions.values()].map((s) => s.terminate());
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
