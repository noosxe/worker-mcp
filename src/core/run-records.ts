import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { z } from "zod";

import type { BootRegistry } from "./boots.js";
import { type Logger, noopLogger } from "./log.js";
import {
	ensurePrivateDir,
	readPrivateFile,
	writeFileAtomic,
} from "./private-dir.js";
import { isTerminal, OutputBuffer, Run, type RunSink } from "./run.js";

/**
 * Run records: one small JSON file per run under `<stateDir>/runs`, written
 * when the run starts and whenever its state changes, so what happened to a
 * run can be read after the server that ran it is gone.
 *
 * A record holds metadata, the worker's text so far (what `get_run` already
 * shows), the usage and how each approval ended. It never holds the prompt (only
 * its length and a digest, because it may carry secrets), tool inputs, or
 * commands.
 */

export const RUN_RECORD_VERSION = 1;
const RUN_ID = /^r_[A-Za-z0-9]{10,32}$/;
/** Larger files are not read: they are not ours. */
const MAX_RECORD_BYTES = 64 * 1024 * 1024;

const STATES = [
	"starting",
	"running",
	"awaiting_approval",
	"completed",
	"failed",
	"cancelled",
	"timed_out",
	"interrupted",
] as const;

const approvalSchema = z.object({
	approvalId: z.string().max(64),
	tool: z.string().max(200),
	riskLabel: z.string().max(64).optional(),
	decision: z.enum([
		"pending",
		"approved",
		"rejected",
		"expired",
		"cancelled",
		"abandoned",
	]),
	decidedBy: z.string().max(64).optional(),
	askedAt: z.string().max(40),
	decidedAt: z.string().max(40).optional(),
});

