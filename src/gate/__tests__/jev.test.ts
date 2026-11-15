import assert from "node:assert";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import test, { afterEach, beforeEach, describe } from "node:test";

import {
	DEFAULT_JEV_THRESHOLDS,
	JEV_BACKENDS,
	type HttpClassifierConfig,
} from "../../config.js";
import { DecisionCache } from "../cache.js";
import type { GateOutcome } from "../classifier.js";
import { HttpClassifier } from "../http-classifier.js";
import { QUESTION_IDS } from "../jev-questions.js";
import { mapAnswers } from "../jev.js";
import { decide, fixture, type Fixture } from "./helpers.js";

const TOKEN = "jev-test-token-value";

interface Seen {
	path: string;
	headers: http.IncomingHttpHeaders;
	body: any;
}
type Reply = (r: Seen, res: http.ServerResponse) => void | Promise<void>;

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

/** A fake System One server on a free loopback port. */
async function serve(reply: Reply) {
	const seen: Seen[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const entry: Seen = {
				path: req.url ?? "",
				headers: req.headers,
				body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
			};
			seen.push(entry);
			void reply(entry, res);
		});
	});
	servers.push(server);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	return {
		seen,
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
	};
}

interface Probs {
	risk?: number;
	confidence?: number;
	approval?: number;
	user_requested?: number;
	from_untrusted?: number;
}
/** A System One response for the given answers (calm defaults). */
export const answers = (p: Probs = {}) => ({
	model: "jev-test",
	answers: {
		risk: {
			type: "score",
			score: p.risk ?? 0.2,
			confidence: p.confidence ?? 0.95,
		},
		approval: { type: "noul", noul: p.approval ?? 0.02 },
		user_requested: { type: "noul", noul: p.user_requested ?? 0.9 },
		from_untrusted: { type: "noul", noul: p.from_untrusted ?? 0.01 },
	},
});

const send = (res: http.ServerResponse, body: unknown, status = 200) => {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
};
const reply = (p: Probs) => (_r: Seen, res: http.ServerResponse) =>
	send(res, answers(p));

const config = (
	url: string,
	over: Partial<HttpClassifierConfig> = {},
): HttpClassifierConfig => ({
	name: "jev",
	url,
	dialect: "jev",
	backend: "custom",
	model: "jev-test",
	jev: { ...DEFAULT_JEV_THRESHOLDS },
	timeoutMs: 2000,
	minAllowConfidence: 0.85,
	minDenyConfidence: 0.6,
	maxArgumentBytes: 8192,
	sendIntent: true,
	breaker: { failures: 5, coolDownMs: 60_000 },
	...over,
});

const classifier = (url: string, over: Partial<HttpClassifierConfig> = {}) =>
	new HttpClassifier(config(url, over), { token: () => TOKEN });

const run = async (
	c: HttpClassifier | HttpClassifier[],
	command = "rm file",
): Promise<GateOutcome> =>
	decide(
		fx.gate({
			classifiers: Array.isArray(c) ? c : [c],
			mode: "auto",
			workerId: "w_aaaaaaaa",
		}),
		"bash",
		{ command },
	);

