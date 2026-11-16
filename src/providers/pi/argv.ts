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
	if (input.systemPrompt) args.push("--system-prompt", input.systemPrompt);
	return args;
}
