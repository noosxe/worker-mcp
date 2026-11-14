import { type Config } from "../config.js";
import { assertValidSessionId } from "../validation.js";
import { PiSession, type SessionStatus } from "./pi-session.js";
import type { RiskPolicy } from "./risk-policy.js";
import { RuntimeDir } from "./runtime-dir.js";

export class SessionManager {
	private sessions: Map<string, PiSession> = new Map();
	private readonly runtime: RuntimeDir;
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
	}

	public async createSession(
		sessionId: string,
		cwd: string,
		model?: string,
		systemPrompt?: string,
		riskPolicy?: RiskPolicy,
	): Promise<PiSession> {
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
			existing.terminate();
		}

		const session = new PiSession(
			sessionId,
			cwd,
			model,
			systemPrompt,
			riskPolicy,
			{ config: this.config, runtime: this.runtime, env: this.env },
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

	public getSession(sessionId: string): PiSession {
		assertValidSessionId(sessionId);
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}
		return session;
	}

	public findSessionByTaskId(taskId: string): PiSession | null {
		for (const session of this.sessions.values()) {
			if (session.getActiveTaskId() === taskId) {
				return session;
			}
		}
		return null;
	}

	public setRiskPolicy(sessionId: string, riskPolicy: RiskPolicy) {
		const session = this.getSession(sessionId);
		session.riskPolicy = riskPolicy;
	}

	public listSessions() {
		return Array.from(this.sessions.values()).map((s) => ({
			sessionId: s.sessionId,
			cwd: s.cwd,
			status: s.status,
			pendingAction: s.pendingAction,
		}));
	}

	public terminateSession(sessionId: string) {
		const session = this.getSession(sessionId);
		session.terminate();
		this.sessions.delete(sessionId);
	}

	/** Terminate every worker and remove the runtime directory. */
	public terminateAll() {
		for (const session of this.sessions.values()) {
			session.terminate();
		}
		this.runtime.dispose();
	}
}
