import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

/**
 * A process table snapshot, enough to find the descendants of a worker. pi's
 * bash tool starts every command in its own process group, so killing the
 * worker's group alone misses them: the tree is walked through parent pids.
 *
 * A process is identified by its pid plus a start token, so a recycled pid is
 * never signalled by mistake. Linux reads `/proc`; other systems use `ps`.
 */
export interface ProcEntry {
	pid: number;
	ppid: number;
	/** Constant for the life of one process, different for a recycled pid. */
	token: string;
}

function readLinux(): ProcEntry[] {
	const out: ProcEntry[] = [];
	for (const name of fs.readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		let stat: string;
		try {
			stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
		} catch {
			continue; // gone, or not ours to read
		}
		// `pid (comm) state ppid pgrp ...`; comm may contain spaces and parens.
		const rest = stat
			.slice(stat.lastIndexOf(")") + 2)
			.trimEnd()
			.split(" ");
		const ppid = Number(rest[1]);
		const start = rest[19];
		if (!Number.isInteger(ppid) || start === undefined) continue;
		out.push({ pid: Number(name), ppid, token: start });
	}
	return out;
}

function readPs(): ProcEntry[] {
	const text = execFileSync("ps", ["-A", "-o", "pid=,ppid=,lstart="], {
		encoding: "utf8",
		timeout: 5000,
		stdio: ["ignore", "pipe", "ignore"],
	});
	const out: ProcEntry[] = [];
	for (const line of text.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
		if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), token: m[3] });
	}
	return out;
}

/** The current process table; empty when it cannot be read (best effort). */
export function readProcessTable(
	platform: NodeJS.Platform = process.platform,
): ProcEntry[] {
	try {
		return platform === "linux" ? readLinux() : readPs();
	} catch {
		return [];
	}
}

/** Every descendant of any of `roots`, by parent pid, in one pass. */
export function descendantsOf(
	table: readonly ProcEntry[],
	roots: Iterable<number>,
): ProcEntry[] {
	const children = new Map<number, ProcEntry[]>();
	for (const e of table) {
		const list = children.get(e.ppid);
		if (list) list.push(e);
		else children.set(e.ppid, [e]);
	}
	const seen = new Set<number>();
	const found: ProcEntry[] = [];
	const queue = [...roots];
	while (queue.length > 0) {
		const pid = queue.pop() as number;
		for (const c of children.get(pid) ?? []) {
			if (seen.has(c.pid)) continue;
			seen.add(c.pid);
			found.push(c);
			queue.push(c.pid);
		}
	}
	return found;
}

/**
 * Remembers every descendant seen while the worker was alive. Orphans are
 * reparented to init and can no longer be found by walking down from the
 * worker, so the set is recorded early and again right before a kill.
 */
export class TreeTracker {
	private readonly known = new Map<number, string>();

	constructor(
		private readonly rootPid: number,
		private readonly platform: NodeJS.Platform = process.platform,
	) {}

	/** Merge the current descendants into the remembered set. */
	refresh(): void {
		const table = readProcessTable(this.platform);
		if (table.length === 0) return;
		this.merge(table);
	}

	private merge(table: readonly ProcEntry[]): void {
		const byPid = new Map(table.map((e) => [e.pid, e]));
		// Forget processes that exited or whose pid was recycled, so the set
		// stays as small as the live tree however many commands a worker runs.
		for (const [pid, token] of this.known) {
			if (byPid.get(pid)?.token !== token) this.known.delete(pid);
		}
		// Roots: the worker itself plus remembered processes that still exist.
		const roots = [this.rootPid, ...this.known.keys()];
		for (const d of descendantsOf(table, roots)) this.known.set(d.pid, d.token);
	}

	/** Pids remembered so far (for diagnostics and tests). */
	get pids(): number[] {
		return [...this.known.keys()];
	}

	/** Signal every remembered process that is still the same process. */
	signalAll(signal: NodeJS.Signals): number {
		const table = readProcessTable(this.platform);
		if (table.length === 0) return 0;
		this.merge(table);
		const byPid = new Map(table.map((e) => [e.pid, e]));
		let sent = 0;
		for (const [pid, token] of this.known) {
			if (byPid.get(pid)?.token !== token) continue;
			try {
				process.kill(pid, signal);
				sent++;
			} catch {
				// already gone
			}
		}
		return sent;
	}
}
