/**
 * Flags that keep pi from loading anything but the gate, and from saving the
 * worker's conversation (`--no-session`: workers are not persisted).
 */
export const PI_HARDENING_FLAGS = [
	"--no-extensions",
	"--no-mcp",
	"--no-approve",
	"--no-session",
] as const;

export interface PiArgvInput {
	gateFile: string;
	systemPrompt?: string;
}

/** Arguments after the binary. */
export function buildPiArgs(input: PiArgvInput): string[] {
	const args = ["--mode", "rpc", ...PI_HARDENING_FLAGS, "-e", input.gateFile];
	if (input.systemPrompt) args.push("--system-prompt", input.systemPrompt);
	return args;
}
