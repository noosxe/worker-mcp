import * as os from "node:os";
import * as path from "node:path";

import { isInside, realOrLexical, realResolve } from "./paths.js";
import type { ProtectedPaths } from "./protected-paths.js";
import type { RiskLevel } from "./risk.js";

export type ToolKind =
	| "shell"
	| "read"
	| "list"
	| "search"
	| "write"
	| "edit"
	| "fetch"
	| "mcp"
	| "agent"
	| "task"
	| "other";

export interface ToolMapEntry {
	kind: ToolKind;
	/** Input key holding a shell command. */
	command?: string;
	/** Input keys holding paths. */
	paths?: string[];
	/** The path key is optional and defaults to the working directory. */
	defaultPath?: "cwd";
}
export type ToolMap = Record<string, ToolMapEntry>;

/** pi 1.4.0's built-in tools and their argument keys. */
export const piToolMap: ToolMap = {
	bash: { kind: "shell", command: "command" },
	read: { kind: "read", paths: ["path"] },
	ls: { kind: "list", paths: ["path"], defaultPath: "cwd" },
	grep: { kind: "search", paths: ["path"], defaultPath: "cwd" },
	find: { kind: "search", paths: ["path"], defaultPath: "cwd" },
	edit: { kind: "edit", paths: ["path"] },
	write: { kind: "write", paths: ["path"] },
};

/** What a provider hands the gate: the tool as the worker called it. */
export interface RawToolCall {
	provider: string;
	toolName: string;
	input: Record<string, unknown>;
	depth?: number;
}

export interface ResolvedPath {
	raw: string;
	/** Absolute, symlinks followed for every part that exists. */
	abs: string;
	inWorkspace: boolean;
	/** The path could not be inspected; treated as outside the workspace. */
	unresolved?: boolean;
	/** Id of the protected-path rule this path falls under for this access. */
	protected?: string;
	/** The level that rule gives this access. */
	protectedLevel?: RiskLevel;
}

export interface CanonicalToolCall {
	provider: string;
	rawName: string;
	kind: ToolKind;
	command?: string;
	paths: ResolvedPath[];
	input: Record<string, unknown>;
	origin: { depth: number };
	/**
	 * Why the call could not be understood (a missing or non-string argument).
	 * The rules treat such a call as HIGH.
	 */
	malformed?: string;
}

export interface CanonicalizeContext {
	cwd: string;
	protectedPaths: ProtectedPaths;
	toolMap?: ToolMap;
	home?: string;
}

const WRITING: ReadonlySet<ToolKind> = new Set(["write", "edit"]);

/**
 * Candidate readings of a path argument. Tools may expand `~` or strip a
 * leading `@`; each reading is checked, so none can hide behind the other.
 */
export function pathCandidates(raw: string, home: string): string[] {
	const out = [raw];
	const bare = raw.startsWith("@") ? raw.slice(1) : raw;
	if (bare !== raw) out.push(bare);
	for (const r of out.slice()) {
		if (r === "~") out.push(home);
		else if (r.startsWith("~/")) out.push(path.join(home, r.slice(2)));
	}
	return [...new Set(out)];
}

export interface ResolveContext {
	workspace: string;
	home: string;
	protectedPaths: ProtectedPaths;
}

/** Resolve one raw path (every candidate reading) for the given access. */
export function resolvePaths(
	raw: string,
	access: "read" | "write",
	ctx: ResolveContext,
): ResolvedPath[] {
	return pathCandidates(raw, ctx.home).map((candidate) => {
		const real = realResolve(ctx.workspace, candidate);
		const hit = ctx.protectedPaths.check(real.abs, access);
		const resolved: ResolvedPath = {
			raw,
			abs: real.abs,
			inWorkspace: !real.unresolved && isInside(ctx.workspace, real.abs),
		};
		if (real.unresolved) resolved.unresolved = true;
		if (hit) {
			resolved.protected = hit.id;
			resolved.protectedLevel = hit.level;
		}
		return resolved;
	});
}

export function workspaceRoot(cwd: string): string {
	return realOrLexical(path.resolve(cwd));
}

/** Map a raw tool call to a canonical one. Never throws. */
export function canonicalize(
	raw: RawToolCall,
	ctx: CanonicalizeContext,
): CanonicalToolCall {
	const map = ctx.toolMap ?? piToolMap;
	const entry = Object.hasOwn(map, raw.toolName)
		? map[raw.toolName]
		: undefined;
	const call: CanonicalToolCall = {
		provider: raw.provider,
		rawName: raw.toolName,
		kind: entry?.kind ?? (raw.toolName.startsWith("mcp__") ? "mcp" : "other"),
		paths: [],
		input: raw.input,
		origin: { depth: raw.depth ?? 0 },
	};
	if (!entry) return call;

	if (entry.command !== undefined) {
		const value = raw.input[entry.command];
		if (typeof value === "string") call.command = value;
		else call.malformed = `\`${entry.command}\` is missing or not a string`;
	}

	const access = WRITING.has(entry.kind) ? "write" : "read";
	const rctx: ResolveContext = {
		workspace: workspaceRoot(ctx.cwd),
		home: ctx.home ?? os.homedir(),
		protectedPaths: ctx.protectedPaths,
	};
	for (const key of entry.paths ?? []) {
		const value = raw.input[key];
		if (value === undefined || value === null) {
			if (entry.defaultPath === "cwd") {
				call.paths.push(...resolvePaths(".", access, rctx));
			} else {
				call.malformed = `\`${key}\` is missing`;
			}
		} else if (typeof value === "string" && value !== "") {
			call.paths.push(...resolvePaths(value, access, rctx));
		} else {
			call.malformed = `\`${key}\` is not a non-empty string`;
		}
	}
	return call;
}
