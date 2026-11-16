import * as path from "node:path";

import { z } from "zod";

import { WORKER_NAME_PATTERN } from "./ids.js";

/**
 * Input schemas of every tool. All are strict: an unknown key is an error, so
 * a misspelt argument is reported instead of silently ignored. The bounds
 * below are the limits of the design, not tuning knobs.
 */

export const MAX_PROMPT_CHARS = 200_000;
export const MAX_SYSTEM_PROMPT_CHARS = 20_000;
export const MAX_INTENT_CHARS = 500;
export const MAX_REASON_CHARS = 500;
export const MAX_POLICY_OVERRIDES = 50;
/** The most a caller may ask a single wait to last; the config may lower it. */
export const MAX_WAIT_MS = 50_000;
export const MAX_LOG_LIMIT = 200;
/** The most characters one page of output may hold, whatever is asked. */
export const MAX_PAGE_CHARS = 60_000;

const WORKER_REF_PATTERN = /^(w_[a-z0-9]{8}|[A-Za-z0-9_-]{1,64})$/;

/** A worker's id (`w_…`) or the name it was given at spawn. */
export const WorkerRef = z
	.string()
	.regex(
		WORKER_REF_PATTERN,
		"must be a worker id (w_ and 8 characters) or a name of 1-64 letters, digits, '_' or '-'",
	);

export const RunId = z
	.string()
	.regex(/^r_[A-Za-z0-9]{10,32}$/, "must be a run id (r_…)");

export const ApprovalId = z
	.string()
	.regex(/^a_[a-z0-9]{10}$/, "must be an approval id (a_…)");

const AbsolutePath = z
	.string()
	.min(1)
	.max(4096)
	.refine((p) => path.isAbsolute(p), "must be an absolute path");

const name = z
	.string()
	.regex(
		WORKER_NAME_PATTERN,
		"use 1-64 characters from A-Z, a-z, 0-9, '_', '-'",
	);

const level = z.union([z.number().int().min(0).max(3), z.string().max(16)]);

/** Risk policy; the deeper checks are in the gate's own validator. */
export const RiskPolicy = z
	.strictObject({
		autoApproveUpTo: level
			.optional()
			.describe(
				"Risk level (0=LOW, 1=MEDIUM, 2=HIGH, 3=CRITICAL) up to which calls are auto-approved. Default 0 (LOW).",
			),
		classifiers: z.enum(["on", "off"]).optional(),
		overrides: z
			.array(
				z.strictObject({
					match: z
						.looseObject({
							kind: z.string().max(32).optional(),
							tool: z.string().max(200).optional(),
							command: z.string().max(500).optional(),
							path: z.string().max(4096).optional(),
						})
						.optional()
						.describe(
							"Every field given must match. `tool` is pi's tool name (bash, read, write, edit, grep, find, ls), `kind` the canonical kind (shell, read, list, search, write, edit), `command` a shell command, `path` an absolute or workspace-relative path.",
						),
					action: z
						.string()
						.max(16)
						.optional()
						.describe(
							"allow: auto-approve (up to maxRiskLevel; never a protected path, and outside the workspace only with a matching path). escalate: always ask. deny: refuse without asking.",
						),
					maxRiskLevel: level
						.optional()
						.describe(
							"For allow: only up to this level. Default 1 (MEDIUM); limited by the server's ceiling.",
						),
				}),
			)
			.max(MAX_POLICY_OVERRIDES)
			.optional()
			.describe(
				"At most 50, checked in order; the first match decides. Glob patterns: `*` matches any run of characters (in `command` it stops at shell metacharacters).",
			),
	})
	.describe(
		"Auto-approval policy. Calls at or below autoApproveUpTo are allowed without asking; everything else waits for the coordinator. The server lowers the policy to its own ceiling (default MEDIUM) and says so in the result. Calls that touch protected paths are never auto-approved, whatever the policy says.",
	);

const waitMs = z
	.number()
	.int()
	.min(0)
	.max(MAX_WAIT_MS)
	.describe(
		"How long to wait, in ms (at most 50 000; the server may allow less).",
	);

const ref = (what: string) => WorkerRef.describe(`${what} (id or name).`);

