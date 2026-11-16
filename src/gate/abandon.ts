import * as fs from "node:fs";

import type { AuditFile, GateLogEntry } from "./audit.js";

/** Never read more of one audit file than this when looking for open escalations. */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

export interface AbandonOptions {
	/** The audit file (the current one; rotated copies are read too). */
	file: string;
	/** Rotated copies next to it that are read as well. */
	keep: number;
	/** The server doing the close-out. */
	bootId: string;
	/** Whether the server with this boot id is running (it may still answer). */
	isLive: (bootId: string) => boolean;
	/** Where the closing entries go. */
	audit: AuditFile;
}

/**
 * Close escalations that were never answered. A gate decision that went to
 * the coordinator is logged as `escalate`, and again, with the same
 * `requestId`, when it is answered, times out or is cancelled. An `escalate`
 * with no later entry belongs to a server that stopped while the call was
 * waiting. Each gets one appended `deny` entry decided by `abandoned`, with the
 * old boot id and a reason. Nothing is replayed: the approval id stays dead.
 *
 * An escalation of a server that is still running is left alone. Lines that
 * do not parse are skipped. Never throws. Returns how many were closed.
 */
export function closeAbandonedApprovals(opts: AbandonOptions): number {
	const open = new Map<string, GateLogEntry>();
	const files = [opts.file];
	for (let i = 1; i <= opts.keep; i++) files.push(`${opts.file}.${i}`);
	// Oldest first, so a later entry can close an earlier one.
	files.reverse();
	for (const file of files) {
		let text: string;
		try {
			const st = fs.statSync(file);
			if (!st.isFile() || st.size > MAX_SCAN_BYTES) continue;
			text = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (line === "") continue;
			let entry: GateLogEntry;
			try {
				entry = JSON.parse(line) as GateLogEntry;
			} catch {
				continue;
			}
			if (!entry || typeof entry.requestId !== "string") continue;
			if (entry.decision === "escalate") open.set(entry.requestId, entry);
			else open.delete(entry.requestId);
		}
	}
	let closed = 0;
	for (const entry of open.values()) {
		const old = typeof entry.bootId === "string" ? entry.bootId : undefined;
		if (old === opts.bootId) continue;
		if (old !== undefined && opts.isLive(old)) continue;
		opts.audit.write({
			...entry,
			ts: new Date().toISOString(),
			consulted: [],
			decision: "deny",
			decidedBy: "abandoned",
			reason: `the server stopped before this approval was answered${old ? ` (boot ${old})` : ""}; it was never replayed`,
			closedByBootId: opts.bootId,
		});
		closed++;
	}
	return closed;
}