describe("jev dialect: the request", () => {
	test("posts to /v1/systemone with a bearer token, the state, the model and the four questions", async () => {
		const s = await serve(reply({}));
		const gate = fx.gate({
			classifiers: [classifier(s.url)],
			mode: "auto",
			workerId: "w_aaaaaaaa",
		});
		const out = await gate.decide(
			{ provider: "pi", toolName: "bash", input: { command: "rm file" } },
			"call1",
			{ runId: "r_1", intent: "tidy the repo" },
		);
		assert.strictEqual(out.decision, "allow");
		assert.strictEqual(out.decidedBy, "http:jev");
		const r = s.seen[0];
		assert.strictEqual(r.path, "/v1/systemone");
		assert.strictEqual(r.headers.authorization, `Bearer ${TOKEN}`);
		assert.strictEqual(r.body.model, "jev-test");
		assert.deepStrictEqual(
			new Set(Object.keys(r.body)),
			new Set(["state", "model", "questions"]),
		);
		assert.deepStrictEqual(Object.keys(r.body.questions), [...QUESTION_IDS]);
		assert.strictEqual(r.body.questions.risk.type, "score");
		assert.strictEqual(r.body.questions.risk.criteria.length, 4);
		for (const id of ["approval", "user_requested", "from_untrusted"]) {
			assert.strictEqual(r.body.questions[id].type, "noul");
			assert.ok(r.body.questions[id].instructions.length > 20);
		}
		assert.strictEqual(typeof r.body.state, "string");
		assert.ok(r.body.state.includes("Intent: tidy the repo"));
		assert.ok(r.body.state.includes("rm file"));
		assert.ok(r.body.state.includes("Rule assessment:"));
		assert.ok(
			r.body.state.indexOf("Intent:") < r.body.state.indexOf("UNTRUSTED"),
		);
		assert.ok(
			r.body.state.indexOf("UNTRUSTED") < r.body.state.indexOf("rm file"),
			"the worker's call is under the untrusted heading",
		);
		assert.ok(!JSON.stringify(r.body).includes(TOKEN));
	});

	test("sendIntent false leaves the intent out; arguments are capped", async () => {
		const s = await serve(reply({}));
		const gate = fx.gate({
			classifiers: [
				classifier(s.url, { sendIntent: false, maxArgumentBytes: 200 }),
			],
			mode: "auto",
			workerId: "w_aaaaaaaa",
		});
		await gate.decide(
			{
				provider: "pi",
				toolName: "write",
				input: { path: "src/a.txt", content: "x".repeat(50_000) },
			},
			"c2",
			{ runId: "r_1", intent: "secret plan" },
		);
		const state: string = s.seen[0].body.state;
		assert.ok(!state.includes("secret plan"));
		assert.ok(state.includes("Intent: (none given)"));
		assert.ok(state.length < 3000, `state is ${state.length} chars`);
		assert.ok(state.includes("(truncated)"));
	});

	test("the state is deterministic", async () => {
		const s = await serve(reply({}));
		const c = classifier(s.url);
		await run(c);
		await run(c);
		assert.strictEqual(s.seen[0].body.state, s.seen[1].body.state);
	});
});

const withRisk = (risk: Record<string, unknown>) => {
	const a: any = answers();
	a.answers.risk = { type: "score", confidence: 0.9, ...risk };
	return a;
};

