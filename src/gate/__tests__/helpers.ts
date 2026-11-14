import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { GateOutcome } from "../classifier.js";
import { Gate, type GateOptions } from "../gate.js";
import type { RiskPolicy } from "../policy.js";
import { RiskLevel } from "../risk.js";

export interface Fixture {
	root: string;
	/** The workspace. */
	ws: string;
	home: string;
	/** A directory next to the workspace, outside it. */
	outside: string;
	gate(opts?: Partial<GateOptions>): Gate;
	cleanup(): void;
}

/** A private tree under the temp dir: nothing here touches the real HOME. */
export function fixture(): Fixture {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "worker-mcp-gate-")),
	);
	const ws = path.join(root, "ws");
	const home = path.join(root, "home");
	const outside = path.join(root, "outside");
	for (const d of [ws, home, outside, path.join(ws, "src")]) {
		fs.mkdirSync(d, { recursive: true });
	}
	return {
		root,
		ws,
		home,
		outside,
		gate: (opts = {}) =>
			new Gate({
				cwd: ws,
				home,
				protected: {
					stateDir: path.join(root, "state"),
					runtimeDir: path.join(root, "runtime"),
				},
				...opts,
			}),
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

/** The gate's decision, awaited if a classifier made it asynchronous. */
export async function decide(
	gate: Gate,
	toolName: string,
	input: Record<string, unknown>,
): Promise<GateOutcome> {
	return await gate.decide({ provider: "pi", toolName, input });
}

export const permissive = (
	upTo: RiskLevel,
	overrides: RiskPolicy["overrides"] = [],
): RiskPolicy => ({ autoApproveUpTo: upTo, overrides });
