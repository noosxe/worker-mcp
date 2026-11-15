import * as http from "node:http";
import * as https from "node:https";

import { z } from "zod";

import type { HttpClassifierConfig } from "../config.js";
import { capArguments } from "./cap-arguments.js";
import {
	ClassifierFailure,
	type Classifier,
	type ClassifierResult,
	type ClassifyRequest,
	type Thresholds,
} from "./classifier.js";
import { jev } from "./jev.js";

export { capArguments };
import { RISK_LABELS, RiskLevel } from "./risk.js";

/** The version string of the provisional request and response format. */
export const CLASSIFIER_API_VERSION = "1-provisional";
export const CLASSIFIER_API_HEADER = "X-Worker-MCP-Classifier-API";
/** A response larger than this is a failure. */
export const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_PATHS = 50;
const RETRY_BACKOFF_MS = 300;
const MAX_ATTEMPTS = 3;
/** The least time left that makes a retry worth sending. */
const MIN_ATTEMPT_MS = 400;
/** A queued call that gets its turn with less than this is not sent. */
const queuedFloorMs = (timeoutMs: number) => Math.max(100, timeoutMs * 0.1);

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Why a classifier URL is not allowed, or null: https, or http on loopback. */
export function classifierUrlProblem(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return "is not a valid URL";
	}
	if (url.username || url.password) {
		return "must not carry credentials (the token goes in tokenFile)";
	}
	if (url.protocol === "https:") return null;
	if (url.protocol === "http:") {
		return LOOPBACK.has(url.hostname.toLowerCase())
			? null
			: "uses http: only localhost, 127.0.0.1 and [::1] may; use https";
	}
	return "must use https (or http on loopback)";
}

/**
 * A wire format: how a classification request is written and how the answer is
 * read. A second classifier service with its own API is a second dialect.
 */
export interface Dialect {
	readonly name: string;
	/** Appended to the configured URL's path to form the endpoint. */
	readonly path?: string;
	/** At most one request in flight per classifier; later calls queue. */
	readonly singleFlight?: boolean;
	/** Retry 429, 5xx and network errors while the call's deadline allows. */
	readonly retry?: boolean;
	/** The JSON body and extra headers of a request. */
	request(
		req: ClassifyRequest,
		cfg: HttpClassifierConfig,
	): { body: unknown; headers: Record<string, string> };
	/** Throws on anything that is not a valid answer to `req`. */
	response(
		json: unknown,
		req: ClassifyRequest,
		cfg: HttpClassifierConfig,
	): ClassifierResult;
}

/** A failure that another attempt may cure (429, 5xx, network). */
export class RetryableFailure extends ClassifierFailure {
	override name = "RetryableFailure";
}
/** The call's deadline ran out while it waited for its turn. */
export class QueueTimeout extends ClassifierFailure {
	override name = "QueueTimeout";
}

// ---- dialect worker-mcp-v1 ---------------------------------------------------

const riskLabel = (level: RiskLevel | undefined) =>
	level === undefined ? undefined : RISK_LABELS[level];

const v1Response = z
	.object({
		requestId: z.string(),
		verdict: z.enum(["allow", "deny", "escalate"]),
		confidence: z.number().min(0).max(1).optional(),
		reason: z.string().max(1000),
		riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
		cacheTtlMs: z
			.number()
			.int()
			.positive()
			.max(Number.MAX_SAFE_INTEGER)
			.optional(),
	})
	.refine((r) => r.verdict === "escalate" || r.confidence !== undefined, {
		message: "confidence is required for allow and deny",
		path: ["confidence"],
	});

export const workerMcpV1: Dialect = {
	name: "worker-mcp-v1",
	request(req, cfg) {
		const { call, context } = req;
		const capped = capArguments(call.input, cfg.maxArgumentBytes);
		const command =
			call.command === undefined
				? undefined
				: call.command.slice(0, cfg.maxArgumentBytes);
		const assessment = context.ruleAssessment;
		return {
			headers: {},
			body: {
				version: CLASSIFIER_API_VERSION,
				requestId: req.requestId,
				action: {
					kind: call.kind,
					tool: call.rawName,
					provider: call.provider,
					arguments: capped.arguments,
					argumentsTruncated:
						capped.truncated ||
						(call.command !== undefined && command !== call.command),
					...(command === undefined ? {} : { command }),
					paths: call.paths.slice(0, MAX_PATHS).map((p) => ({
						path: p.abs,
						inWorkspace: p.inWorkspace,
					})),
					depth: call.origin.depth,
				},
				context: {
					cwd: context.cwd,
					workerId: context.workerId,
					runId: context.runId,
					provider: context.provider,
					model: context.model,
					...(cfg.sendIntent && context.intent !== undefined
						? { intent: context.intent }
						: {}),
					intentProvided: context.intent !== undefined,
					recentActions: context.recentActions ?? [],
					ruleAssessment: assessment
						? {
								riskLevel: riskLabel(assessment.level),
								ruleId: assessment.ruleId,
								reason: assessment.reason,
							}
						: undefined,
				},
			},
		};
	},
	response(json, req) {
		const parsed = v1Response.safeParse(json);
		if (!parsed.success) {
			throw new ClassifierFailure(
				`invalid response: ${parsed.error.issues
					.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
					.join("; ")
					.slice(0, 300)}`,
			);
		}
		const r = parsed.data;
		if (r.requestId !== req.requestId) {
			throw new ClassifierFailure("invalid response: requestId does not match");
		}
		return {
			verdict: r.verdict,
			confidence: r.confidence,
			reason: r.reason,
			riskLevel: r.riskLevel === undefined ? undefined : RiskLevel[r.riskLevel],
			cacheTtlMs: r.cacheTtlMs,
		};
	},
};

