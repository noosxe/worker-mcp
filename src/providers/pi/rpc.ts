/**
 * The parts of pi's `--mode rpc` JSONL protocol worker-mcp reads, checked
 * against pi 1.4.0. Everything arriving from pi is untrusted input: the
 * guards below accept only what has the expected shape.
 */

export type PiMessage = Record<string, unknown> & { type?: unknown };

export const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

export interface UiRequest {
	id: string;
	method: string;
	title?: string;
	message?: string;
	placeholder?: string;
	statusKey?: string;
	statusText?: string;
	notifyType?: string;
}

/** An `extension_ui_request`, or null when it lacks a string id and method. */
export function asUiRequest(msg: unknown): UiRequest | null {
	if (!isRecord(msg) || msg.type !== "extension_ui_request") return null;
	if (typeof msg.id !== "string" || typeof msg.method !== "string") return null;
	const str = (k: string) =>
		typeof msg[k] === "string" ? (msg[k] as string) : undefined;
	return {
		id: msg.id,
		method: msg.method,
		title: str("title"),
		message: str("message"),
		placeholder: str("placeholder"),
		statusKey: str("statusKey"),
		statusText: str("statusText"),
		notifyType: str("notifyType"),
	};
}

/** Text of an assistant `message_end` (text blocks joined), or null. */
export function assistantText(msg: Record<string, unknown>): string | null {
	const m = msg.message;
	if (!isRecord(m) || m.role !== "assistant" || !Array.isArray(m.content)) {
		return null;
	}
	const parts: string[] = [];
	for (const block of m.content) {
		if (
			isRecord(block) &&
			block.type === "text" &&
			typeof block.text === "string"
		) {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

const num = (v: unknown) => (typeof v === "number" ? v : undefined);

export interface PiUsage {
	inputTokens?: number;
	outputTokens?: number;
	costUsd?: number;
}

/** Token and cost figures from an assistant message's `usage`, if present. */
export function messageUsage(
	msg: Record<string, unknown>,
): PiUsage | undefined {
	const m = msg.message;
	const u = isRecord(m) ? m.usage : undefined;
	if (!isRecord(u)) return undefined;
	const cost = isRecord(u.cost) ? num(u.cost.total) : undefined;
	return {
		inputTokens: num(u.input),
		outputTokens: num(u.output),
		costUsd: cost,
	};
}

/** Text of a tool result, for a capped preview. */
export function resultPreview(result: unknown, maxChars: number): string {
	if (!isRecord(result) || !Array.isArray(result.content)) return "";
	const text = result.content
		.map((b) => (isRecord(b) && typeof b.text === "string" ? b.text : ""))
		.join("");
	return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
