/**
 * A quote-aware lexer for the POSIX shell subset that matters for risk
 * classification. It does not run or expand anything. It splits a command line
 * into simple commands, joined by operators, with every word's quotes and
 * escapes removed the way a shell would, and it records what it cannot know
 * (expansions, substitutions, heredocs, groups). Whatever it cannot parse
 * with confidence it reports as `unparseable`, and callers treat that as
 * risky.
 */

export interface Word {
	/** The word with quotes and escapes removed. Expansions are left out. */
	text: string;
	/** Part of it was quoted or escaped. */
	quoted: boolean;
	/** It holds an expansion whose value is unknown (`$x`, `${x}`, `$'..'`, `{a,b}`). */
	dynamic: boolean;
	/** An unquoted `*`, `?` or `[` that the shell would expand. */
	glob: boolean;
	/** It starts with an unquoted `~`, which the shell expands. */
	tilde: boolean;
}

export type RedirectOp =
	| "<"
	| ">"
	| ">>"
	| ">|"
	| "<>"
	| "&>"
	| "&>>"
	| "<<"
	| "<<-"
	| "<<<"
	| ">&"
	| "<&";

export interface Redirect {
	op: RedirectOp;
	/** The file descriptor before the operator, if written. */
	fd?: string;
	target: Word;
}

export type Separator = "|" | "|&" | "&&" | "||" | ";" | "&" | "\n" | "(" | ")";

export interface SimpleCommand {
	/** `NAME=value` words before the command name. */
	assignments: string[];
	words: Word[];
	redirects: Redirect[];
	/** The operator that came before this command (null for the first). */
	after: Separator | null;
}

export interface Lexed {
	commands: SimpleCommand[];
	/** Source text of every `$(...)`, backtick and `<(...)` found. */
	substitutions: string[];
	heredoc: boolean;
	/** `( ... )` grouping or a subshell. */
	group: boolean;
	/** A command ends with `&`. */
	background: boolean;
	/** Set when the text could not be parsed with confidence. */
	unparseable?: string;
}

/** Longest command line the lexer accepts. */
export const MAX_COMMAND_LENGTH = 16 * 1024;
const MAX_DEPTH = 5;

class Unparseable extends Error {}

const isNameStart = (c: string) => /[A-Za-z_]/.test(c);

/** Index after the `)` that closes a `$(`/`(` whose body starts at `i`. */
function skipParen(text: string, i: number): number {
	let depth = 1;
	while (i < text.length) {
		const c = text[i];
		if (c === "\\") i += 2;
		else if (c === "'") {
			const end = text.indexOf("'", i + 1);
			if (end < 0) throw new Unparseable("unterminated single quote");
			i = end + 1;
		} else if (c === '"') i = skipDouble(text, i + 1);
		else if (c === "`") i = skipBacktick(text, i + 1);
		else if (c === "(") {
			depth++;
			i++;
		} else if (c === ")") {
			depth--;
			i++;
			if (depth === 0) return i;
		} else i++;
	}
	throw new Unparseable("unterminated substitution");
}

/** Index after the closing `"` of a double-quoted string starting at `i`. */
function skipDouble(text: string, i: number): number {
	while (i < text.length) {
		const c = text[i];
		if (c === "\\") i += 2;
		else if (c === '"') return i + 1;
		else if (c === "$" && text[i + 1] === "(") i = skipParen(text, i + 2);
		else if (c === "`") i = skipBacktick(text, i + 1);
		else i++;
	}
	throw new Unparseable("unterminated double quote");
}

/** Index after the closing backtick of a backtick body starting at `i`. */
function skipBacktick(text: string, i: number): number {
	while (i < text.length) {
		if (text[i] === "\\") i += 2;
		else if (text[i] === "`") return i + 1;
		else i++;
	}
	throw new Unparseable("unterminated backtick");
}

