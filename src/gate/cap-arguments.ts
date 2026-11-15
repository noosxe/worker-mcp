import { canonicalJson } from "./audit.js";

const size = (v: unknown) => Buffer.byteLength(canonicalJson(v));

/** Arguments no bigger than `maxBytes` of JSON; long strings are cut first. */
export function capArguments(
	input: Record<string, unknown>,
	maxBytes: number,
): { arguments: unknown; truncated: boolean } {
	if (size(input) <= maxBytes) return { arguments: input, truncated: false };
	let leaves = 0;
	const count = (v: unknown): void => {
		if (typeof v === "string") leaves++;
		else if (Array.isArray(v)) v.forEach(count);
		else if (v && typeof v === "object") Object.values(v).forEach(count);
	};
	count(input);
	const each = Math.max(32, Math.floor(maxBytes / Math.max(1, leaves) / 2));
	const cut = (v: unknown): unknown => {
		if (typeof v === "string") return v.length > each ? v.slice(0, each) : v;
		if (Array.isArray(v)) return v.map(cut);
		if (v && typeof v === "object") {
			return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x)]));
		}
		return v;
	};
	const shrunk = cut(input);
	if (size(shrunk) <= maxBytes) return { arguments: shrunk, truncated: true };
	// Still too big (many keys or deep): keep a prefix of the JSON as text.
	return {
		arguments: { _truncated: canonicalJson(input).slice(0, maxBytes) },
		truncated: true,
	};
}
