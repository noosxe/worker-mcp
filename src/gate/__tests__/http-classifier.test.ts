import assert from "node:assert";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import test, { afterEach, beforeEach, describe } from "node:test";

import type { HttpClassifierConfig } from "../../config.js";
import { DecisionCache } from "../cache.js";
import type { GateOutcome } from "../classifier.js";
import { Gate } from "../gate.js";
import {
	CLASSIFIER_API_HEADER,
	capArguments,
	classifierUrlProblem,
	HttpClassifier,
	MAX_RESPONSE_BYTES,
} from "../http-classifier.js";
import { RiskLevel } from "../risk.js";
import { decide, fixture, type Fixture } from "./helpers.js";

interface Seen {
	headers: http.IncomingHttpHeaders;
	body: any;
}

type Reply = (
	req: Seen,
	res: http.ServerResponse,
) => void | Promise<void> | "none";

let fx: Fixture;
let servers: http.Server[];
beforeEach(() => {
	fx = fixture();
	servers = [];
});
afterEach(async () => {
	fx.cleanup();
	for (const s of servers) {
		s.closeAllConnections();
		await new Promise((r) => s.close(r));
	}
});

/** A loopback server on a free port; `seen` records each request. */
async function serve(reply: Reply) {
	const seen: Seen[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			const entry = { headers: req.headers, body };
			seen.push(entry);
			void reply(entry, res);
		});
	});
	servers.push(server);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/classify`;
	return { seen, url, server };
}

const json = (res: http.ServerResponse, body: unknown, status = 200) => {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
};

/** Answers with `fields` merged over a valid allow for the request. */
const answer =
	(fields: Record<string, unknown> | ((r: Seen) => Record<string, unknown>)) =>
	(r: Seen, res: http.ServerResponse) =>
		json(res, {
			requestId: r.body.requestId,
			verdict: "allow",
			confidence: 0.95,
			reason: "fine",
			...(typeof fields === "function" ? fields(r) : fields),
		});

const config = (
	url: string,
	over: Partial<HttpClassifierConfig> = {},
): HttpClassifierConfig => ({
	name: "t",
	url,
	dialect: "worker-mcp-v1",
	timeoutMs: 2000,
	minAllowConfidence: 0.85,
	minDenyConfidence: 0.6,
	maxArgumentBytes: 8192,
	sendIntent: true,
	breaker: { failures: 5, coolDownMs: 60_000 },
	...over,
});

function gateFor(
	classifier: HttpClassifier | HttpClassifier[],
	opts: Partial<ConstructorParameters<typeof Gate>[0]> = {},
) {
	return fx.gate({
		classifiers: Array.isArray(classifier) ? classifier : [classifier],
		mode: "auto",
		workerId: "w_aaaaaaaa",
		...opts,
	});
}

const HIGH = { command: "rm file" };

async function run(
	gate: Gate,
	tool = "bash",
	input: Record<string, unknown> = HIGH,
): Promise<GateOutcome> {
	return await decide(gate, tool, input);
}

describe("http classifier: verdicts and thresholds", () => {
	test("an allow with enough confidence is allowed, and the request is as documented", async () => {
		const s = await serve(answer({ riskLevel: "MEDIUM" }));
		const gate = gateFor(new HttpClassifier(config(s.url), { version: "9.9" }));
		const out = await gate.decide(
			{ provider: "pi", toolName: "bash", input: HIGH },
			"call1",
			{ runId: "r_1", intent: "tidy the repo" },
		);
		assert.strictEqual(out.decision, "allow");
		assert.strictEqual(out.decidedBy, "http:t");
		assert.strictEqual(out.consulted[1].confidence, 0.95);
		const req = s.seen[0];
		assert.strictEqual(
			req.headers[CLASSIFIER_API_HEADER.toLowerCase()],
			"1-provisional",
		);
		assert.strictEqual(req.headers["user-agent"], "worker-mcp/9.9");
		assert.strictEqual(req.headers.authorization, undefined);
		assert.strictEqual(req.body.version, "1-provisional");
		assert.strictEqual(req.body.action.kind, "shell");
		assert.strictEqual(req.body.action.tool, "bash");
		assert.deepStrictEqual(req.body.action.arguments, HIGH);
		assert.strictEqual(req.body.action.argumentsTruncated, false);
		assert.strictEqual(req.body.action.command, "rm file");
		assert.strictEqual(req.body.context.intent, "tidy the repo");
		assert.strictEqual(req.body.context.intentProvided, true);
		assert.strictEqual(req.body.context.runId, "r_1");
		assert.strictEqual(req.body.context.workerId, "w_aaaaaaaa");
		assert.strictEqual(req.body.context.ruleAssessment.riskLevel, "HIGH");
		assert.deepStrictEqual(req.body.context.recentActions, []);
	});

	test("recentActions carries summaries of earlier decisions", async () => {
		const s = await serve(answer({}));
		const gate = gateFor(new HttpClassifier(config(s.url)));
		await run(gate, "bash", { command: "ls" }); // LOW, by the rules
		await run(gate);
		const recent = s.seen[0].body.context.recentActions;
		assert.strictEqual(recent.length, 1);
		assert.deepStrictEqual(recent[0], {
			kind: "shell",
			tool: "bash",
			summary: "ls",
			verdict: "allow",
			by: "rules",
		});
	});

	test("sendIntent false keeps the intent back", async () => {
		const s = await serve(answer({}));
		const gate = gateFor(
			new HttpClassifier(config(s.url, { sendIntent: false })),
		);
		await gate.decide({ provider: "pi", toolName: "bash", input: HIGH }, "c", {
			intent: "secret plan",
		});
		assert.strictEqual(s.seen[0].body.context.intent, undefined);
		assert.strictEqual(s.seen[0].body.context.intentProvided, true);
	});

	test("deny needs 0.6, allow needs 0.85; below that the coordinator is asked", async () => {
		for (const [verdict, confidence, decision, because] of [
			["deny", 0.7, "deny", undefined],
			["deny", 0.5, "escalate", "low_confidence"],
			["allow", 0.86, "allow", undefined],
			["allow", 0.8, "escalate", "low_confidence"],
			["escalate", 0.99, "escalate", "low_confidence"],
		] as const) {
			const s = await serve(answer({ verdict, confidence }));
			const out = await run(gateFor(new HttpClassifier(config(s.url))));
			assert.strictEqual(out.decision, decision, `${verdict} ${confidence}`);
			assert.strictEqual(out.escalatedBecause, because);
		}
	});

	test("thresholds are configurable", async () => {
		const s = await serve(answer({ confidence: 0.5 }));
		const out = await run(
			gateFor(new HttpClassifier(config(s.url, { minAllowConfidence: 0.4 }))),
		);
		assert.strictEqual(out.decision, "allow");
	});

	test("extra response fields are ignored", async () => {
		const s = await serve(answer({ extra: { nested: true }, mutate: {} }));
		const out = await run(gateFor(new HttpClassifier(config(s.url))));
		assert.strictEqual(out.decision, "allow");
	});
});

describe("http classifier: every failure escalates", () => {
	const bad: [string, Reply][] = [
		[
			"missing confidence",
			(r, res) =>
				json(res, {
					requestId: r.body.requestId,
					verdict: "allow",
					reason: "x",
				}),
		],
		["confidence above 1", answer({ confidence: 1.5 })],
		["negative confidence", answer({ confidence: -0.1 })],
		["string confidence", answer({ confidence: "0.9" })],
		["requestId mismatch", answer({ requestId: "g_other" })],
		["unknown verdict", answer({ verdict: "mutate" })],
		["missing reason", answer({ reason: undefined })],
		["overlong reason", answer({ reason: "x".repeat(1001) })],
		["bad cacheTtlMs", answer({ cacheTtlMs: -5 })],
		["non-2xx", (_r, res) => json(res, { verdict: "allow" }, 500)],
		["404", (_r, res) => json(res, {}, 404)],
		[
			"invalid JSON",
			(_r, res) => {
				res.writeHead(200);
				res.end("{not json");
			},
		],
		["a JSON array", (_r, res) => json(res, [])],
		[
			"an oversized body",
			(_r, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({ reason: "x".repeat(MAX_RESPONSE_BYTES + 100) }),
				);
			},
		],
	];
	for (const [name, reply] of bad) {
		test(name, async () => {
			const s = await serve(reply);
			const out = await run(gateFor(new HttpClassifier(config(s.url))));
			assert.strictEqual(out.decision, "escalate");
			assert.strictEqual(out.escalatedBecause, "classifier_error");
			assert.ok(out.consulted[1].error, "the failure is recorded");
		});
	}

	test("a timeout", async () => {
		const s = await serve(() => "none"); // never answers
		const began = Date.now();
		const out = await run(
			gateFor(new HttpClassifier(config(s.url, { timeoutMs: 150 }))),
		);
		assert.strictEqual(out.decision, "escalate");
		assert.match(out.consulted[1].error ?? "", /no answer within 150/);
		assert.ok(Date.now() - began < 2000);
	});

	test("a refused connection", async () => {
		const s = await serve(answer({}));
		const url = s.url;
		s.server.closeAllConnections();
		await new Promise((r) => s.server.close(r));
		servers.length = 0;
		const out = await run(gateFor(new HttpClassifier(config(url))));
		assert.strictEqual(out.decision, "escalate");
		assert.match(out.consulted[1].error ?? "", /transport/);
	});

	test("a redirect is not followed", async () => {
		const target = await serve(answer({}));
		const s = await serve((_r, res) => {
			res.writeHead(307, { Location: target.url });
			res.end();
		});
		const out = await run(gateFor(new HttpClassifier(config(s.url))));
		assert.strictEqual(out.decision, "escalate");
		assert.match(out.consulted[1].error ?? "", /status 307/);
		assert.strictEqual(target.seen.length, 0);
	});

	test("onClassifierFailure deny denies instead", async () => {
		const s = await serve((_r, res) => json(res, {}, 500));
		const out = await run(
			gateFor(new HttpClassifier(config(s.url)), {
				onClassifierFailure: "deny",
			}),
		);
		assert.strictEqual(out.decision, "deny");
		assert.strictEqual(out.decidedBy, "http:t");
		assert.match(out.reason, /did not answer/);
	});

	test("a later classifier is tried after a failure", async () => {
		const down = await serve((_r, res) => json(res, {}, 500));
		const up = await serve(answer({}));
		const out = await run(
			gateFor([
				new HttpClassifier(config(down.url, { name: "a" })),
				new HttpClassifier(config(up.url, { name: "b" })),
			]),
		);
		assert.strictEqual(out.decision, "allow");
		assert.strictEqual(out.decidedBy, "http:b");
	});
});

describe("http classifier: transport rules", () => {
	test("https, or http on loopback only", () => {
		assert.strictEqual(classifierUrlProblem("https://example.com/x"), null);
		assert.strictEqual(classifierUrlProblem("http://127.0.0.1:1/x"), null);
		assert.strictEqual(classifierUrlProblem("http://localhost/x"), null);
		assert.strictEqual(classifierUrlProblem("http://[::1]:8/x"), null);
		assert.match(classifierUrlProblem("http://example.com/x") ?? "", /https/);
		assert.match(
			classifierUrlProblem("http://127.0.0.1.evil.com/") ?? "",
			/https/,
		);
		assert.match(classifierUrlProblem("ftp://localhost/") ?? "", /https/);
		assert.match(
			classifierUrlProblem("https://u:p@example.com/") ?? "",
			/credentials/,
		);
		assert.match(classifierUrlProblem("nope") ?? "", /valid URL/);
		assert.throws(
			() => new HttpClassifier(config("http://example.com/x")),
			/https/,
		);
	});

	test("a bearer token is sent, and never appears in a failure", async () => {
		const s = await serve((_r, res) => json(res, {}, 500));
		const c = new HttpClassifier(config(s.url), {
			token: () => "s3cr3t-token",
		});
		const out = await run(gateFor(c));
		assert.strictEqual(s.seen[0].headers.authorization, "Bearer s3cr3t-token");
		assert.ok(!JSON.stringify(out).includes("s3cr3t-token"));
		assert.ok(
			!JSON.stringify(gateFor(c).log.entries()).includes("s3cr3t-token"),
		);
	});

	test("large arguments are cut and flagged", async () => {
		const s = await serve(answer({}));
		const gate = gateFor(
			new HttpClassifier(config(s.url, { maxArgumentBytes: 1024 })),
		);
		await run(gate, "bash", { command: `rm ${"a".repeat(50_000)}` });
		const action = s.seen[0].body.action;
		assert.strictEqual(action.argumentsTruncated, true);
		assert.ok(Buffer.byteLength(JSON.stringify(action.arguments)) <= 1024);
		assert.ok(action.command.length <= 1024);
	});

	test("capArguments keeps small input and bounds odd shapes", () => {
		assert.deepStrictEqual(capArguments({ a: 1 }, 100), {
			arguments: { a: 1 },
			truncated: false,
		});
		const many = Object.fromEntries(
			Array.from({ length: 500 }, (_, i) => [`k${i}`, i]),
		);
		const capped = capArguments(many, 256);
		assert.strictEqual(capped.truncated, true);
		assert.ok(Buffer.byteLength(JSON.stringify(capped.arguments)) <= 400);
	});
});

describe("http classifier: breaker", () => {
	test("it opens after the failures, skips, then probes after the cool-down", async () => {
		let healthy = false;
		const s = await serve((r, res) =>
			healthy ? answer({})(r, res) : json(res, {}, 500),
		);
		let now = 1_000_000;
		const c = new HttpClassifier(
			config(s.url, { breaker: { failures: 2, coolDownMs: 1000 } }),
			{ now: () => now },
		);
		const gate = gateFor(c);
		await run(gate);
		await run(gate);
		assert.strictEqual(c.open, true);
		const skipped = await run(gate);
		assert.strictEqual(s.seen.length, 2, "no request while open");
		assert.match(skipped.consulted[1].error ?? "", /circuit open/);
		assert.strictEqual(skipped.decision, "escalate");

		now += 1001;
		healthy = true;
		const probe = await run(gate);
		assert.strictEqual(probe.decision, "allow");
		assert.strictEqual(c.open, false);
		await run(gate, "bash", { command: "rm other" });
		assert.strictEqual(s.seen.length, 4);
	});

	test("a failed probe opens it again", async () => {
		const s = await serve((_r, res) => json(res, {}, 500));
		let now = 0;
		const c = new HttpClassifier(
			config(s.url, { breaker: { failures: 1, coolDownMs: 1000 } }),
			{ now: () => now },
		);
		const gate = gateFor(c);
		await run(gate);
		assert.strictEqual(c.open, true);
		now = 1500;
		assert.strictEqual(c.open, false);
		await run(gate);
		assert.strictEqual(s.seen.length, 2);
		assert.strictEqual(c.open, true);
	});

	test("an escalate verdict is not a failure", async () => {
		const s = await serve(answer({ verdict: "escalate" }));
		const c = new HttpClassifier(
			config(s.url, { breaker: { failures: 1, coolDownMs: 60_000 } }),
		);
		const gate = gateFor(c);
		await run(gate);
		assert.strictEqual(c.open, false);
	});
});

describe("decision cache", () => {
	test("a decisive verdict is reused, per worker, until it expires", async () => {
		const s = await serve(answer({ cacheTtlMs: 1000 }));
		let now = 0;
		const cache = new DecisionCache({
			maxEntries: 10,
			maxTtlMs: 60_000,
			now: () => now,
		});
		const c = new HttpClassifier(config(s.url));
		const a = gateFor(c, { cache, workerId: "w_aaaaaaaa" });
		const b = gateFor(c, { cache, workerId: "w_bbbbbbbb" });

		await run(a);
		const hit = await run(a);
		assert.strictEqual(s.seen.length, 1);
		assert.strictEqual(hit.decision, "allow");
		assert.strictEqual(hit.decidedBy, "http:t");
		assert.strictEqual(hit.consulted[1].cached, true);

		await run(b); // another worker: no sharing
		assert.strictEqual(s.seen.length, 2);

		await run(a, "bash", { command: "rm other" }); // another call
		assert.strictEqual(s.seen.length, 3);

		now = 1001; // expired
		await run(a);
		assert.strictEqual(s.seen.length, 4);
	});

	test("a policy change clears the worker's entries, and only its own", async () => {
		const s = await serve(answer({ cacheTtlMs: 60_000 }));
		const cache = new DecisionCache({ maxEntries: 10, maxTtlMs: 60_000 });
		const c = new HttpClassifier(config(s.url));
		const a = gateFor(c, { cache, workerId: "w_aaaaaaaa" });
		const b = gateFor(c, { cache, workerId: "w_bbbbbbbb" });
		await run(a);
		await run(b);
		assert.strictEqual(s.seen.length, 2);
		a.setPolicy({ autoApproveUpTo: RiskLevel.LOW, overrides: [] });
		await run(a);
		await run(b);
		assert.strictEqual(s.seen.length, 3, "a asked again, b stayed cached");
		a.forget();
		await run(a);
		assert.strictEqual(s.seen.length, 4);
	});

	test("denials are cached; escalations, failures and no-ttl answers are not", async () => {
		const s = await serve(answer({ verdict: "deny", cacheTtlMs: 60_000 }));
		const cache = new DecisionCache({ maxEntries: 10, maxTtlMs: 60_000 });
		const gate = gateFor(new HttpClassifier(config(s.url)), { cache });
		await run(gate);
		assert.strictEqual((await run(gate)).decision, "deny");
		assert.strictEqual(s.seen.length, 1);

		for (const fields of [
			{ verdict: "escalate" },
			{ cacheTtlMs: undefined },
			{ confidence: 0.1 },
		]) {
			const t = await serve(answer({ cacheTtlMs: 60_000, ...fields }));
			const c2 = new DecisionCache({ maxEntries: 10, maxTtlMs: 60_000 });
			const g = gateFor(new HttpClassifier(config(t.url)), { cache: c2 });
			await run(g);
			await run(g);
			assert.strictEqual(t.seen.length, 2, JSON.stringify(fields));
		}
		const f = await serve((_r, res) => json(res, {}, 500));
		const g = gateFor(new HttpClassifier(config(f.url)), {
			cache: new DecisionCache({ maxEntries: 10, maxTtlMs: 60_000 }),
		});
		await run(g);
		await run(g);
		assert.strictEqual(f.seen.length, 2);
	});

	test("the ttl is capped and the cache is an LRU", async () => {
		let now = 0;
		const cache = new DecisionCache({
			maxEntries: 2,
			maxTtlMs: 100,
			now: () => now,
		});
		const v = { verdict: "allow" as const, reason: "x" };
		cache.set("a", "w", v, 10_000);
		cache.set("b", "w", v, 10_000);
		assert.ok(cache.get("a")); // a is now the most recent
		cache.set("c", "w", v, 10_000);
		assert.strictEqual(cache.get("b"), undefined);
		assert.ok(cache.get("a") && cache.get("c"));
		now = 101;
		assert.strictEqual(cache.get("a"), undefined);
		assert.strictEqual(cache.size, 1, "the expired entry went");
	});
});

describe("ceilings and hard limits", () => {
	test("HIGH may be allowed by default; a lower ceiling escalates it", async () => {
		const s = await serve(answer({}));
		const c = new HttpClassifier(config(s.url));
		assert.strictEqual((await run(gateFor(c))).decision, "allow");
		const out = await run(
			gateFor(c, { classifierAllowCeiling: RiskLevel.MEDIUM }),
		);
		assert.strictEqual(out.decision, "escalate");
		assert.strictEqual(out.escalatedBecause, "ceiling");
		// MEDIUM (an edit in the workspace) is still within it.
		const edit = await run(
			gateFor(c, { classifierAllowCeiling: RiskLevel.MEDIUM }),
			"edit",
			{ path: "src/a.ts" },
		);
		assert.strictEqual(edit.decision, "allow");
	});

	test("a classifier's deny still counts above the ceiling", async () => {
		const s = await serve(answer({ verdict: "deny" }));
		const out = await run(
			gateFor(new HttpClassifier(config(s.url)), {
				classifierAllowCeiling: RiskLevel.LOW,
			}),
		);
		assert.strictEqual(out.decision, "deny");
	});

	test("CRITICAL and hard limits are never allowed and never even sent", async () => {
		const s = await serve(answer({}));
		const gate = gateFor(new HttpClassifier(config(s.url)), {
			classifierAllowCeiling: RiskLevel.CRITICAL, // clamped to HIGH
		});
		for (const [tool, input] of [
			["write", { path: "/etc/x" }],
			["bash", { command: "sudo reboot" }],
			["write", { path: ".mcp.json" }],
			["edit", { path: ".git/hooks/pre-commit" }],
			["read", { path: ".env" }],
		] as const) {
			const out = await run(gate, tool, input);
			assert.strictEqual(
				out.decision,
				"escalate",
				`${tool} ${JSON.stringify(input)}`,
			);
			assert.strictEqual(out.escalatedBecause, "hard_limit");
		}
		assert.strictEqual(s.seen.length, 0);
	});

	test("the token file is a protected secret", async () => {
		const s = await serve(answer({}));
		const token = `${fx.home}/secrets/key`;
		const gate = gateFor(new HttpClassifier(config(s.url)), {
			secretFiles: [token],
		});
		const out = await run(gate, "read", { path: token });
		assert.strictEqual(out.decision, "escalate");
		assert.strictEqual(out.autoAllowable, false);
		assert.strictEqual(s.seen.length, 0);
	});

	test("a deny override and a LOW call never reach the classifier", async () => {
		const s = await serve(answer({}));
		const gate = gateFor(new HttpClassifier(config(s.url)));
		assert.strictEqual(
			(await run(gate, "bash", { command: "ls" })).decidedBy,
			"rules",
		);
		assert.strictEqual(s.seen.length, 0);
	});
});

describe("modes", () => {
	test("manual mode and a worker's opt-out skip the classifiers", async () => {
		const s = await serve(answer({}));
		const c = new HttpClassifier(config(s.url));
		const manual = await run(gateFor(c, { mode: "manual" }));
		assert.strictEqual(manual.decision, "escalate");
		assert.strictEqual(manual.escalatedBecause, "manual_mode");

		const gate = gateFor(c);
		gate.setPolicy({
			autoApproveUpTo: RiskLevel.LOW,
			overrides: [],
			classifiers: "off",
		});
		const off = await run(gate);
		assert.strictEqual(off.decision, "escalate");
		assert.strictEqual(off.escalatedBecause, "manual_mode");
		assert.strictEqual(s.seen.length, 0);

		gate.setPolicy({ autoApproveUpTo: RiskLevel.LOW, overrides: [] });
		assert.strictEqual((await run(gate)).decision, "allow");
	});
});