const unbacktick = (s: string) => s.replace(/\\([`\\$])/g, "$1");

export function lexShell(text: string, depth = 0): Lexed {
	const out: Lexed = {
		commands: [],
		substitutions: [],
		heredoc: false,
		group: false,
		background: false,
	};
	if (text.length > MAX_COMMAND_LENGTH) {
		out.unparseable = "command is too long to analyse";
		return out;
	}
	if (text.includes("\0")) {
		out.unparseable = "command contains a NUL byte";
		return out;
	}
	if (depth > MAX_DEPTH) {
		out.unparseable = "substitutions are nested too deeply";
		return out;
	}
	try {
		lex(text, out);
	} catch (e) {
		if (!(e instanceof Unparseable)) throw e;
		out.unparseable = e.message;
	}
	return out;
}

const WORD_END = new Set([
	" ",
	"\t",
	"\n",
	"\r",
	";",
	"&",
	"|",
	"(",
	")",
	"<",
	">",
]);
const SPECIAL_PARAM = /[{0-9@*#?$!-]/;

interface State {
	current: SimpleCommand | null;
	after: Separator | null;
	redirect: { op: RedirectOp; fd?: string } | null;
	/** The last token was an operator that needs a command after it. */
	needCommand: boolean;
}

function lex(text: string, out: Lexed): void {
	const st: State = {
		current: null,
		after: null,
		redirect: null,
		needCommand: false,
	};
	let i = 0;

	const begin = (): SimpleCommand => {
		if (!st.current) {
			st.current = {
				assignments: [],
				words: [],
				redirects: [],
				after: st.after,
			};
			out.commands.push(st.current);
			st.needCommand = false;
		}
		return st.current;
	};
	const noPendingRedirect = () => {
		if (st.redirect) throw new Unparseable("redirection without a target");
	};
	const separate = (sep: Separator, needsNext: boolean) => {
		noPendingRedirect();
		if (st.current === null && st.after !== ")") {
			throw new Unparseable(`unexpected ${JSON.stringify(sep)}`);
		}
		if (sep === "&") out.background = true;
		st.current = null;
		st.after = sep;
		st.needCommand = needsNext;
	};
	const addWord = (w: Word) => {
		if (st.redirect) {
			begin().redirects.push({ ...st.redirect, target: w });
			st.redirect = null;
			return;
		}
		const cmd = begin();
		if (
			cmd.words.length === 0 &&
			!w.quoted &&
			!w.dynamic &&
			/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w.text)
		) {
			cmd.assignments.push(w.text);
			return;
		}
		cmd.words.push(w);
	};
	const addSubstitution = (body: string) => {
		out.substitutions.push(body);
	};

	while (i < text.length) {
		const c = text[i];

		if (c === " " || c === "\t") {
			i++;
			continue;
		}
		if (c === "\\" && text[i + 1] === "\n") {
			i += 2;
			continue;
		}
		if (c === "#") {
			while (i < text.length && text[i] !== "\n") i++;
			continue;
		}
		if (c === "\n" || c === "\r") {
			if (c === "\r" && text[i + 1] === "\n") i++;
			i++;
			noPendingRedirect();
			if (st.needCommand) continue; // `a &&` then a new line: it continues
			st.current = null;
			st.after = "\n";
			continue;
		}

		// ---- operators ----
		const two = text.substr(i, 2);
		if (two === "&&" || two === "||" || two === "|&") {
			separate(two as Separator, true);
			i += 2;
			continue;
		}
		if (c === "|") {
			separate("|", true);
			i++;
			continue;
		}
		if (c === ";") {
			if (text[i + 1] === ";") throw new Unparseable("`;;` outside a case");
			separate(";", false);
			i++;
			continue;
		}
		if (c === "&" && text[i + 1] !== ">") {
			separate("&", false);
			i++;
			continue;
		}
		if (c === "(" || c === ")") {
			noPendingRedirect();
			out.group = true;
			st.current = null;
			st.after = c;
			st.needCommand = false;
			i++;
			continue;
		}

		// ---- redirections and process substitution ----
		const fdMatch = /^(\d+)(?=[<>])/.exec(text.slice(i, i + 12));
		const opAt = fdMatch ? i + fdMatch[1].length : i;
		const oc = text[opAt];
		if (oc === "<" || oc === ">" || (c === "&" && text[i + 1] === ">")) {
			let op: RedirectOp;
			if (c === "&") {
				op = text.substr(i, 3) === "&>>" ? "&>>" : "&>";
				i += op.length;
			} else {
				const o3 = text.substr(opAt, 3);
				const o2 = text.substr(opAt, 2);
				if (o3 === "<<<" || o3 === "<<-") op = o3;
				else if (["<<", ">>", ">|", "<>", ">&", "<&"].includes(o2)) {
					op = o2 as RedirectOp;
				} else op = oc as RedirectOp;
				if ((op === "<" || op === ">") && text[opAt + 1] === "(") {
					const end = skipParen(text, opAt + 2);
					addSubstitution(text.slice(opAt + 2, end - 1));
					addWord({
						text: "",
						quoted: false,
						dynamic: true,
						glob: false,
						tilde: false,
					});
					i = end;
					continue;
				}
				i = opAt + op.length;
			}
			if (op === "<<" || op === "<<-") out.heredoc = true;
			noPendingRedirect();
			st.redirect = { op, fd: fdMatch?.[1] };
			begin();
			continue;
		}

		// ---- a word ----
		let value = "";
		let quoted = false;
		let dynamic = false;
		let glob = false;
		const tilde = c === "~";
		while (i < text.length && !WORD_END.has(text[i])) {
			const ch = text[i];
			if (ch === "\\") {
				if (i + 1 >= text.length) throw new Unparseable("trailing backslash");
				if (text[i + 1] !== "\n") {
					value += text[i + 1];
					quoted = true;
				}
				i += 2;
			} else if (ch === "'") {
				const end = text.indexOf("'", i + 1);
				if (end < 0) throw new Unparseable("unterminated single quote");
				value += text.slice(i + 1, end);
				quoted = true;
				i = end + 1;
			} else if (ch === '"') {
				quoted = true;
				i++;
				for (;;) {
					const d = text[i];
					if (d === undefined)
						throw new Unparseable("unterminated double quote");
					if (d === '"') {
						i++;
						break;
					}
					if (d === "\\") {
						const n = text[i + 1];
						if (n === undefined)
							throw new Unparseable("unterminated double quote");
						if (n === "\n") i += 2;
						else if ('$`"\\'.includes(n)) {
							value += n;
							i += 2;
						} else {
							value += d;
							i++;
						}
					} else if (d === "$" && text[i + 1] === "(") {
						const end = skipParen(text, i + 2);
						addSubstitution(text.slice(i + 2, end - 1));
						dynamic = true;
						i = end;
					} else if (d === "`") {
						const end = skipBacktick(text, i + 1);
						addSubstitution(unbacktick(text.slice(i + 1, end - 1)));
						dynamic = true;
						i = end;
					} else if (d === "$" && isParameter(text[i + 1])) {
						dynamic = true;
						i = skipVariable(text, i);
					} else {
						value += d;
						i++;
					}
				}
			} else if (ch === "`") {
				const end = skipBacktick(text, i + 1);
				addSubstitution(unbacktick(text.slice(i + 1, end - 1)));
				dynamic = true;
				i = end;
			} else if (ch === "$") {
				const n = text[i + 1];
				if (n === "(") {
					const end = skipParen(text, i + 2);
					addSubstitution(text.slice(i + 2, end - 1));
					dynamic = true;
					i = end;
				} else if (n === "'") {
					// $'...': the shell decodes the escapes, so the value is unknown.
					let j = i + 2;
					while (j < text.length && text[j] !== "'")
						j += text[j] === "\\" ? 2 : 1;
					if (j >= text.length) throw new Unparseable("unterminated $'...'");
					dynamic = true;
					quoted = true;
					i = j + 1;
				} else if (isParameter(n)) {
					dynamic = true;
					i = skipVariable(text, i);
				} else {
					value += ch; // a lone `$`, or `$"` (handled as plain text)
					i++;
				}
			} else if (ch === "{") {
				// Brace expansion `{a,b}` or `{1..3}`; a lone `{` or `{}` is literal.
				const close = text.indexOf("}", i);
				const inner = close > i ? text.slice(i + 1, close) : "";
				if (/,|\.\./.test(inner) && !/\s/.test(inner)) dynamic = true;
				value += ch;
				i++;
			} else {
				if (ch === "*" || ch === "?" || ch === "[") glob = true;
				value += ch;
				i++;
			}
		}
		addWord({ text: value, quoted, dynamic, glob, tilde });
	}

	noPendingRedirect();
	if (st.needCommand) {
		throw new Unparseable("a command is missing after an operator");
	}
}

const isParameter = (c: string | undefined): c is string =>
	c !== undefined && (isNameStart(c) || SPECIAL_PARAM.test(c));

/** Index after a `$name`, `${...}`, `$1` or special parameter at `i`. */
function skipVariable(text: string, i: number): number {
	const n = text[i + 1];
	if (n === "{") {
		const end = text.indexOf("}", i + 2);
		if (end < 0) throw new Unparseable("unterminated ${");
		return end + 1;
	}
	if (isNameStart(n)) {
		let j = i + 2;
		while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
		return j;
	}
	return i + 2;
}