describe("jev dialect: the mapping", () => {
	test("low risk, low approval, confident: allow", async () => {
		const s = await serve(reply({}));
		const out = await run(classifier(s.url));
		assert.strictEqual(out.decision, "allow");
		assert.ok(out.consulted[1].reason.includes("risk 0.2"));
		assert.ok((out.consulted[1].confidence ?? 0) >= 0.85);
	});

	test("from_untrusted high: deny", async () => {
		const s = await serve(reply({ from_untrusted: 0.9 }));
		const out = await run(classifier(s.url));
		assert.strictEqual(out.decision, "deny");
		assert.strictEqual(out.decidedBy, "http:jev");
	});

	test("risk high: deny; unsure about it: escalate", async () => {
		const s = await serve(reply({ risk: 2.9, confidence: 0.9 }));
		assert.strictEqual((await run(classifier(s.url))).decision, "deny");
		const u = await serve(reply({ risk: 2.6, confidence: 0.3 }));
		const out = await run(classifier(u.url));
		assert.strictEqual(out.decision, "escalate");
		assert.strictEqual(out.escalatedBecause, "low_confidence");
	});

	test("risky and not requested: escalate; risky but requested: allow", async () => {
		const s = await serve(reply({ risk: 1.8, user_requested: 0.3 }));
		assert.strictEqual((await run(classifier(s.url))).decision, "escalate");
		const r = await serve(reply({ risk: 1.8, user_requested: 0.95 }));
		const out = await run(classifier(r.url));
		assert.strictEqual(out.decision, "allow");
		assert.ok(out.consulted[1].reason.includes("requested"));
		const a = await serve(reply({ approval: 0.8, user_requested: 0.2 }));
		assert.strictEqual((await run(classifier(a.url))).decision, "escalate");
	});

	test("an allow with a weak confidence escalates", async () => {
		const low = await serve(reply({ confidence: 0.5 }));
		assert.strictEqual((await run(classifier(low.url))).decision, "escalate");
		// approval 0.3 is below the ask threshold: the probability does not
		// lower the confidence, so a confident risk answer allows
		const mid = await serve(reply({ approval: 0.3 }));
		assert.strictEqual((await run(classifier(mid.url))).decision, "allow");
	});

	test("thresholds are configurable", async () => {
		const s = await serve(reply({ risk: 1.8, user_requested: 0.7 }));
		const strict = await run(classifier(s.url));
		assert.strictEqual(strict.decision, "escalate");
		const loose = await run(
			classifier(s.url, {
				jev: { ...DEFAULT_JEV_THRESHOLDS, userRequestedProbability: 0.6 },
			}),
		);
		assert.strictEqual(loose.decision, "allow");
		const margin = await run(
			classifier(s.url, {
				jev: {
					...DEFAULT_JEV_THRESHOLDS,
					userRequestedProbability: 0.6,
					thresholdMargin: 0.2,
				},
			}),
		);
		// 0.7 is within 0.2 of 0.6
		assert.strictEqual(margin.decision, "escalate");
	});

	test("CRITICAL is never allowed, whatever jev says", async () => {
		const s = await serve(reply({}));
		const out = await run(classifier(s.url), "rm -rf /");
		assert.notStrictEqual(out.decision, "allow");
		assert.strictEqual(s.seen.length, 0);
	});

	test("missing, invalid or unconfident answers escalate", async () => {
		const bad: unknown[] = [
			{ answers: { risk: answers().answers.risk } },
			(() => {
				const a = answers();
				(a.answers.approval as any).noul = 1.5;
				return a;
			})(),
			(() => {
				const a = answers();
				(a.answers.risk as any).score = 4;
				return a;
			})(),
			(() => {
				const a = answers();
				delete (a.answers.risk as any).confidence;
				return a;
			})(),
		];
		for (const body of bad) {
			const s = await serve((_r, res) => send(res, body));
			const out = await run(classifier(s.url));
			assert.strictEqual(out.decision, "escalate", JSON.stringify(body));
			assert.ok(out.consulted[1].reason.includes("unusable answer"));
		}
	});

	test("risk position from probabilities; a disagreeing score escalates", async () => {
		const cases: [string, Record<string, unknown>, string, RegExp?][] = [
			// only probabilities: computed 2.95, a deny
			["probabilities only", { probabilities: [0, 0.01, 0.03, 0.96] }, "deny"],
			// object form, as in the docs' example
			[
				"keyed probabilities",
				{ probabilities: { 0: 0.97, 1: 0.03, 2: 0, 3: 0 } },
				"allow",
			],
			// both agree: 2.95
			[
				"both agree",
				{ score: 2.95, probabilities: [0, 0.01, 0.03, 0.96] },
				"deny",
			],
			// a normalised score next to probabilities of a top-risk call
			[
				"disagree",
				{ score: 0.98, probabilities: [0, 0.01, 0.03, 0.96] },
				"escalate",
				/disagrees/,
			],
			[
				"wrong length",
				{ probabilities: [0.5, 0.5, 0] },
				"escalate",
				/four values/,
			],
			[
				"sum off",
				{ probabilities: [0.1, 0.1, 0.1, 0.1] },
				"escalate",
				/sum to/,
			],
			["score alone is read as 0-3", { score: 2.9 }, "deny"],
		];
		for (const [name, risk, verdict, reason] of cases) {
			const s = await serve((_r, res) => send(res, withRisk(risk)));
			const out = await run(classifier(s.url));
			assert.strictEqual(out.decision, verdict, name);
			if (reason) assert.match(out.consulted[1].reason, reason, name);
		}
	});

	test("a risk confidence under providerMetadata is read", async () => {
		const s = await serve((_r, res) => {
			const a: any = answers();
			delete a.answers.risk.confidence;
			a.providerMetadata = { typesafe: { confidence: { risk: 0.93 } } };
			send(res, a);
		});
		assert.strictEqual((await run(classifier(s.url))).decision, "allow");
	});

	test("a response without answers is a classifier error", async () => {
		const s = await serve((_r, res) => send(res, { nope: true }));
		const out = await run(classifier(s.url));
		assert.strictEqual(out.decision, "escalate");
		assert.strictEqual(out.escalatedBecause, "classifier_error");
	});

	test("cacheTtlMs lets the cache answer the same call again; off by default", async () => {
		const s = await serve(reply({}));
		const mk = (over: Partial<HttpClassifierConfig>) =>
			fx.gate({
				classifiers: [classifier(s.url, over)],
				mode: "auto",
				workerId: "w_aaaaaaaa",
				cache: new DecisionCache({ maxEntries: 10, maxTtlMs: 60_000 }),
			});
		const off = mk({});
		await decide(off, "bash", { command: "rm a" });
		await decide(off, "bash", { command: "rm a" });
		assert.strictEqual(s.seen.length, 2);
		const on = mk({ cacheTtlMs: 30_000 });
		await decide(on, "bash", { command: "rm b" });
		const again = await decide(on, "bash", { command: "rm b" });
		assert.strictEqual(s.seen.length, 3);
		assert.strictEqual(again.consulted[1].cached, true);
	});
});

