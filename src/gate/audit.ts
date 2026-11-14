import { createHash } from "node:crypto";

import type { ToolKind } from "./canonical.js";
import type { Consulted, Verdict } from "./classifier.js";
import type { RiskLevel } from "./risk.js";

export interface GateLogEntry {
	ts: string;
	requestId: string;
	/** The provider's id for the call, when it has one (pi's request id). */
	actionId?: string;
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
			if (this.items[i].actionId === actionId) return this.items[i];
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

export const previewOf = (command: string | undefined, path?: string): string =>
	(command ?? path ?? "").slice(0, 200);
