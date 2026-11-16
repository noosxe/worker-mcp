import * as fs from "node:fs";

import { digest } from "../../gate/audit.js";

/**
 * A read-only look at a pi session file (JSONL, format version 3). Pure: it
 * starts no process and calls no model. Everything in the file is worker
 * output, so every string that comes back from here is untrusted text; the
 * caller decides what may reach a model or an orchestrator. Nothing here logs.
 *
 * It never throws on bad input: whatever is wrong ends up in `damage`.
 */

/** The only session format this module understands. */
export const PI_SESSION_FORMAT = 3;
/** Files above this are not read at all. */
export const SESSION_MAX_BYTES = 32 * 1024 * 1024;
/** Beyond this many lines the rest is ignored and reported. */
export const SESSION_MAX_LINES = 200_000;
const PREVIEW_CHARS = 200;

export interface SessionHeader {
	/** The file format version, not pi's version. */
	version: number;
	id: string;
	cwd: string;
	timestamp?: string;
}

export interface DanglingToolCall {
	name: string;
	callId: string;
	/** `digest` of the call's arguments, as the gate computes it. */
	inputDigest: string;
	/** The arguments as JSON, control characters removed, cut short. Untrusted. */
	untrustedPreview: string;
	/** The assistant entry that holds the call. */
	entryId: string;
	/** Byte offset in the file where that entry's line starts. */
	offset: number;
}

export type SessionDamage =
	| { kind: "unreadable_file"; reason: string }
	| { kind: "too_large"; bytes: number; limit: number }
	| { kind: "too_many_lines"; limit: number }
	| { kind: "unreadable_header" }
	| { kind: "unknown_version"; found: number; supported: number }
	/** The last line does not parse: pi drops that entry. */
	| { kind: "torn_last_line"; line: number }
	/** A line in the middle does not parse. */
	| { kind: "damaged_line"; line: number }
	/**
	 * The active branch ends at an entry whose parent is missing, so earlier
	 * entries fall out of the context without an error (pi skips them silently).
	 */
	| { kind: "broken_chain"; missingParent: string; droppedMessages: number };

export interface SessionInspection {
	bytes: number;
	header?: SessionHeader;
	/** Model and thinking level as pi restores them: the last change on the branch. */
	model?: { provider?: string; modelId: string };
	thinkingLevel?: string;
	/** Messages on the active branch: what the model would be sent. */
	messageCount: number;
	/** Every parsed entry, on any branch. */
	entryCount: number;
	/** The active branch, oldest first: the leaf's parent chain. Entry ids. */
	activeBranch: string[];
	/** Tool calls on the active branch that have no result. */
	danglingCalls: DanglingToolCall[];
	damage: SessionDamage[];
	/** More than one child hangs off one entry: two writers, or a tree. */
	multipleBranches: boolean;
	/** Parent ids (null for the root) that have more than one child. */
	forkPoints: (string | null)[];
	/**
	 * Tokens the model was sent for its last reply on the active branch, from
	 * that assistant message's `usage` (input + cache read + cache write +
	 * output): what the next request starts from. Absent when no assistant
	 * message on the branch carries usage numbers. Worker trust.
	 */
	lastUsageTokens?: number;
	/** False when the body was not analysed (unreadable, too large, unknown format). */
	analysed: boolean;
}

const emptyInspection = (bytes: number): SessionInspection => ({
	bytes,
	messageCount: 0,
	entryCount: 0,
	activeBranch: [],
	danglingCalls: [],
	damage: [],
	multipleBranches: false,
	forkPoints: [],
	analysed: false,
});

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
	typeof v === "string" ? v : undefined;

interface Entry {
	id: string;
	parentId: string | null;
	type: string;
	raw: Json;
	line: number;
}

function clean(text: string): string {
	// oxlint-disable-next-line no-control-regex -- strips control characters on purpose
	const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
	return flat.length > PREVIEW_CHARS
		? `${flat.slice(0, PREVIEW_CHARS)}…`
		: flat;
}

function toolCallsOf(message: Json): Json[] {
	if (message.role !== "assistant" || !Array.isArray(message.content))
		return [];
	return message.content.filter(
		(c): c is Json => isObject(c) && c.type === "toolCall",
	);
}

const MAX_USAGE_TOKENS = 1e9;