export const runRecordSchema = z.object({
	version: z.literal(RUN_RECORD_VERSION),
	runId: z.string().regex(RUN_ID),
	/** The server process that ran it. */
	bootId: z.string().regex(/^[a-z0-9]{12}$/),
	workerId: z.string().max(64),
	workerName: z.string().max(64).optional(),
	provider: z.string().max(64).optional(),
	model: z.string().max(200).optional(),
	cwd: z.string().max(4096).optional(),
	/** The kept conversation the worker belonged to, when sessions were kept. */
	lineage: z.string().max(64).optional(),
	intent: z.string().max(1000).optional(),
	promptChars: z.number().int().min(0),
	/** sha256 of the prompt, so a record can be matched to one without holding it. */
	promptSha256: z.string().max(64),
	createdAt: z.string().max(40),
	updatedAt: z.string().max(40),
	startedAt: z.string().max(40).optional(),
	endedAt: z.string().max(40).optional(),
	state: z.enum(STATES),
	error: z.string().max(10_000).optional(),
	finalText: z.string(),
	/** Characters the run produced, including any dropped from the front. */
	outputTotalChars: z.number().int().min(0),
	usage: z
		.object({
			inputTokens: z.number().optional(),
			outputTokens: z.number().optional(),
			costUsd: z.number().optional(),
		})
		.optional(),
	gate: z.object({
		autoAllowed: z.number().int(),
		autoDenied: z.number().int(),
		escalated: z.number().int(),
	}),
	approvals: z.array(approvalSchema).max(1000),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

const iso = (ms: number | undefined): string | undefined =>
	ms === undefined ? undefined : new Date(ms).toISOString();

export function recordOf(run: Run, bootId: string, now: number): RunRecord {
	return {
		version: RUN_RECORD_VERSION,
		runId: run.id,
		bootId,
		workerId: run.workerId,
		workerName: run.meta.workerName,
		provider: run.meta.provider,
		model: run.meta.model,
		cwd: run.meta.cwd,
		lineage: run.meta.lineage,
		intent: run.intent?.slice(0, 1000),
		promptChars: run.prompt.length,
		promptSha256: createHash("sha256").update(run.prompt).digest("hex"),
		createdAt: new Date(run.createdAt).toISOString(),
		updatedAt: new Date(now).toISOString(),
		startedAt: iso(run.startedAt),
		endedAt: iso(run.endedAt),
		state: run.state,
		error: run.error?.slice(0, 10_000),
		finalText: run.output.all,
		outputTotalChars: run.output.total,
		usage: run.usage,
		gate: {
			autoAllowed: run.gate.autoAllowed,
			autoDenied: run.gate.autoDenied,
			escalated: run.gate.escalated,
		},
		approvals: run.approvalLog.slice(-1000).map((a) => ({
			approvalId: a.approvalId,
			tool: a.tool,
			riskLabel: a.riskLabel,
			decision: a.decision,
			decidedBy: a.decidedBy,
			askedAt: new Date(a.askedAt).toISOString(),
			decidedAt: iso(a.decidedAt),
		})),
	};
}

/** A run rebuilt from a record, for the ordinary run views. It is never live. */
export function runFromRecord(rec: RunRecord): Run {
	const created = Date.parse(rec.createdAt);
	const run = new Run(
		rec.runId,
		rec.workerId,
		"",
		rec.intent,
		Number.isNaN(created) ? 0 : created,
		1,
		OutputBuffer.restore(rec.finalText, rec.outputTotalChars),
	);
	run.state = rec.state;
	run.error = rec.error;
	run.usage = rec.usage;
	const ended = rec.endedAt ? Date.parse(rec.endedAt) : NaN;
	run.endedAt = Number.isNaN(ended)
		? Date.parse(rec.updatedAt) || run.createdAt
		: ended;
	run.gate.autoAllowed = rec.gate.autoAllowed;
	run.gate.autoDenied = rec.gate.autoDenied;
	run.gate.escalated = rec.gate.escalated;
	run.meta = {
		workerName: rec.workerName,
		provider: rec.provider,
		model: rec.model,
		cwd: rec.cwd,
		lineage: rec.lineage,
	};
	return run;
}

export interface RunRecordStoreOptions {
	/** `<stateDir>/runs`. */
	dir: string;
	bootId: string;
	boots: BootRegistry;
	retentionMs: number;
	maxRecords: number;
	log?: Logger;
	now?: () => number;
}

export interface LoadedRecord {
	record: RunRecord;
	/** Another server process made it (this one did not). */
	fromEarlierServer: boolean;
	/** That server is still running. */
	serverRunning: boolean;
}

/**
 * Writes and reads run records. Nothing here throws to the caller: a failed
 * write is reported once and the run goes on in memory; an unreadable record
 * is skipped with a warning that names the file but never its content.
 */
export class RunRecordStore implements RunSink {
	private ready = false;
	private writeWarned = false;
	private readonly warned = new Set<string>();
	private readonly log: Logger;
	private readonly now: () => number;
	/** Set when the records could not be set up or written. */
	degraded = false;

	constructor(private readonly opts: RunRecordStoreOptions) {
		this.log = opts.log ?? noopLogger;
		this.now = opts.now ?? Date.now;
	}

	get dir(): string {
		return this.opts.dir;
	}

	private fileOf(runId: string): string | null {
		return RUN_ID.test(runId)
			? path.join(this.opts.dir, `${runId}.json`)
			: null;
	}

	private ensure(): void {
		if (this.ready) {
			// A directory deleted under a live server is made again.
			if (fs.existsSync(this.opts.dir)) return;
			this.ready = false;
		}
		ensurePrivateDir(this.opts.dir);
		this.ready = true;
	}

	/** Write the run's record. Never throws. */
	save(run: Run): void {
		try {
			this.ensure();
			const file = this.fileOf(run.id);
			if (!file) return;
			const rec = recordOf(run, this.opts.bootId, this.now());
			this.write(file, rec);
			this.degraded = false;
		} catch (e) {
			this.degraded = true;
			if (!this.writeWarned) {
				this.writeWarned = true;
				this.log.warn(
					`worker-mcp: cannot write run records under ${this.opts.dir}: ${describe(e)}. Runs continue in memory; get_run will not find them after a restart.`,
				);
			}
		}
	}

	private write(file: string, rec: RunRecord): void {
		const tmp = path.join(
			this.opts.dir,
			`.${path.basename(file, ".json")}.${randomBytes(4).toString("hex")}.tmp`,
		);
		writeFileAtomic(file, `${JSON.stringify(rec)}\n`, tmp);
	}

	private warnOnce(file: string, why: string): void {
		const name = path.basename(file);
		if (this.warned.has(name)) return;
		this.warned.add(name);
		this.log.warn(`worker-mcp: skipping run record ${name}: ${why}.`);
	}

	/** Read one record file; null (and one warning) when unusable. */
	private read(file: string): RunRecord | null {
		let text: string | null;
		try {
			text = readPrivateFile(file, MAX_RECORD_BYTES);
		} catch (e) {
			this.warnOnce(file, `unreadable (${describe(e)})`);
			return null;
		}
		if (text === null) return null;
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			this.warnOnce(file, "not valid JSON");
			return null;
		}
		const parsed = runRecordSchema.safeParse(json);
		if (!parsed.success) {
			const fields = [
				...new Set(parsed.error.issues.map((i) => i.path.join("."))),
			]
				.slice(0, 5)
				.join(", ");
			this.warnOnce(file, `does not match the record format (${fields})`);
			return null;
		}
		return parsed.data;
	}

	/**
	 * The record of `runId`, as it should be shown: one left in a non-terminal
	 * state by a server that is gone is shown (and saved) as `interrupted`.
	 */
	load(runId: string): LoadedRecord | null {
		const file = this.fileOf(runId);
		if (!file) return null;
		const rec = this.read(file);
		if (!rec || rec.runId !== runId) return null;
		const fromEarlierServer = rec.bootId !== this.opts.bootId;
		const live = !fromEarlierServer || this.opts.boots.isLive(rec.bootId);
		if (fromEarlierServer && !live && !isTerminal(rec.state)) {
			return {
				record: this.interrupt(file, rec),
				fromEarlierServer,
				serverRunning: false,
			};
		}
		return { record: rec, fromEarlierServer, serverRunning: live };
	}

	private interrupt(file: string, rec: RunRecord): RunRecord {
		const at = new Date(this.now()).toISOString();
		const out: RunRecord = {
			...rec,
			state: "interrupted",
			updatedAt: at,
			endedAt: rec.endedAt ?? rec.updatedAt,
			error: `the server stopped while this run was in progress (boot ${rec.bootId}); what the worker did before that is in the workspace`,
			approvals: rec.approvals.map((a) =>
				a.decision === "pending"
					? { ...a, decision: "abandoned", decidedBy: "server", decidedAt: at }
					: a,
			),
		};
		try {
			this.ensure();
			this.write(file, out);
		} catch (e) {
			this.warnOnce(
				file,
				`could not be rewritten as interrupted (${describe(e)})`,
			);
		}
		return out;
	}

	private files(): string[] {
		try {
			return fs.readdirSync(this.opts.dir);
		} catch {
			return [];
		}
	}

	/**
	 * Mark every record left in progress by a server that is gone as
	 * `interrupted`. A record of a live server (another client on the same
	 * state directory) is left alone. Returns how many were changed.
	 */
	recoverInterrupted(): number {
		let changed = 0;
		for (const name of this.files()) {
			const id = name.endsWith(".json") ? name.slice(0, -5) : null;
			if (id === null || !RUN_ID.test(id)) continue;
			const file = path.join(this.opts.dir, name);
			const rec = this.read(file);
			if (!rec || isTerminal(rec.state)) continue;
			if (rec.bootId === this.opts.bootId || this.opts.boots.isLive(rec.bootId))
				continue;
			this.interrupt(file, rec);
			changed++;
		}
		return changed;
	}

	/**
	 * Delete records past the age or the count limit, oldest first, and
	 * leftover temporary files. A record still in progress in a live server is
	 * never deleted. Returns how many were removed.
	 */
	prune(): number {
		const now = this.now();
		const entries: { file: string; mtime: number; id: string }[] = [];
		for (const name of this.files()) {
			const file = path.join(this.opts.dir, name);
			if (name.endsWith(".tmp")) {
				try {
					if (now - fs.lstatSync(file).mtimeMs > 3_600_000) {
						fs.rmSync(file, { force: true });
					}
				} catch {
					// gone already
				}
				continue;
			}
			const id = name.endsWith(".json") ? name.slice(0, -5) : null;
			if (id === null || !RUN_ID.test(id)) continue;
			try {
				const st = fs.lstatSync(file);
				if (st.isFile()) entries.push({ file, mtime: st.mtimeMs, id });
			} catch {
				// gone already
			}
		}
		entries.sort((a, b) => a.mtime - b.mtime);
		const excess = Math.max(0, entries.length - this.opts.maxRecords);
		let removed = 0;
		entries.forEach((e, i) => {
			const old = now - e.mtime >= this.opts.retentionMs;
			if (!old && i >= excess) return;
			if (this.inProgressElsewhere(e.file)) return;
			try {
				fs.rmSync(e.file, { force: true });
				removed++;
			} catch {
				// not removable now; next time
			}
		});
		return removed;
	}

	/** A record that a running server (this one or another) is still writing. */
	private inProgressElsewhere(file: string): boolean {
		const rec = this.read(file);
		return (
			rec !== null &&
			!isTerminal(rec.state) &&
			(rec.bootId === this.opts.bootId || this.opts.boots.isLive(rec.bootId))
		);
	}
}

function describe(e: unknown): string {
	const code = (e as NodeJS.ErrnoException).code;
	const msg =
		e instanceof Error ? e.message.split("\n")[0].slice(0, 160) : "error";
	return code ? `${code}: ${msg}` : msg;
}
