import * as fs from "node:fs";
import * as path from "node:path";

import { type Config } from "../config.js";
import { BootRegistry } from "../core/boots.js";
import { ChildRegistry } from "../core/child.js";
import { stderrLogger } from "../core/log.js";
import { type LoadedRecord, RunRecordStore } from "../core/run-records.js";
import { type RunStore } from "../core/run.js";
import { SandboxService, type SandboxStatus } from "../core/sandbox.js";
import { type NewWorker, WorkerStore } from "../core/worker-store.js";
import { ToolError } from "../errors.js";
import { closeAbandonedApprovals } from "../gate/abandon.js";
import { DEFAULT_AUDIT_KEEP } from "../gate/audit.js";
import { isInside } from "../gate/paths.js";
import { GateServices } from "../gate/services.js";
import { Boot, WORKER_ID_PATTERN, WORKER_NAME_PATTERN } from "../ids.js";
import { ProviderRegistry } from "../providers/registry.js";
import type { ProviderCheck, WorkerProvider } from "../providers/types.js";
import { RuntimeDir } from "./runtime-dir.js";
import { type PolicyReport, Session, runStoreFor } from "./session.js";

export interface ManagerOptions {
	/** The clock; tests inject one to age workers without waiting. */
	now?: () => number;
	/** How often idle workers are looked for (default: a quarter of the limit, at most 60 s). */
	reaperIntervalMs?: number;
	/** The server's version, for the classifiers' User-Agent. */
	version?: string;
	/** Replaces the classifiers, cache and audit file built from the config. */
	gateServices?: GateServices;
	/** Replaces the sandbox service built from the config (tests). */
	sandbox?: SandboxService;
	/** Replaces the identity of this server process (tests). */
	boot?: Boot;
	/** Replaces `limits.sessionRetentionMs` (tests). */
	sessionRetentionMs?: number;
	/** Replaces `limits.maxSessionBytes` (tests). */
	maxSessionBytes?: number;
}

/** One line of an error message: no stack, no stderr dump. */
function firstLine(e: unknown): string {
	const text = e instanceof Error ? e.message : String(e);
	return text.split("\n")[0].slice(0, 300);
}

const MAINTENANCE_MS = 10 * 60_000;