/** Input, cache and output tokens of one message's `usage`, or undefined when it has none. */
const tokenCount = (v: unknown): number =>
	typeof v === "number" && Number.isFinite(v) && v >= 0
		? Math.min(v, MAX_USAGE_TOKENS)
		: 0;

function usageTokens(usage: Json): number | undefined {
	const n = tokenCount;
	const parts =
		n(usage.input) + n(usage.cacheRead) + n(usage.cacheWrite) + n(usage.output);
	if (parts > 0) return Math.round(parts);
	const total = n(usage.totalTokens);
	return total > 0 ? Math.round(total) : undefined;
}

/** Inspect session text already in memory. Pure; never throws. */
export function inspectSessionText(text: string): SessionInspection {
	const out = emptyInspection(Buffer.byteLength(text));
	try {
		return analyse(text, out);
	} catch {
		out.damage.push({ kind: "unreadable_file", reason: "unexpected content" });
		return out;
	}
}

function analyse(text: string, out: SessionInspection): SessionInspection {
	const lines = text.split("\n");
	// Where each line starts, in bytes (the text is utf8 with "\n" between lines).
	const starts: number[] = [];
	{
		let at = 0;
		for (const l of lines) {
			starts.push(at);
			at += Buffer.byteLength(l) + 1;
		}
	}
	if (lines.length > SESSION_MAX_LINES) {
		out.damage.push({ kind: "too_many_lines", limit: SESSION_MAX_LINES });
		lines.length = SESSION_MAX_LINES;
	}

	// Header: the first non-empty line.
	let first = 0;
	while (first < lines.length && lines[first].trim() === "") first++;
	let header: SessionHeader | undefined;
	if (first < lines.length) {
		try {
			const h: unknown = JSON.parse(lines[first]);
			if (
				isObject(h) &&
				h.type === "session" &&
				typeof h.version === "number" &&
				typeof h.id === "string" &&
				typeof h.cwd === "string"
			) {
				header = {
					version: h.version,
					id: h.id,
					cwd: h.cwd,
					...(typeof h.timestamp === "string"
						? { timestamp: h.timestamp }
						: {}),
				};
			}
		} catch {
			// falls through to unreadable_header
		}
	}
	if (!header) {
		out.damage.push({ kind: "unreadable_header" });
		return out;
	}
	out.header = header;
	if (header.version !== PI_SESSION_FORMAT) {
		out.damage.push({
			kind: "unknown_version",
			found: header.version,
			supported: PI_SESSION_FORMAT,
		});
		return out;
	}
	out.analysed = true;

	let lastNonEmpty = first;
	for (let i = lines.length - 1; i > first; i--) {
		if (lines[i].trim() !== "") {
			lastNonEmpty = i;
			break;
		}
	}

	const entries: Entry[] = [];
	const byId = new Map<string, Entry>();
	for (let i = first + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			parsed = undefined;
		}
		const ok =
			isObject(parsed) &&
			typeof parsed.type === "string" &&
			typeof parsed.id === "string" &&
			(parsed.parentId === null || typeof parsed.parentId === "string");
		if (!ok) {
			out.damage.push(
				i === lastNonEmpty
					? { kind: "torn_last_line", line: i + 1 }
					: { kind: "damaged_line", line: i + 1 },
			);
			continue;
		}
		const obj = parsed as Json;
		const entry: Entry = {
			id: obj.id as string,
			parentId: obj.parentId as string | null,
			type: obj.type as string,
			raw: obj,
			line: i + 1,
		};
		entries.push(entry);
		byId.set(entry.id, entry);
	}
	out.entryCount = entries.length;

	// Forks: more than one child under one parent.
	const children = new Map<string | null, number>();
	for (const e of entries) {
		children.set(e.parentId, (children.get(e.parentId) ?? 0) + 1);
	}
	out.forkPoints = [...children].filter(([, n]) => n > 1).map(([p]) => p);
	out.multipleBranches = out.forkPoints.length > 0;

	// Active branch: from the last entry in the file up through the parents.
	const branch: Entry[] = [];
	const seen = new Set<string>();
	let missingParent: string | undefined;
	let cur: Entry | undefined = entries.at(-1);
	while (cur && !seen.has(cur.id)) {
		seen.add(cur.id);
		branch.push(cur);
		if (cur.parentId === null) break;
		const next = byId.get(cur.parentId);
		if (!next) missingParent = cur.parentId;
		cur = next;
	}
	branch.reverse();
	out.activeBranch = branch.map((e) => e.id);

	const isMessage = (e: Entry) =>
		e.type === "message" && isObject(e.raw.message);
	out.messageCount = branch.filter(isMessage).length;

	if (missingParent !== undefined && branch.length > 0) {
		// Entries written before the oldest surviving one lost their link.
		const oldestLine = branch[0].line;
		const dropped = entries.filter(
			(e) => e.line < oldestLine && isMessage(e),
		).length;
		out.damage.push({
			kind: "broken_chain",
			missingParent,
			droppedMessages: dropped,
		});
	}

	// Model and thinking level as restored.
	for (const e of branch) {
		if (e.type === "model_change") {
			const modelId = str(e.raw.modelId);
			if (modelId) {
				out.model = {
					modelId,
					...(str(e.raw.provider) ? { provider: str(e.raw.provider) } : {}),
				};
			}
		} else if (e.type === "thinking_level_change") {
			const level = str(e.raw.thinkingLevel);
			if (level) out.thinkingLevel = level;
		}
	}

	// The size of the context as the last reply saw it.
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (!isMessage(e)) continue;
		const m = e.raw.message as Json;
		if (m.role !== "assistant" || !isObject(m.usage)) continue;
		const tokens = usageTokens(m.usage);
		if (tokens !== undefined) {
			out.lastUsageTokens = tokens;
			break;
		}
	}

	// Tool calls without a result on the branch.
	const answered = new Set<string>();
	for (const e of branch) {
		if (!isMessage(e)) continue;
		const m = e.raw.message as Json;
		if (m.role === "toolResult" && typeof m.toolCallId === "string") {
			answered.add(m.toolCallId);
		}
	}
	for (const e of branch) {
		if (!isMessage(e)) continue;
		for (const call of toolCallsOf(e.raw.message as Json)) {
			const callId = str(call.id);
			if (!callId || answered.has(callId)) continue;
			const input = call.arguments ?? call.input ?? null;
			let preview: string;
			try {
				preview = clean(JSON.stringify(input) ?? "null");
			} catch {
				preview = "";
			}
			out.danglingCalls.push({
				name: str(call.name) ?? "unknown",
				callId,
				inputDigest: digest(input),
				untrustedPreview: preview,
				entryId: e.id,
				offset: starts[e.line - 1] ?? 0,
			});
		}
	}
	return out;
}

