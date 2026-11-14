/** Flags that keep pi from loading anything but the gate. */
export const PI_HARDENING_FLAGS = [
	"--no-extensions",
	"--no-mcp",
	"--no-approve",
] as const;

export interface PiArgvInput {
	gateFile: string;
	systemPrompt?: string;
}

/**
 * Arguments after the binary. `--no-session` is not passed yet: it would
 * change what pi writes under its own directory, which cannot be checked
 * without a model call.
 */
export function buildPiArgs(input: PiArgvInput): string[] {
	const args = ["--mode", "rpc", ...PI_HARDENING_FLAGS, "-e", input.gateFile];
	if (input.systemPrompt) args.push("--system-prompt", input.systemPrompt);
	return args;
}