export class SessionManager {
	private sessions: Map<string, Session> = new Map();
	/** The last workers of this process that ended, and how; bounded. */
	private readonly ended = new Map<
		string,
		{ id: string; name: string | undefined; how: string }
	>();
	private readonly runtime: RuntimeDir;
	/** Every worker process of this server starts and ends here. */
	readonly children: ChildRegistry;
	/** Finds and checks bubblewrap; the check runs once. */
	readonly sandbox: SandboxService;
	private readonly providers: ProviderRegistry;
	/** Every run of every worker, kept after the worker is gone. */
	readonly runs: RunStore;
	/** This server process: its boot id, start time and id tag. */
	readonly boot: Boot;
	/** Which server processes sharing the state directory are alive. */
	private readonly boots: BootRegistry;
	/** Run records on disk; null when `persistRuns` is off. */
	private readonly records: RunRecordStore | null;
	/** Worker records and sessions on disk; null when `persistSessions` is off. */
	readonly workers: WorkerStore | null;
	/** Workers of this server whose conversation is kept (by worker id). */
	private readonly kept = new Set<string>();
	private readonly providerVersions = new Map<
		string,
		Promise<string | undefined>
	>();
	private sessionWarned = false;
	private bootRegistered: boolean | null = null;
	private started = false;
	private maintenance: ReturnType<typeof setInterval> | null = null;
	private readonly now: () => number;
	private reaper: ReturnType<typeof setInterval> | null = null;
	/** Shared by every worker's gate. */
	readonly gate: GateServices;
	private readonly changeListeners = new Set<() => void>();
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
		this.runtime =
			runtime ?? new RuntimeDir(config.runtimeDir, process.pid, stderrLogger);
		this.sandbox = options.sandbox ?? new SandboxService(config.sandbox, env);
		this.children = new ChildRegistry({
			env,
			envConfig: config.env,
			sandbox: this.sandbox,
			stateDir: config.stateDir,
		});
		this.boot = options.boot ?? new Boot(options.now);
		this.boots = new BootRegistry(
			path.join(config.stateDir, "boots"),
			this.boot.id,
			process.pid,
			stderrLogger,
		);
		this.records = config.persistRuns
			? new RunRecordStore({
					dir: path.join(config.stateDir, "runs"),
					bootId: this.boot.id,
					boots: this.boots,
					retentionMs: config.limits.recordRetentionMs,
					maxRecords: config.limits.maxRecordedRuns,
					log: stderrLogger,
					now: options.now,
				})
			: null;
		this.workers = config.persistSessions
			? new WorkerStore({
					dir: path.join(config.stateDir, "workers"),
					bootId: this.boot.id,
					boots: this.boots,
					retentionMs:
						options.sessionRetentionMs ?? config.limits.sessionRetentionMs,
					maxBytes: options.maxSessionBytes ?? config.limits.maxSessionBytes,
					log: stderrLogger,
					now: options.now,
				})
			: null;
		const records = this.records;
		this.runs = runStoreFor(config, this.boot, {
			save: (run) => {
				// A record is only written once this boot is marked as live,
				// or another server would take its runs for dead ones.
				if (records && this.ensureBootRegistered()) records.save(run);
				// The agent has written to its session by now: make it private,
				// and note the activity for retention.
				if (this.kept.has(run.workerId)) {
					this.workers?.tighten(run.workerId);
					this.workers?.touch(run.workerId);
				}
			},
		});
		// Throws a ConfigError when a classifier's token file is unusable.
		this.gate =
			options.gateServices ??
			new GateServices(config, { version: options.version });
		this.now = options.now ?? Date.now;
		this.reaperIntervalMs =
			options.reaperIntervalMs ??
			Math.max(1000, Math.min(60_000, config.limits.idleTimeoutMs / 4));
		this.providers = new ProviderRegistry({
			enabled: ["pi"],
			context: { config },
		});
	}

	/** Mark this server as live in the state directory; false (once warned) when that fails. */
	private ensureBootRegistered(): boolean {
		if (this.bootRegistered !== null) return this.bootRegistered;
		try {
			this.boots.register();
			this.bootRegistered = true;
		} catch (e) {
			this.bootRegistered = false;
			stderrLogger.warn(
				`worker-mcp: cannot record this server in ${this.boots.dir}: ${firstLine(e)}. Run records and the close-out of abandoned approvals are off for this process.`,
			);
		}
		return this.bootRegistered;
	}

	/**
	 * What an earlier server left behind: runs it did not finish become
	 * `interrupted`, approvals it never answered are closed as abandoned in the
	 * audit log, and old records are pruned (again every ten minutes). Never
	 * throws; safe to call more than once.
	 */
	public start(): void {
		if (this.started) return;
		this.started = true;
		if (!this.ensureBootRegistered()) return;
		try {
			this.records?.recoverInterrupted();
			this.records?.prune();
			this.workers?.prune();
		} catch (e) {
			stderrLogger.warn(
				`worker-mcp: run records not recovered: ${firstLine(e)}`,
			);
		}
		const audit = this.gate.audit;
		if (audit) {
			try {
				closeAbandonedApprovals({
					file: this.config.audit.file,
					keep: DEFAULT_AUDIT_KEEP,
					bootId: this.boot.id,
					isLive: (id) => this.boots.isLive(id),
					audit,
				});
			} catch (e) {
				stderrLogger.warn(
					`worker-mcp: abandoned approvals not closed: ${firstLine(e)}`,
				);
			}
		}
		this.maintenance = setInterval(() => {
			try {
				this.boots.sweep();
				this.records?.recoverInterrupted();
				this.records?.prune();
				this.workers?.prune();
			} catch (e) {
				stderrLogger.warn(`worker-mcp: record upkeep failed: ${firstLine(e)}`);
			}
		}, MAINTENANCE_MS);
		this.maintenance.unref?.();
	}

	/** Whether run records are written (the setting is on). */
	public get persistsRuns(): boolean {
		return this.records !== null;
	}

	/** The saved record of a run, or null: records are off, or none exists. */
	public readRecord(runId: string): LoadedRecord | null {
		if (!this.records) return null;
		try {
			return this.records.load(runId);
		} catch (e) {
			stderrLogger.warn(`worker-mcp: run record not read: ${firstLine(e)}`);
			return null;
		}
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
		providerId?: string,
		sandbox?: "none" | "workspace",
		persistSession?: boolean,
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

		if (
			providerId !== undefined &&
			!this.providers.ids().includes(providerId)
		) {
			throw new ToolError(
				"INVALID_ARGUMENT",
				`provider ${providerId} is not available. Use one of: ${this.providers.ids().join(", ")} (list_providers shows them).`,
			);
		}
		let provider;
		try {
			provider = await this.providers.get(providerId);
		} catch (e) {
			throw new ToolError("PROVIDER_UNAVAILABLE", firstLine(e));
		}

		// The check runs once and is cached; it must be done before the worker
		// is registered, so nothing below this line awaits.
		const sandboxStatus = await this.sandbox.status();
		const decided = this.sandbox.resolveMode(sandbox, sandboxStatus.available);
		if (decided.mode === "workspace" && !sandboxStatus.available) {
			throw new ToolError(
				"SANDBOX_UNAVAILABLE",
				`The workspace sandbox is required (sandbox.minimum is workspace) but ${sandboxStatus.reason ?? "is not available"}. Fix that, or lower sandbox.minimum to none if running without a sandbox is acceptable.`,
			);
		}

		let toolIsolation = false;
		const notes = [...decided.notes];
		if (decided.mode === "workspace") {
			const iso = this.sandbox.resolveToolIsolation(sandboxStatus);
			if (iso.error) throw new ToolError("SANDBOX_UNAVAILABLE", iso.error);
			toolIsolation = iso.active;
			if (iso.note) notes.push(iso.note);
		}

		// A worker's conversation is kept when the server keeps them and the
		// caller did not say no (it can turn it off, never on). The provider
		// version is looked up first: nothing below this line awaits.
		const wantsSession =
			this.workers !== null &&
			persistSession !== false &&
			provider.sessionProfile?.needsDir === true;
		const providerVersion = wantsSession
			? await this.providerVersion(provider)
			: undefined;

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
		let id = this.boot.workerId();
		while (this.sessions.has(id)) id = this.boot.workerId();
		const keep = wantsSession
			? this.keepSession(id, {
					name,
					provider: provider.id,
					providerVersion,
					model: model ?? this.defaultModel(provider.id),
					cwd: realCwd,
					sandbox: { requested: sandbox, applied: decided.mode },
					toolIsolation,
					policy: riskPolicy,
					systemPromptChars: systemPrompt?.length,
				})
			: null;
		const session = new Session(
			id,
			realCwd,
			model ?? this.defaultModel(provider.id),
			systemPrompt,
			riskPolicy,
			{
				config: this.config,
				runtime: this.runtime,
				env: this.env,
				children: this.children,
				provider,
				sandbox: decided.mode,
				sandboxReport: { clamped: decided.clamped, notes },
				toolIsolation,
				session: keep ? { dir: keep.sessionDir, id } : undefined,
				runs: this.runs,
				boot: this.boot,
				gateServices: this.gate,
				name,
				now: this.now,
				onGone: (s) => {
					// The process is gone: the session stays for a later resume.
					this.releaseKept(s.sessionId);
					if (this.sessions.get(s.sessionId) === s) {
						this.sessions.delete(s.sessionId);
						this.noteEnded(s, "its process exited and it was dropped");
						this.changed();
					}
				},
			},
		);
		this.sessions.set(id, session);
		if (replaced) {
			const old = replaced;
			void old.terminate().then(() => this.releaseKept(old.sessionId));
		}
		this.startReaper();

		try {
			await session.start();
		} catch (e) {
			// A session that never started must not hold a slot or a name, and
			// has nothing worth keeping.
			this.sessions.delete(id);
			// (its process may already have been reported gone, which released it)
			this.kept.delete(id);
			if (keep) this.workers?.remove(id);
			const message = firstLine(e);
			this.changed();
			throw new ToolError(
				/approval gate|gate/i.test(message)
					? "GATE_UNAVAILABLE"
					: "PROVIDER_UNAVAILABLE",
				`${message}. Check the provider and its configuration (worker-mcp --print-config), then spawn again.`,
			);
		}

		const pid = session.processIds()[0];
		if (keep && pid !== undefined) this.workers?.setOwnerPid(id, pid);
		this.changed();
		return session;
	}

	/** The provider's version, looked up once. */
	private providerVersion(
		provider: WorkerProvider,
	): Promise<string | undefined> {
		let found = this.providerVersions.get(provider.id);
		if (!found) {
			found = provider
				.check(this.config)
				.then((c) => (c.available ? c.version : undefined))
				.catch(() => undefined);
			this.providerVersions.set(provider.id, found);
		}
		return found;
	}

	/**
	 * Make the directories, the owner claim and the record of a worker whose
	 * conversation is kept. A failure is reported once and the worker runs
	 * without a session: keeping it is never a reason to refuse a spawn.
	 */
	private keepSession(
		lineage: string,
		info: Omit<NewWorker, "lineage">,
	): { sessionDir: string } | null {
		const store = this.workers;
		if (!store) return null;
		try {
			// The owner claim is only honoured by other servers once this boot is live.
			if (!this.ensureBootRegistered()) {
				throw new Error("this server could not be recorded as running");
			}
			const layout = store.create({ ...info, lineage });
			this.kept.add(lineage);
			return { sessionDir: layout.sessionDir };
		} catch (e) {
			if (!this.sessionWarned) {
				this.sessionWarned = true;
				stderrLogger.warn(
					`worker-mcp: cannot keep sessions under ${store.dir}: ${firstLine(e)}. Workers run without a session file (not resumable).`,
				);
			}
			return null;
		}
	}

	/** The process of a kept worker is gone: give up the claim, keep the session. */
	private releaseKept(id: string): void {
		if (this.kept.delete(id)) this.workers?.release(id);
	}

	/** Delete a kept worker's session and record. */
	private dropKept(id: string): void {
		if (this.kept.delete(id)) this.workers?.remove(id);
	}

	/** Called when a worker is added or removed (resource list changes). */
	public onWorkersChanged(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => {
			this.changeListeners.delete(listener);
		};
	}

	private changed(): void {
		for (const l of this.changeListeners) {
			try {
				l();
			} catch {
				// a listener must never break the manager
			}
		}
	}

	/** The model a worker of this provider gets when `spawn_worker` names none. */
	public defaultModel(providerId: string): string | undefined {
		return providerId === "pi"
			? this.config.providers.pi.defaultModel
			: undefined;
	}

	/** Whether the workspace sandbox works here, checked once. */
	public sandboxStatus(): Promise<SandboxStatus> {
		return this.sandbox.status();
	}

	/** Ids of the providers a spawn may name; the first is the default. */
	public providerIds(): string[] {
		return this.providers.ids();
	}

	/** Whether each enabled provider can be used now. No model calls. */
	public async checkProviders(): Promise<
		{ id: string; provider: WorkerProvider | null; check: ProviderCheck }[]
	> {
		return await Promise.all(
			this.providers.ids().map(async (id) => {
				try {
					const provider = await this.providers.get(id);
					const check = await provider.check(this.config);
					return { id, provider, check };
				} catch (e) {
					return {
						id,
						provider: null,
						check: { available: false, reason: firstLine(e) },
					};
				}
			}),
		);
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
		if (!session)
			throw new ToolError("WORKER_NOT_FOUND", this.missingWorker(ref));
		return session;
	}

	/** Which server process this is, for `list_providers` and `list_workers`. */
	public serverInfo(): { bootId: string; startedAt: string } {
		return { bootId: this.boot.id, startedAt: this.boot.startedAtIso };
	}

	/** Why a worker is not here, for the caller to act on. */
	private missingWorker(ref: string): string {
		const isId = WORKER_ID_PATTERN.test(ref);
		if (isId && this.boot.madeByEarlierServer("worker", ref)) {
			return this.boot.notIssuedHere(`Worker ${ref}`);
		}
		// The newest match wins: a name can have been used more than once.
		let gone: { id: string; name: string | undefined; how: string } | undefined;
		for (const e of this.ended.values()) {
			if (isId ? e.id === ref : e.name === ref) gone = e;
		}
		if (gone) {
			const last = this.runs.runsOf(gone.id).at(-1);
			const runs = last
				? ` Its runs can still be read with get_run (the latest is ${last.id}, ${last.state}).`
				: "";
			return `Worker ${ref} (${gone.id}) is no longer running: ${gone.how}.${runs} Spawn a new worker to continue.`;
		}
		if (isId) {
			return `No worker ${ref} here: it was closed long ago or never existed. Call list_workers to see the workers, or spawn one.`;
		}
		// A name says nothing about when it was made, so a restart is a possible cause.
		return `No live worker named ${ref}; call list_workers to see the workers, or spawn one. If it was spawned before the server restarted (this server started ${this.boot.startedAtIso}, boot ${this.boot.id}), it is lost: ${this.boot.restartNote()}`;
	}

	/** Remember, for a while, that a worker ended and how, so errors can say so. */
	private noteEnded(session: Session, how: string): void {
		this.ended.set(session.sessionId, {
			id: session.sessionId,
			name: session.name,
			how,
		});
		if (this.ended.size > 100) {
			const oldest = this.ended.keys().next().value;
			if (oldest !== undefined) this.ended.delete(oldest);
		}
	}

	/** An id the caller gave for a run or an approval, which this server does not know. */
	public missingId(kind: "run" | "approval", id: string): string | null {
		if (!this.boot.madeByEarlierServer(kind, id)) return null;
		const what = kind === "run" ? `Run ${id}` : `Approval ${id}`;
		const tail =
			kind === "run" && this.records
				? " get_run (or wait_run) can still read how it ended, if its record was kept."
				: "";
		return `${this.boot.notIssuedHere(what)}${tail}`;
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
		this.noteEnded(session, "it was terminated");
		this.changed();
		await session.terminate();
		// An explicit end means done: the conversation goes with it.
		this.dropKept(session.sessionId);
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
		for (const s of idle) {
			this.sessions.delete(s.sessionId);
			this.noteEnded(s, "it was closed after being idle");
		}
		if (idle.length > 0) this.changed();
		await Promise.all(idle.map((s) => s.terminate()));
		// Closed for being idle: the session is kept.
		for (const s of idle) this.releaseKept(s.sessionId);
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
		if (this.maintenance) clearInterval(this.maintenance);
		this.maintenance = null;
		const all = [...this.sessions.values()].map((s) => s.terminate("shutdown"));
		const ids = [...this.sessions.keys()];
		this.sessions.clear();
		await Promise.all([...all, this.children.terminateAll()]);
		for (const id of ids) this.releaseKept(id);
		this.runtime.dispose();
		this.boots.unregister();
	}

	/** Whether the audit log file could not be written. */
	public get auditDegraded(): boolean {
		return this.gate.auditDegraded;
	}

	/** SIGHUP: read the classifiers' token files again. */
	public reloadTokens(): { reloaded: number; failed: number } {
		return this.gate.reloadTokens();
	}

	/** Second-signal path: SIGKILL everything now, without waiting. */
	public killAllNow(): void {
		this.children.killAllNow();
		this.runtime.dispose();
		this.boots.unregister();
	}
}
