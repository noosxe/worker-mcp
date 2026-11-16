import fs from "node:fs";
import path from "node:path";

/** Flags that keep pi from loading anything but the gate. */
export const PI_HARDENING_FLAGS = [
	"--no-extensions",
	"--no-mcp",
	"--no-approve",
] as const;

export interface PiArgvInput {
	gateFile: string;
	systemPrompt?: string;
	/**
	 * Keep the conversation in a session file: pi writes it to `dir` under the
	 * name `id`. Without it pi runs with `--no-session` and saves nothing.
	 */
	session?: { dir: string; id: string };
	/**
	 * Directories of skills to load although skills are off: the workspace's
	 * own. Only used with `skills: false`.
	 */
	workspaceSkillDirs?: readonly string[];
	/** Whether pi loads skills (default true). */
	skills?: boolean;
}

/**
 * Skill directories inside the workspace that pi would find: `.pi/skills` and
 * `.agents/skills` in `cwd` and, inside a git repository, in each directory up
 * to the repository root. `--no-skills` switches all discovery off, the
 * workspace's skills included, so these are passed back explicitly.
 */
export function workspaceSkillDirs(cwd: string): string[] {
	const dirs: string[] = [];
	let root: string | null = null;
	for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
		if (fs.existsSync(path.join(d, ".git"))) {
			root = d;
			break;
		}
		if (path.dirname(d) === d) break;
	}
	for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
		for (const sub of [".pi/skills", ".agents/skills"]) {
			const p = path.join(d, sub);
			if (fs.existsSync(p)) dirs.push(p);
		}
		if (root === null || d === root || path.dirname(d) === d) break;
	}
	return dirs;
}

/** Arguments after the binary. */
export function buildPiArgs(input: PiArgvInput): string[] {
	const args = [
		"--mode",
		"rpc",
		...PI_HARDENING_FLAGS,
		...(input.session
			? ["--session-dir", input.session.dir, "--session-id", input.session.id]
			: ["--no-session"]),
		"-e",
		input.gateFile,
	];
	if (input.skills === false) {
		args.push("--no-skills");
		for (const dir of input.workspaceSkillDirs ?? []) args.push("--skill", dir);
	}
	if (input.systemPrompt) args.push("--system-prompt", input.systemPrompt);
	return args;
}
