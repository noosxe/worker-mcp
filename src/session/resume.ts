import * as fs from "node:fs";

import type { GateLogEntry } from "../gate/audit.js";
import { RISK_LABELS } from "../gate/risk.js";
import type { SessionInspection } from "../providers/types.js";

/**
 * Pieces of a resume that need no process: matching the tool calls a stopped
 * worker left without a result against what the server recorded about them,
 * and the note that tells the resumed model about them.
 */

/** What is known about a call that has no result. */
export type InterruptedStatus =
	/** Allowed (by rules, a classifier or the coordinator) and started: outcome unknown. */
	| "approved_started"
	/** Sent to the coordinator and never answered, so it never ran. */
	| "awaiting_approval"
	/** In the session, but the server's records say nothing about it. */
	| "unknown";

export interface InterruptedCall {
	/** The tool's name, from the session file (worker trust, made safe to print). */
	tool: string;
	status: InterruptedStatus;
	approvalId?: string;
	riskLabel?: string;
	/** The gate's digest of the call's arguments. */
	digest: string;
	/** The arguments as short one-line JSON, from the session file. Untrusted. */
	untrustedPreview: string;
}

/** An approval the interrupted run had open, from the run record. */
export interface AbandonedApproval {
	approvalId: string;
	tool: string;
	riskLabel?: string;
}

const MAX_AUDIT_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 5000;

/**
 * The audit entries written by the given workers, the last entry of each
 * request (an escalation is followed by its answer). Oldest first. Lines that
 * do not parse are skipped. Returns null when no audit file can be read at
 * all, so the caller can tell "no entry" from "no audit".
 */
export function readAuditFor(
	file: string,
	keep: number,
	workerIds: ReadonlySet<string>,
): GateLogEntry[] | null {
	const files = [file];
	for (let i = 1; i <= keep; i++) files.push(`${file}.${i}`);
	files.reverse();
	const byRequest = new Map<string, GateLogEntry>();
	let readable = false;
	for (const f of files) {
		let text: string;
		try {
			const st = fs.statSync(f);
			if (!st.isFile() || st.size > MAX_AUDIT_BYTES) continue;
			text = fs.readFileSync(f, "utf8");
		} catch {
			continue;
		}
		readable = true;
		for (const line of text.split("\n")) {
			if (line === "") continue;
			let entry: GateLogEntry;
			try {
				entry = JSON.parse(line) as GateLogEntry;
			} catch {
				continue;
			}
			if (
				!entry ||
				typeof entry.requestId !== "string" ||
				typeof entry.workerId !== "string" ||
				!workerIds.has(entry.workerId)
			) {
				continue;
			}
			// The later entry of a request is its outcome; keep its first position out of it.
			byRequest.delete(entry.requestId);
			byRequest.set(entry.requestId, entry);
		}
	}
	if (!readable) return null;
	return [...byRequest.values()].slice(-MAX_ENTRIES);
}

/** A tool name that is safe to print: pi's tool names are short identifiers. */
export function safeToolName(name: string): string {
	return /^[A-Za-z0-9_.:-]{1,40}$/.test(name) ? name : "a tool";
}

/**
 * Say what happened to each call that has no result. The audit log (what the
 * gate decided, with the approval id) is read first; the run record's
 * abandoned approvals cover a server that writes no audit. Anything neither
 * explains is `unknown`: never claimed not to have run.
 */
export function classifyInterrupted(
	calls: SessionInspection["danglingCalls"],
	sources: {
		/** From `readAuditFor`; null when there is no audit. */
		audit: GateLogEntry[] | null;
		abandoned: AbandonedApproval[];
	},
): InterruptedCall[] {
	const abandoned = [...sources.abandoned];
	return calls.map((call) => {
		const base = {
			tool: safeToolName(call.name),
			digest: call.inputDigest,
			untrustedPreview: call.untrustedPreview,
		};
		// Newest entry with this argument digest.
		let hit: GateLogEntry | undefined;
		for (const e of sources.audit ?? []) {
			if (e.argsDigest === call.inputDigest && e.tool === call.name) hit = e;
		}
		if (hit) {
			const label = RISK_LABELS[hit.rule.level];
			if (hit.decision === "allow") {
				return {
					...base,
					status: "approved_started" as const,
					approvalId: hit.approvalId,
					riskLabel: label,
				};
			}
			if (
				hit.decision === "escalate" ||
				(hit.decision === "deny" && hit.decidedBy === "abandoned")
			) {
				return {
					...base,
					status: "awaiting_approval" as const,
					approvalId: hit.approvalId,
					riskLabel: label,
				};
			}
			// Denied or rejected: it should have an answer in the session; say less.
			return { ...base, status: "unknown" as const, riskLabel: label };
		}
		const i = abandoned.findIndex((a) => a.tool === call.name);
		if (i >= 0) {
			const [a] = abandoned.splice(i, 1);
			return {
				...base,
				status: "awaiting_approval" as const,
				approvalId: a.approvalId,
				riskLabel: a.riskLabel,
			};
		}
		return { ...base, status: "unknown" as const };
	});
}

const MAX_NOTED = 10;

function describeCall(c: InterruptedCall): string {
	switch (c.status) {
		case "approved_started":
			return `${c.tool} (approved, started): result unknown, it may have run partly or fully`;
		case "awaiting_approval":
			return `${c.tool} (was waiting for approval, never approved): it did not run`;
		default:
			return `${c.tool} (state unknown): result unknown, it may have run partly or fully`;
	}
}

const minute = (iso: string | undefined): string => {
	const t = iso ? Date.parse(iso) : NaN;
	return Number.isNaN(t)
		? "an unknown time"
		: `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

/**
 * The note put in front of the first prompt of a resumed worker. Without it a
 * model that was cut off in a tool call tends to say the call succeeded; with
 * it, it reports the result as unknown. It names tools, never their
 * arguments (the model still has those), and carries nothing from the session
 * file except tool names that passed `safeToolName`.
 */
export function resumeNote(opts: {
	lastActiveAt?: string;
	calls: InterruptedCall[];
}): string {
	const head = `[worker-mcp] This worker was resumed from its saved conversation (last activity ${minute(opts.lastActiveAt)}).`;
	if (opts.calls.length === 0) {
		return `${head} Its last turn was not cut off: no tool call was left without a result. Earlier approvals are void. The task below follows.`;
	}
	const shown = opts.calls.slice(0, MAX_NOTED).map(describeCall);
	if (opts.calls.length > MAX_NOTED) {
		shown.push(`and ${opts.calls.length - MAX_NOTED} more`);
	}
	return `${head} Your last turn was cut off. Tool calls left without a result: ${shown.join("; ")}. Do not repeat a call that may have run unless the task below needs it; check the workspace state first. Earlier approvals are void. The task below follows.`;
}

/** What a resume found and decided; the spawn result and the first prompt come from it. */
export interface ResumedInfo {
	/** The worker id that was resumed. */
	from: string;
	/** The conversation's id: the first worker id of the chain. */
	lineage: string;
	/** The run the old worker was last in, from its record. */
	lastRun?: { runId: string; state: string };
	sessionBytes: number;
	messageCount: number;
	providerVersion: { recorded?: string; now?: string; changed: boolean };
	/** Calls the old worker left without a result. */
	interrupted: InterruptedCall[];
	/** Things to tell the caller (a torn tail, a changed version, a dropped name). */
	notes: string[];
	/** The note put in front of the first prompt. */
	note: string;
}