export const schemas = {
	listProviders: z.strictObject({}),
	spawnWorker: z.strictObject({
		cwd: AbsolutePath.describe(
			"The absolute directory the worker runs in. It must exist, be a directory and, when the server restricts workspaces, lie inside an allowed root.",
		),
		provider: z
			.string()
			.regex(/^[a-z][a-z0-9-]{0,31}$/, "a provider id such as pi")
			.optional()
			.describe("A provider id from list_providers. Default: the first one."),
		name: name
			.optional()
			.describe(
				"A name for the worker, unique among live workers. Every tool taking a workerId accepts it instead of the generated id.",
			),
		model: z
			.string()
			.max(200)
			.optional()
			.describe("Model override, as `<provider>/<model>`."),
		systemPrompt: z
			.string()
			.max(MAX_SYSTEM_PROMPT_CHARS)
			.optional()
			.describe("Extra system instructions for the worker."),
		policy: RiskPolicy.optional(),
		sandbox: z
			.enum(["none", "workspace"])
			.optional()
			.describe(
				"How the worker is confined. \"workspace\" (Linux, bubblewrap): the worker can write only its workspace, and cannot see the home directory (such as ~/.ssh). Default: the server's default; it can never be lower than the server's minimum (list_providers shows both).",
			),
	}),
	getPendingActions: z.strictObject({
		workerId: ref("Only this worker's approvals").optional(),
		runId: RunId.optional().describe("Only this run's approvals."),
	}),
	listWorkers: z.strictObject({}),
	setRiskPolicy: z.strictObject({
		workerId: ref("The worker"),
		policy: RiskPolicy,
	}),
	getGateLog: z.strictObject({
		workerId: ref("The worker"),
		limit: z
			.number()
			.int()
			.min(1)
			.max(MAX_LOG_LIMIT)
			.optional()
			.describe("At most this many of the newest entries (max 200)."),
		decidedBy: z
			.string()
			.max(32)
			.optional()
			.describe(
				"Only entries decided by this: rules, cache, coordinator, timeout, cancel or http:<name> for a classifier.",
			),
	}),
	terminateWorker: z.strictObject({ workerId: ref("The worker") }),
	startRun: z.strictObject({
		workerId: WorkerRef.describe("The worker's id or name."),
		prompt: z.string().min(1).max(MAX_PROMPT_CHARS).describe("The task."),
		intent: z
			.string()
			.max(MAX_INTENT_CHARS)
			.optional()
			.describe(
				"A one-line summary of the task (max 500 characters). In auto mode the HTTP classifiers judge each call against it, so name the checks or commands you expect the worker to run.",
			),
		waitMs: waitMs
			.optional()
			.describe(
				"Wait up to this long (max 50 000) for the run to end or need an approval. Default 0: return at once.",
			),
	}),
	waitRun: z.strictObject({
		runId: RunId.describe("The run to wait for."),
		waitMs: waitMs.optional(),
		sinceSeq: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe(
				"The `seq` of the last view. Approvals already reported at or before it do not end the wait.",
			),
		outputOffset: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe("Return output from this offset (the last `nextOffset`)."),
	}),
	getRun: z.strictObject({
		runId: RunId,
		part: z.enum(["final", "transcript"]).optional(),
		offset: z.number().int().min(0).optional(),
		maxChars: z.number().int().min(1).max(MAX_PAGE_CHARS).optional(),
	}),
	cancelRun: z.strictObject({ runId: RunId }),
	approve: z.strictObject({
		approvalId: ApprovalId,
		workerId: ref("Optional: the worker the approval belongs to").optional(),
		remember: z
			.enum(["none", "worker"])
			.optional()
			.describe(
				'"worker": also allow identical calls (same tool, command, paths and arguments) from this worker without asking, until it is terminated or its policy changes. Ignored for hard limits, protected paths and CRITICAL calls. Default "none".',
			),
	}),
	reject: z.strictObject({
		approvalId: ApprovalId,
		workerId: ref("Optional: the worker the approval belongs to").optional(),
		reason: z
			.string()
			.max(MAX_REASON_CHARS)
			.optional()
			.describe(
				"Optional feedback or reason for rejection to guide the agent.",
			),
	}),
};