export const DIALECTS: Record<string, Dialect> = {
	[workerMcpV1.name]: workerMcpV1,
	[jev.name]: jev,
};

// ---- transport ---------------------------------------------------------------

interface PostOptions {
	url: URL;
	headers: Record<string, string>;
	body: string;
	timeoutMs: number;
	signal: AbortSignal;
}

/**
 * One POST with a hard deadline and a response cap. It uses `node:http`
 * directly: no redirect is followed and no proxy variable is consulted.
 */
function post(o: PostOptions): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			o.signal.removeEventListener("abort", onAbort);
			fn();
		};
		const secure = o.url.protocol === "https:";
		const req = (secure ? https : http).request(
			{
				method: "POST",
				hostname: o.url.hostname.replace(/^\[|\]$/g, ""),
				port: o.url.port || (secure ? 443 : 80),
				path: `${o.url.pathname}${o.url.search}`,
				headers: {
					...o.headers,
					"Content-Length": String(Buffer.byteLength(o.body)),
				},
				agent: false,
			},
			(res) => {
				const declared = Number(res.headers["content-length"]);
				if (declared > MAX_RESPONSE_BYTES) {
					req.destroy();
					finish(() => reject(new ClassifierFailure("response too large")));
					return;
				}
				const chunks: Buffer[] = [];
				let total = 0;
				res.on("data", (chunk: Buffer) => {
					total += chunk.length;
					if (total > MAX_RESPONSE_BYTES) {
						req.destroy();
						finish(() => reject(new ClassifierFailure("response too large")));
						return;
					}
					chunks.push(chunk);
				});
				res.on("end", () =>
					finish(() =>
						resolve({
							status: res.statusCode ?? 0,
							body: Buffer.concat(chunks).toString("utf8"),
						}),
					),
				);
				res.on("error", (e) =>
					finish(() =>
						reject(new ClassifierFailure(`transport: ${e.message}`)),
					),
				);
			},
		);
		const timer = setTimeout(() => {
			req.destroy();
			finish(() =>
				reject(new ClassifierFailure(`no answer within ${o.timeoutMs} ms`)),
			);
		}, o.timeoutMs);
		const onAbort = () => {
			req.destroy();
			finish(() => reject(new ClassifierFailure("request aborted")));
		};
		if (o.signal.aborted) return onAbort();
		o.signal.addEventListener("abort", onAbort, { once: true });
		req.on("error", (e) =>
			finish(() =>
				reject(
					new ClassifierFailure(
						`transport: ${(e as NodeJS.ErrnoException).code ?? e.message}`,
					),
				),
			),
		);
		req.end(o.body);
	});
}

export interface HttpClassifierOptions {
	/** The bearer token, read when a request is made (so a reload takes effect). */
	token?: () => string | undefined;
	/** The server's version, for the User-Agent. */
	version?: string;
	now?: () => number;
	dialect?: Dialect;
}

/**
 * A classifier that asks an HTTP service. Any failure (transport, timeout,
 * status, size, JSON, schema) throws a `ClassifierFailure`, which the chain
 * turns into an escalation or a denial. After `breaker.failures` failures in a
 * row it is skipped for `breaker.coolDownMs`, then one request is let through
 * to see whether it has recovered.
 */
export class HttpClassifier implements Classifier {
	readonly id: string;
	readonly thresholds: Thresholds;
	private readonly url: URL;
	private readonly dialect: Dialect;
	private readonly now: () => number;
	private busy = false;
	private readonly waiting: (() => void)[] = [];
	private consecutiveFailures = 0;
	private openUntil = 0;

	constructor(
		private readonly cfg: HttpClassifierConfig,
		private readonly opts: HttpClassifierOptions = {},
	) {
		const problem = classifierUrlProblem(cfg.url);
		if (problem) {
			throw new ClassifierFailure(`classifier ${cfg.name}: url ${problem}`);
		}
		this.id = `http:${cfg.name}`;
		this.url = new URL(cfg.url);
		this.thresholds = {
			minAllowConfidence: cfg.minAllowConfidence,
			minDenyConfidence: cfg.minDenyConfidence,
		};
		const dialect = opts.dialect ?? DIALECTS[cfg.dialect];
		if (!dialect) {
			throw new ClassifierFailure(
				`classifier ${cfg.name}: unknown dialect ${cfg.dialect}`,
			);
		}
		this.dialect = dialect;
		if (dialect.path) {
			this.url.pathname = `${this.url.pathname.replace(/\/+$/, "")}${dialect.path}`;
		}
		this.now = opts.now ?? Date.now;
	}

