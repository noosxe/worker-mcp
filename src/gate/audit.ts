import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ToolKind } from "./canonical.js";
import type { Consulted, Verdict } from "./classifier.js";
import type { RiskLevel } from "./risk.js";

export interface GateLogEntry {
	ts: string;
	requestId: string;
	workerId?: string;
	runId?: string;
	/** The provider's id for the call, when it has one (pi's request id). */
	providerCallId?: string;
	/** The `a_…` id of the approval, when the call went to the coordinator. */
	approvalId?: string;
	provider: string;
	tool: string;
	kind: ToolKind;
	depth: number;
	/** sha256 of the canonical arguments. */
	argsDigest: string;
	/** At most 200 characters: the command or the first path. */
	preview: string;
	rule: { level: RiskLevel; ruleId: string; autoAllowable: boolean };
	consulted: Consulted[];
	decision: Verdict;
	decidedBy: string;
	reason: string;
	matchedOverride?: string;
	/** Why the call went to the coordinator, when it did. */
	escalatedBecause?: string;
}

/** A bounded in-memory log: the oldest entry goes when it is full. */
export class AuditRing {
	private readonly items: GateLogEntry[] = [];

	constructor(readonly capacity = 500) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new RangeError("audit ring capacity must be a positive integer");
		}
	}

	push(entry: GateLogEntry): void {
		this.items.push(entry);
		if (this.items.length > this.capacity) {
			this.items.splice(0, this.items.length - this.capacity);
		}
	}

	entries(): GateLogEntry[] {
		return [...this.items];
	}

	get size(): number {
		return this.items.length;
	}

	/** The newest entry for a provider action id, if still in the ring. */
	findByAction(actionId: string): GateLogEntry | undefined {
		for (let i = this.items.length - 1; i >= 0; i--) {
			if (this.items[i].providerCallId === actionId) return this.items[i];
		}
		return undefined;
	}
}

/** JSON with sorted keys, so equal arguments always digest equally. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj);
		// oxlint-disable-next-line unicorn/no-array-sort -- keys is a fresh array
		keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export const digest = (value: unknown): string =>
	createHash("sha256").update(canonicalJson(value)).digest("hex");

export const previewOf = (
	command: string | undefined,
	target?: string,
): string => (command ?? target ?? "").slice(0, 200);

export interface AuditFileOptions {
	file: string;
	/** Rotate when the file would grow past this. Default 10 MiB. */
	maxBytes?: number;
	/** Rotated files kept next to the current one. Default 3. */
	keep?: number;
	/** Called once, with the error, when writing first fails. */
	onError?: (error: Error) => void;
}

export const DEFAULT_AUDIT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_AUDIT_KEEP = 3;

/**
 * The audit log file: one JSON object per line, appended, mode 0600, rotated
 * by size. Writing never throws. A failure is reported once and sets
 * `degraded` until a later write succeeds; decisions are never blocked by it.
 */
export class AuditFile {
	private fd: number | null = null;
	private size = 0;
	private reported = false;
	private failed = false;
	private readonly maxBytes: number;
	private readonly keep: number;

	constructor(private readonly opts: AuditFileOptions) {
		this.maxBytes = opts.maxBytes ?? DEFAULT_AUDIT_MAX_BYTES;
		this.keep = opts.keep ?? DEFAULT_AUDIT_KEEP;
	}

	get file(): string {
		return this.opts.file;
	}

	/** Whether the last write failed. */
	get degraded(): boolean {
		return this.failed;
	}

	write(entry: unknown): void {
		try {
			const line = `${JSON.stringify(entry)}\n`;
			const bytes = Buffer.byteLength(line);
			if (this.fd === null) this.open();
			if (this.size > 0 && this.size + bytes > this.maxBytes) {
				this.rotate();
				this.open();
			}
			fs.writeSync(this.fd as number, line);
			this.size += bytes;
			this.failed = false;
		} catch (e) {
			this.failed = true;
			this.close();
			if (!this.reported) {
				this.reported = true;
				this.opts.onError?.(e instanceof Error ? e : new Error(String(e)));
			}
		}
	}

	close(): void {
		if (this.fd !== null) {
			try {
				fs.closeSync(this.fd);
			} catch {
				// nothing to do
			}
			this.fd = null;
		}
	}

	private open(): void {
		fs.mkdirSync(path.dirname(this.opts.file), {
			recursive: true,
			mode: 0o700,
		});
		const fd = fs.openSync(
			this.opts.file,
			fs.constants.O_WRONLY |
				fs.constants.O_APPEND |
				fs.constants.O_CREAT |
				fs.constants.O_NOFOLLOW,
			0o600,
		);
		try {
			const stat = fs.fstatSync(fd);
			if (!stat.isFile()) throw new Error("audit file is not a regular file");
			// A file made earlier with wider rights is tightened.
			if ((stat.mode & 0o077) !== 0) fs.fchmodSync(fd, 0o600);
			this.size = stat.size;
		} catch (e) {
			fs.closeSync(fd);
			throw e;
		}
		this.fd = fd;
	}

	private rotate(): void {
		this.close();
		const f = this.opts.file;
		if (this.keep < 1) {
			fs.rmSync(f, { force: true });
			return;
		}
		fs.rmSync(`${f}.${this.keep}`, { force: true });
		for (let i = this.keep - 1; i >= 1; i--) {
			if (fs.existsSync(`${f}.${i}`))
				fs.renameSync(`${f}.${i}`, `${f}.${i + 1}`);
		}
		fs.renameSync(f, `${f}.1`);
		this.size = 0;
	}
}