describe("jev dialect: per-answer noul confidence", () => {
	test("a noul confidence in the answer or in providerMetadata lowers an allow", async () => {
		const inline: any = answers();
		inline.answers.approval.confidence = 0.5;
		const a = await serve((_r, res) => send(res, inline));
		assert.strictEqual((await run(classifier(a.url))).decision, "escalate");
		const meta: any = answers();
		meta.providerMetadata = {
			typesafe: { confidence: { from_untrusted: 0.4 } },
		};
		const b = await serve((_r, res) => send(res, meta));
		assert.strictEqual((await run(classifier(b.url))).decision, "escalate");
		const fine: any = answers();
		fine.answers.approval.confidence = 0.95;
		const c = await serve((_r, res) => send(res, fine));
		assert.strictEqual((await run(classifier(c.url))).decision, "allow");
	});

	test("an unusable noul confidence escalates", async () => {
		const bad: any = answers();
		bad.answers.approval.confidence = 7;
		const s = await serve((_r, res) => send(res, bad));
		assert.strictEqual((await run(classifier(s.url))).decision, "escalate");
	});
});

const ans = (
	score: number,
	confidence: number,
	approval: number,
	user_requested: number,
	from_untrusted: number,
	noul?: Record<string, number>,
) => ({
	risk: { score, confidence },
	approval,
	user_requested,
	from_untrusted,
	confidence: noul,
});

describe("jev dialect: mapAnswers", () => {
	const th = { ...DEFAULT_JEV_THRESHOLDS };
	for (const [name, a, verdict] of [
		["python3 calc.py, confident", ans(0.14, 0.86, 0.61, 0.9, 0.05), "allow"],
		[
			"python3 calc.py, risk confidence 0.81",
			ans(0.19, 0.81, 0.77, 0.86, 0.09),
			"escalate",
		],
		[
			"edit calc.py, risk confidence 0.82",
			ans(0.82, 0.82, 0.57, 0.91, 0.05),
			"escalate",
		],
		[
			"rm -rf build, risk confidence 0.43",
			ans(1.09, 0.43, 0.74, 0.84, 0.08),
			"escalate",
		],
	] as const) {
		test(`real answer: ${name}`, () => {
			const r = mapAnswers(a, th);
			assert.strictEqual(
				r.verdict === "allow" && (r.confidence ?? 0) < 0.85
					? "escalate"
					: r.verdict,
				verdict,
			);
			if (verdict === "allow") assert.strictEqual(r.confidence, 0.86);
		});
	}

	test("deny rules and the risky-not-requested escalation are kept", () => {
		const u = mapAnswers(ans(0.1, 0.9, 0.1, 0.9, 0.8), th);
		assert.deepStrictEqual([u.verdict, u.confidence], ["deny", 0.8]);
		const r = mapAnswers(ans(2.7, 0.88, 0.1, 0.9, 0.1), th);
		assert.deepStrictEqual([r.verdict, r.confidence], ["deny", 0.88]);
		assert.strictEqual(
			mapAnswers(ans(1.8, 0.9, 0.1, 0.5, 0.1), th).verdict,
			"escalate",
		);
		assert.strictEqual(
			mapAnswers(ans(0.1, 0.9, 0.8, 0.5, 0.1), th).verdict,
			"escalate",
		);
	});

	test("risky but requested allows with the weakest reported confidence", () => {
		const r = mapAnswers(
			ans(1.8, 0.95, 0.9, 0.95, 0.05, { user_requested: 0.9 }),
			th,
		);
		assert.deepStrictEqual([r.verdict, r.confidence], ["allow", 0.9]);
	});

	test("noul confidences are used when present, not invented when absent", () => {
		const some = mapAnswers(
			ans(0.1, 0.95, 0.1, 0.9, 0.05, { approval: 0.6, from_untrusted: 0.8 }),
			th,
		);
		assert.strictEqual(some.confidence, 0.6);
		const none = mapAnswers(ans(0.1, 0.95, 0.1, 0.9, 0.05), th);
		assert.strictEqual(none.confidence, 0.95);
	});

	test("the margin guard escalates a probability next to its threshold", () => {
		const base = [0.1, 0.95, 0.1, 0.95, 0.05] as const;
		assert.strictEqual(mapAnswers(ans(...base), th).verdict, "allow");
		// approval 0.72 (threshold 0.75), risk 1.47 (1.5), from_untrusted 0.67 (0.7)
		assert.strictEqual(
			mapAnswers(ans(0.1, 0.95, 0.72, 0.95, 0.05), th).verdict,
			"escalate",
		);
		assert.strictEqual(
			mapAnswers(ans(1.47, 0.95, 0.1, 0.95, 0.05), th).verdict,
			"escalate",
		);
		assert.strictEqual(
			mapAnswers(ans(0.1, 0.95, 0.1, 0.95, 0.67), th).verdict,
			"escalate",
		);
		// risky: user_requested 0.87 (0.85), risk 2.47 (2.5)
		assert.strictEqual(
			mapAnswers(ans(1.8, 0.95, 0.1, 0.87, 0.05), th).verdict,
			"escalate",
		);
		assert.strictEqual(
			mapAnswers(ans(2.47, 0.95, 0.1, 0.95, 0.05), th).verdict,
			"escalate",
		);
		// a zero margin turns the guard off
		const off = { ...th, thresholdMargin: 0 };
		assert.strictEqual(
			mapAnswers(ans(0.1, 0.95, 0.72, 0.95, 0.05), off).verdict,
			"allow",
		);
	});
});

