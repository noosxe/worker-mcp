import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PiSession, SessionStatus } from "./pi-session.js";
import type { RiskPolicy } from "./risk-policy.js";

interface SessionRegistryEntry {
	sessionId: string;
	cwd: string;
	model?: string;
	systemPrompt?: string;
	riskPolicy?: RiskPolicy;
}

export class SessionManager {
	private sessions: Map<string, PiSession> = new Map();
	private registryPath: string;
	public onSessionStatusChange?: (sessionId: string, status: SessionStatus, message?: string) => void;

	constructor() {
		const homeDir = os.homedir();
		this.registryPath = path.join(
			homeDir,
			".config",
			"worker-mcp",
			"sessions.json",
		);

		this.ensureRegistryDirectory();
		this.deployGatingExtension();
		this.loadRegistry();
	}

	private ensureRegistryDirectory() {
		const dir = path.dirname(this.registryPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}

	private static readonly GATE_EXTENSION_VERSION = "2";

	private deployGatingExtension() {
		const dir = path.dirname(this.registryPath);

		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		const extensionPath = path.join(dir, "worker-mcp-gate.ts");

		const extensionCode = `// Gating extension for worker-mcp (v${SessionManager.GATE_EXTENSION_VERSION})
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

		// Write if missing or if version has changed
		let shouldWrite = !fs.existsSync(extensionPath);
		if (!shouldWrite) {
			try {
				const existing = fs.readFileSync(extensionPath, "utf8");
				if (!existing.includes(`(v${SessionManager.GATE_EXTENSION_VERSION})`)) {
					shouldWrite = true;
				}
			} catch {
				shouldWrite = true;
			}
		}

		if (shouldWrite) {
			fs.writeFileSync(extensionPath, extensionCode, "utf8");
			console.error(
				`Deployed supervisor gating extension v${SessionManager.GATE_EXTENSION_VERSION} to: ${extensionPath}`,
			);
		}

		// Clean up the old gating extension path if it exists to avoid breaking standalone pi runs
		const homeDir = os.homedir();
		const oldExtensionPath = path.join(
			homeDir,
			".pi",
			"agent",
			"extensions",
			"worker-mcp-gate.ts",
		);
		if (fs.existsSync(oldExtensionPath)) {
			try {
				fs.unlinkSync(oldExtensionPath);
				console.error(
					`Cleaned up old supervisor gating extension from: ${oldExtensionPath}`,
				);
			} catch (e) {
				console.error(
					`Failed to clean up old extension at ${oldExtensionPath}: ${e}`,
				);
			}
		}
	}

	private loadRegistry() {
		if (!fs.existsSync(this.registryPath)) {
			this.saveRegistry();
			return;
		}

		try {
			const content = fs.readFileSync(this.registryPath, "utf8");
			const entries: SessionRegistryEntry[] = JSON.parse(content);

			for (const entry of entries) {
				// Create session in FINISHED state because the process is not running yet
				const session = new PiSession(
					entry.sessionId,
					entry.cwd,
					entry.model,
					entry.systemPrompt,
					entry.riskPolicy,
				);
				session.status = "FINISHED";
				session.onStatusChange = (sid, status, message) => {
					this.onSessionStatusChange?.(sid, status, message);
				};
				this.sessions.set(entry.sessionId, session);
			}
			console.error(`Loaded ${entries.length} sessions from registry.`);
		} catch (e) {
			console.error(`Failed to load session registry: ${e}`);
		}
	}

	private saveRegistry() {
		try {
			const entries: SessionRegistryEntry[] = Array.from(
				this.sessions.values(),
			).map((s) => ({
				sessionId: s.sessionId,
				cwd: s.cwd,
				model: s.model,
				systemPrompt: s.systemPrompt,
				riskPolicy: s.riskPolicy,
			}));

			fs.writeFileSync(
				this.registryPath,
				JSON.stringify(entries, null, 2),
				"utf8",
			);
		} catch (e) {
			console.error(`Failed to save session registry: ${e}`);
		}
	}

	public async createSession(
		sessionId: string,
		cwd: string,
		model?: string,
		systemPrompt?: string,
		riskPolicy?: RiskPolicy,
	): Promise<PiSession> {
		const existing = this.sessions.get(sessionId);
		if (existing) {
			// A session with no subprocess is dead however its status reads —
			// sessions restored from the registry have never been started at all.
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
		);
		session.onStatusChange = (sid, status, message) => {
			this.onSessionStatusChange?.(sid, status, message);
		};
		this.sessions.set(sessionId, session);
		this.saveRegistry();

		try {
			await session.start();
		} catch (e) {
			// A session that never started still holds its id, and its status is
			// whatever it was before start() threw — often "IDLE", which reads as
			// active and makes the id permanently unusable. Roll the registration
			// back so the caller can simply retry.
			this.sessions.delete(sessionId);
			this.saveRegistry();
			throw e;
		}

		return session;
	}

	public getSession(sessionId: string): PiSession {
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
		this.saveRegistry();
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
		this.saveRegistry();
	}

	public terminateAll() {
		for (const session of this.sessions.values()) {
			session.terminate();
		}
	}
}