/**
 * Inspect a session file. Reads at most `maxBytes` (a larger file is reported
 * as `too_large` and not read), refuses anything but a regular file, and
 * never throws.
 */
export async function inspectSession(
	file: string,
	opts: { maxBytes?: number } = {},
): Promise<SessionInspection> {
	const limit = opts.maxBytes ?? SESSION_MAX_BYTES;
	let handle: fs.promises.FileHandle | undefined;
	try {
		const lst = await fs.promises.lstat(file);
		if (!lst.isFile()) {
			const out = emptyInspection(0);
			out.damage.push({
				kind: "unreadable_file",
				reason: "not a regular file",
			});
			return out;
		}
		if (lst.size > limit) {
			const out = emptyInspection(lst.size);
			out.damage.push({ kind: "too_large", bytes: lst.size, limit });
			return out;
		}
		handle = await fs.promises.open(file, "r");
		// Read at most limit bytes even if the file grew after the stat.
		const buf = Buffer.alloc(Math.min(lst.size, limit));
		let read = 0;
		while (read < buf.length) {
			const { bytesRead } = await handle.read(
				buf,
				read,
				buf.length - read,
				read,
			);
			if (bytesRead === 0) break;
			read += bytesRead;
		}
		const out = inspectSessionText(buf.subarray(0, read).toString("utf8"));
		out.bytes = read;
		return out;
	} catch (e) {
		const out = emptyInspection(0);
		const code = (e as NodeJS.ErrnoException)?.code;
		out.damage.push({
			kind: "unreadable_file",
			reason: typeof code === "string" ? code : "read failed",
		});
		return out;
	} finally {
		await handle?.close().catch(() => {});
	}
}