describe("jev dialect: transport", () => {
	test("429 is retried while the deadline allows", async () => {
		let n = 0;
		const s = await serve((_r, res) =>
			++n < 3 ? send(res, { error: "busy" }, 429) : send(res, answers()),
		);
		const out = await run(classifier(s.url, { timeoutMs: 4000 }));
		assert.strictEqual(out.decision, "allow");
		assert.strictEqual(s.seen.length, 3);
	});

	test("a 429 that outlasts the deadline escalates", async () => {
		const s = await serve((_r, res) => send(res, { error: "busy" }, 429));
		const t0 = Date.now();
		const out = await run(classifier(s.url, { timeoutMs: 900 }));
		assert.strictEqual(out.decision, "escalate");
		assert.strictEqual(out.escalatedBecause, "classifier_error");
		assert.ok(Date.now() - t0 < 1500);
		assert.ok(s.seen.length >= 1 && s.seen.length <= 2);
	});

	test("a 4xx is not retried", async () => {
		const s = await serve((_r, res) => send(res, { error: "no" }, 401));
		const out = await run(classifier(s.url));
		assert.strictEqual(out.decision, "escalate");
		assert.strictEqual(s.seen.length, 1);
	});

	test("one request at a time: the second call waits for the first", async () => {
		let active = 0;
		let peak = 0;
		const s = await serve(async (_r, res) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 150));
			active--;
			send(res, answers());
		});
		const c = classifier(s.url, { timeoutMs: 3000 });
		const [a, b] = await Promise.all([run(c), run(c, "rm other")]);
		assert.strictEqual(a.decision, "allow");
		assert.strictEqual(b.decision, "allow");
		assert.strictEqual(peak, 1);
		// b had plenty of time left when the slot freed, so it was sent.
		assert.strictEqual(s.seen.length, 2);
	});

	test("calls that wait past their deadline escalate instead of waiting on", async () => {
		const s = await serve(async (_r, res) => {
			await new Promise((r) => setTimeout(r, 1500));
			send(res, answers());
		});
		const c = classifier(s.url, { timeoutMs: 400 });
		const t0 = Date.now();
		const out = await Promise.all([run(c), run(c, "rm b"), run(c, "rm c")]);
		for (const o of out) {
			assert.strictEqual(o.decision, "escalate");
			assert.strictEqual(o.escalatedBecause, "classifier_error");
		}
		assert.ok(Date.now() - t0 < 1000, "nobody waited for the slow server");
		assert.strictEqual(s.seen.length, 1, "only the first call was sent");
	});
});

describe("jev backends", () => {
	test("default URLs and models", () => {
		assert.deepStrictEqual(JEV_BACKENDS, {
			typesafe: { url: "https://api.typesafe.ai", model: "jev-latest" },
			openrouter: { url: "https://openrouter.ai/api", model: "jev-1.13" },
		});
	});

	test("the endpoint is the base URL plus /v1/systemone, whatever the base path", async () => {
		const s = await serve(reply({}));
		await run(classifier(`${s.url}/prefix/`));
		assert.strictEqual(s.seen[0].path, "/prefix/v1/systemone");
	});
});
