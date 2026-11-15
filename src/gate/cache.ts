import { createHash } from "node:crypto";

import { canonicalJson } from "./audit.js";
import type { CanonicalToolCall } from "./canonical.js";
import type { Verdict } from "./classifier.js";

/**
 * The key of a call for a decision cache: the classifier, the version of its
 * configuration, the worker, and everything that identifies the call. A
 * different worker, command, path or argument is a different key.
 */
export function callKey(
	classifierId: string,
	configVersion: string,
	workerId: string,
	call: CanonicalToolCall,
): string {
	return createHash("sha256")
		.update(
			canonicalJson([
				classifierId,
				configVersion,
				workerId,
				call.kind,
				call.rawName,
				call.command?.trim() ?? null,
				call.paths.map((p) => p.abs),
				call.input,
			]),
		)
		.digest("hex");
}

export interface CachedVerdict {
	verdict: Extract<Verdict, "allow" | "deny">;
	confidence?: number;
	reason: string;
}

interface Entry extends CachedVerdict {
	workerId: string;
	expiresAt: number;
}

export interface CacheOptions {
	maxEntries: number;
	maxTtlMs: number;
	now?: () => number;
}

/**
 * An in-memory LRU of classifier verdicts, scoped per worker by the key. Only
 * a decisive `allow` or `deny` is stored, and only for a bounded time.
 */
export class DecisionCache {
	private readonly entries = new Map<string, Entry>();
	private readonly now: () => number;

	constructor(private readonly opts: CacheOptions) {
		this.now = opts.now ?? Date.now;
	}

	get size(): number {
		return this.entries.size;
	}

	get(key: string): CachedVerdict | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= this.now()) {
			this.entries.delete(key);
			return undefined;
		}
		// Most recently used goes last.
		this.entries.delete(key);
		this.entries.set(key, entry);
		return {
			verdict: entry.verdict,
			confidence: entry.confidence,
			reason: entry.reason,
		};
	}

	set(
		key: string,
		workerId: string,
		value: CachedVerdict,
		ttlMs: number,
	): void {
		const ttl = Math.min(ttlMs, this.opts.maxTtlMs);
		if (!(ttl > 0) || this.opts.maxEntries < 1) return;
		this.entries.delete(key);
		this.entries.set(key, { ...value, workerId, expiresAt: this.now() + ttl });
		while (this.entries.size > this.opts.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	/** Forget everything about one worker. */
	clearWorker(workerId: string): void {
		for (const [key, entry] of this.entries) {
			if (entry.workerId === workerId) this.entries.delete(key);
		}
	}
}
