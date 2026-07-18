import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PiSession } from "./pi-session.js";

interface SessionRegistryEntry {
	sessionId: string;
	cwd: string;
	model?: string;
	systemPrompt?: string;
}

export class SessionManager {
	private sessions: Map<string, PiSession> = new Map();
	private registryPath: string;

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

	private deployGatingExtension() {
		const homeDir = os.homedir();
		const extensionsDir = path.join(homeDir, ".pi", "agent", "extensions");

		if (!fs.existsSync(extensionsDir)) {
			fs.mkdirSync(extensionsDir, { recursive: true });
		}

		const extensionPath = path.join(extensionsDir, "worker-mcp-gate.ts");

		const extensionCode = `// Gating extension for worker-mcp
// Intercepts all tool execution requests and prompts the coordinator for approval.

export default function(pi: any) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    // Invoke the confirm dialog which streams RpcExtensionUIRequest over RPC
    const approved = await ctx.ui.confirm(
      "Allow Tool Execution",
      \`Allow the "\${event.toolName}" tool to run with arguments: \${JSON.stringify(event.input)}?\`
    );
    if (!approved) {
      return { block: true, reason: "Tool execution blocked by the coordinator agent." };
    }
  });
}
`;

		// Only write if it doesn't exist, to allow users to customize it if they want
		if (!fs.existsSync(extensionPath)) {
			fs.writeFileSync(extensionPath, extensionCode, "utf8");
			console.error(
				`Deployed supervisor gating extension to: ${extensionPath}`,
			);
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
				);
				session.status = "FINISHED";
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
	): Promise<PiSession> {
		const existing = this.sessions.get(sessionId);
		if (existing) {
			if (existing.status !== "FINISHED" && existing.status !== "CRASHED") {
				throw new Error(`Session ${sessionId} already exists and is active.`);
			}
			existing.terminate();
		}

		const session = new PiSession(sessionId, cwd, model, systemPrompt);
		this.sessions.set(sessionId, session);
		this.saveRegistry();

		await session.start();
		return session;
	}

	public getSession(sessionId: string): PiSession {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}
		return session;
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
