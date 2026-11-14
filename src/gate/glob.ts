/**
 * Glob matching for override and path patterns.
 *
 * `*` matches any run of characters and every other character matches itself:
 * there is no `?`, no classes and no escapes. Matching is a dynamic program
 * over (pattern position, input position), so its worst case is
 * O(pattern x input) however the pattern is written. No regular expression
 * is ever built from caller input, so nothing can backtrack exponentially.
 */

/** Patterns longer than this are rejected where policies are validated. */
export const MAX_GLOB_LENGTH = 512;

/** Input longer than this never matches: callers treat that as "no match". */
const MAX_INPUT_LENGTH = 1 << 16;

/** Characters a command pattern's `*` does not match (see `matchCommand`). */
const SHELL_METACHARACTERS = new Set(";&|<>`$()\\\n\r".split(""));

function match(
	input: string,
	pattern: string,
	starMatches: (ch: string) => boolean,
): boolean {
	if (pattern.length > MAX_GLOB_LENGTH || input.length > MAX_INPUT_LENGTH) {
		return false;
	}
	const m = pattern.length;
	// reach[j]: the first j pattern characters match the input read so far.
	let reach = new Uint8Array(m + 1);
	reach[0] = 1;
	for (let j = 1; j <= m; j++) {
		reach[j] = reach[j - 1] && pattern[j - 1] === "*" ? 1 : 0;
	}
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		const next = new Uint8Array(m + 1);
		for (let j = 1; j <= m; j++) {
			const p = pattern[j - 1];
			if (p === "*") {
				// Either the star matched nothing (next[j - 1]), or it also matched
				// this character (reach[j]).
				next[j] = next[j - 1] || (reach[j] && starMatches(ch)) ? 1 : 0;
			} else {
				next[j] = reach[j - 1] && p === ch ? 1 : 0;
			}
		}
		reach = next;
	}
	return reach[m] === 1;
}

/** `*` matches anything, `/` included: for paths and tool names. */
export function matchGlob(input: string, pattern: string): boolean {
	return match(input, pattern, () => true);
}

/**
 * For command strings: `*` stops at shell metacharacters and newlines, so
 * `git *` matches `git log --oneline` and not `git status; rm -rf ~`.
 * Metacharacters written in the pattern itself still match literally.
 */
export function matchCommand(input: string, pattern: string): boolean {
	return match(input, pattern, (ch) => !SHELL_METACHARACTERS.has(ch));
}
