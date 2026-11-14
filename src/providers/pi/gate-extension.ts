import * as fs from "node:fs";
import * as path from "node:path";

/** Name of the dialog and of the status key the gate uses. */
export const GATE_DIALOG_TITLE = "worker-mcp-gate/v3";
export const GATE_STATUS_KEY = "worker-mcp-gate";
export const GATE_NONCE_ENV = "WORKER_MCP_GATE_NONCE";
export const GATE_FILE_NAME = "gate.ts";

/**
 * Source of the approval gate (v3), written fresh for every worker from this
 * constant, so no file on disk is trusted as code.
 *
 * - On `session_start` it reports `ready:<nonce>` through `setStatus`; the
 *   server waits for that before it considers the worker open.
 * - Every tool call is sent to the server through `ctx.ui.input`, whose
 *   response is a string and so can carry a structured decision: allow, deny
 *   with a reason, or mutate with a new input.
 * - Anything that is not a valid v3 decision with the right nonce blocks the
 *   call, as does a cancelled dialog and a thrown error.
 * - The nonce is read once and removed from `process.env`, so processes pi
 *   starts later do not inherit it.
 */
export const GATE_EXTENSION_SOURCE = `// Approval gate for worker-mcp (v3)
export default function (pi: any) {
  const NONCE = process.env.${GATE_NONCE_ENV};
  delete process.env.${GATE_NONCE_ENV};
  pi.on("session_start", (_event: any, ctx: any) => {
    if (NONCE) ctx.ui.setStatus("${GATE_STATUS_KEY}", "ready:" + NONCE);
  });
  pi.on("tool_call", async (event: any, ctx: any) => {
    try {
      const request = JSON.stringify({
        v: 3,
        nonce: NONCE,
        toolName: event.toolName,
        input: event.input,
      });
      const raw = await ctx.ui.input("${GATE_DIALOG_TITLE}", request);
      let d: any = null;
      try {
        d = JSON.parse(raw ?? "");
      } catch {
        d = null;
      }
      if (!NONCE || !d || d.v !== 3 || d.nonce !== NONCE) {
        return { block: true, reason: "worker-mcp: no valid decision" };
      }
      if (d.decision === "allow") return;
      if (d.decision === "mutate" && d.input && typeof d.input === "object") {
        for (const k of Object.keys(event.input)) delete event.input[k];
        Object.assign(event.input, d.input);
        return;
      }
      return { block: true, reason: String(d.reason ?? "Denied by worker-mcp") };
    } catch {
      return { block: true, reason: "worker-mcp: gate error" };
    }
  });
}
`;

export class GateError extends Error {}

/**
 * Write the gate into the worker's private directory (mode 0600) and read it
 * back. Throws a `GateError` when that fails: pi must not start.
 */
export function writeGateFile(privateDir: string): string {
	const file = path.join(privateDir, GATE_FILE_NAME);
	try {
		fs.writeFileSync(file, GATE_EXTENSION_SOURCE, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		fs.chmodSync(file, 0o600);
		if (fs.readFileSync(file, "utf8") !== GATE_EXTENSION_SOURCE) {
			throw new Error("gate file changed after it was written");
		}
	} catch (e) {
		throw new GateError(
			`Refusing to start pi without the approval gate: could not write it (${e instanceof Error ? e.message : String(e)}).`,
			{ cause: e },
		);
	}
	return file;
}

/** The decision sent back to the gate, as the `value` of the dialog reply. */
export function encodeDecision(
	nonce: string,
	decision:
		| { kind: "allow" }
		| { kind: "deny"; reason: string }
		| { kind: "mutate"; input: Record<string, unknown> },
): string {
	switch (decision.kind) {
		case "allow":
			return JSON.stringify({ v: 3, nonce, decision: "allow" });
		case "deny":
			return JSON.stringify({
				v: 3,
				nonce,
				decision: "deny",
				reason: decision.reason,
			});
		case "mutate":
			return JSON.stringify({
				v: 3,
				nonce,
				decision: "mutate",
				input: decision.input,
			});
	}
}

export interface GateRequest {
	toolName: string;
	input: Record<string, unknown>;
}

/**
 * Parse a gate dialog's `placeholder`. Null unless it is a v3 request that
 * carries `nonce`: anything else is answered with a cancel, which blocks.
 */
export function parseGateRequest(
	placeholder: string | undefined,
	nonce: string,
): GateRequest | null {
	if (placeholder === undefined) return null;
	let v: unknown;
	try {
		v = JSON.parse(placeholder);
	} catch {
		return null;
	}
	if (typeof v !== "object" || v === null) return null;
	const r = v as Record<string, unknown>;
	if (r.v !== 3 || r.nonce !== nonce) return null;
	if (typeof r.toolName !== "string") return null;
	const input =
		typeof r.input === "object" && r.input !== null && !Array.isArray(r.input)
			? (r.input as Record<string, unknown>)
			: {};
	return { toolName: r.toolName, input };
}