	/** Whether the breaker is open now. */
	get open(): boolean {
		return this.now() < this.openUntil;
	}

	async classify(
		req: ClassifyRequest,
		signal: AbortSignal,
	): Promise<ClassifierResult> {
		if (this.open) throw new ClassifierFailure("circuit open: skipped");
		try {
			const result = await this.ask(req, signal);
			this.consecutiveFailures = 0;
			return result;
		} catch (e) {
			if (e instanceof QueueTimeout) throw e; // load, not a sick server
			this.consecutiveFailures++;
			if (this.consecutiveFailures >= this.cfg.breaker.failures) {
				this.openUntil = this.now() + this.cfg.breaker.coolDownMs;
			}
			throw e;
		}
	}

	/** Wait for this classifier's turn; gives up when `deadline` passes. */
	private acquire(deadline: number, signal: AbortSignal): Promise<() => void> {
		const release = () => {
			const next = this.waiting.shift();
			if (next) next();
			else this.busy = false;
		};
		if (!this.busy) {
			this.busy = true;
			return Promise.resolve(release);
		}
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
			};
			const turn = () => {
				cleanup();
				resolve(release);
			};
			const leave = (e: Error) => {
				const at = this.waiting.indexOf(turn);
				if (at >= 0) this.waiting.splice(at, 1);
				cleanup();
				reject(e);
			};
			const timer = setTimeout(
				() =>
					leave(
						new QueueTimeout(
							`no answer within ${this.cfg.timeoutMs} ms (waited for an earlier request)`,
						),
					),
				Math.max(0, deadline - this.now()),
			);
			const onAbort = () => leave(new ClassifierFailure("request aborted"));
			if (signal.aborted) return onAbort();
			signal.addEventListener("abort", onAbort, { once: true });
			this.waiting.push(turn);
		});
	}

	private async ask(
		req: ClassifyRequest,
		signal: AbortSignal,
	): Promise<ClassifierResult> {
		// One deadline for the whole call: waiting, requests and retries.
		const deadline = this.now() + this.cfg.timeoutMs;
		if (!this.dialect.singleFlight) return this.attempts(req, signal, deadline);
		const release = await this.acquire(deadline, signal);
		try {
			// A request that cannot finish would only hold the one slot.
			if (deadline - this.now() < queuedFloorMs(this.cfg.timeoutMs)) {
				throw new QueueTimeout(
					`no answer within ${this.cfg.timeoutMs} ms (waited for an earlier request)`,
				);
			}
			return await this.attempts(req, signal, deadline);
		} finally {
			release();
		}
	}

	private async attempts(
		req: ClassifyRequest,
		signal: AbortSignal,
		deadline: number,
	): Promise<ClassifierResult> {
		let backoff = RETRY_BACKOFF_MS;
		for (let attempt = 1; ; attempt++) {
			try {
				return await this.once(req, signal, deadline);
			} catch (e) {
				const wait = backoff;
				if (
					!this.dialect.retry ||
					!(e instanceof RetryableFailure) ||
					attempt >= MAX_ATTEMPTS ||
					signal.aborted ||
					// Not worth another request unless there is time to answer it.
					this.now() + wait + MIN_ATTEMPT_MS > deadline
				) {
					throw e;
				}
				await new Promise<void>((resolve) => {
					const t = setTimeout(done, wait);
					function done() {
						clearTimeout(t);
						signal.removeEventListener("abort", done);
						resolve();
					}
					signal.addEventListener("abort", done, { once: true });
				});
				backoff *= 2;
			}
		}
	}

	private async once(
		req: ClassifyRequest,
		signal: AbortSignal,
		deadline: number,
	): Promise<ClassifierResult> {
		const { body, headers: extra } = this.dialect.request(req, this.cfg);
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json",
			"User-Agent": `worker-mcp/${this.opts.version ?? "0"}`,
			[CLASSIFIER_API_HEADER]: CLASSIFIER_API_VERSION,
			...extra,
		};
		const token = this.opts.token?.();
		if (token !== undefined) headers.Authorization = `Bearer ${token}`;
		const res = await post({
			url: this.url,
			headers,
			body: JSON.stringify(body),
			timeoutMs: Math.max(1, deadline - this.now()),
			signal,
		});
		if (res.status < 200 || res.status > 299) {
			const msg = `HTTP status ${res.status}`;
			throw res.status === 429 || res.status >= 500
				? new RetryableFailure(msg)
				: new ClassifierFailure(msg);
		}
		let json: unknown;
		try {
			json = JSON.parse(res.body);
		} catch {
			throw new ClassifierFailure("invalid response: not JSON");
		}
		return this.dialect.response(json, req, this.cfg);
	}
}
