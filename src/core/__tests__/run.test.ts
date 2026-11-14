import assert from "node:assert";
import { describe, test } from "node:test";

import {
	MAX_REPEATED_BYTES,
	MAX_REPEATED_LINES,
	RepeatCheck,
} from "../repeat-check.js";
import { OutputBuffer, type Run, RunStore, runView } from "../run.js";

function storeWith(
	over: Partial<ConstructorParameters<typeof RunStore>[0]> = {},
	clock = { now: 1_000 },
) {
	const store = new RunStore({
		retentionMs: 1000,
		maxRetained: 100,
		maxWaitMs: 5000,
		outputBufferChars: 1_000_000,
		now: () => clock.now,
		...over,
	});
	return { store, clock };
}

const approval = (id: string) => ({
	actionId: id,
	tool: "bash",
	summary: "rm f",
	input: {},
	expiresAt: Date.now() + 60_000,
});

describe("Run states", () => {
	test("a run starts, runs and settles once", () => {
		const { store } = storeWith();
		const run = store.create("w", "do it", "intent");
		assert.strictEqual(run.state, "starting");
		assert.match(run.id, /^r_[A-Za-z0-9]{10,32}$/);
		const seq0 = run.seq;
		store.setState(run, "running");
		assert.strictEqual(run.state, "running");
		assert.ok(run.seq > seq0, "a change bumps seq");
		assert.strictEqual(store.settle(run, "completed", {}), true);
		assert.strictEqual(run.state, "completed");
		assert.ok(run.endedAt !== undefined);
	});

	test("settling twice changes nothing the second time", () => {
		const { store } = storeWith();
		const run = store.create("w", "p");
		assert.strictEqual(store.settle(run, "completed", {}), true);
		const seq = run.seq;
		assert.strictEqual(store.settle(run, "failed", { error: "late" }), false);
		assert.strictEqual(run.state, "completed");
		assert.strictEqual(run.error, undefined);
		assert.strictEqual(run.seq, seq);
		store.setState(run, "running");
		assert.strictEqual(run.state, "completed", "no way back from terminal");
	});

	test("an approval moves the run to awaiting_approval and back", () => {
		const { store } = storeWith();
		const run = store.create("w", "p");
		store.setState(run, "running");
		store.addApproval(run, approval("a1"), "awaiting");
		store.addApproval(run, approval("a2"), "awaiting");
		assert.strictEqual(run.state, "awaiting_approval");
		store.removeApproval(run, "a1");
		assert.strictEqual(run.state, "awaiting_approval");
		store.removeApproval(run, "a2");
		assert.strictEqual(run.state, "running");
	});

	test("the view reports state, activity since a cursor and a next step", () => {
		const { store } = storeWith();
		const run = store.create("w", "p");
		store.setState(run, "running");
		store.addActivity(run, "bash: ls");
		const cursor = run.seq;
		store.addActivity(run, "read: a.txt");
		store.addOutput(run, "hello");
		const view = runView(run, { sinceSeq: cursor, maxChars: 100 });
		assert.deepStrictEqual(view.activity, ["read: a.txt"]);
		assert.strictEqual(view.output.text, "hello");
		assert.match(view.next, /wait_run/);
		assert.match(view.next, new RegExp(run.id));
	});
});

describe("waiting", () => {
	test("returns by the bound when nothing happens", async () => {
		const { store } = storeWith({ maxWaitMs: 80 });
		const run = store.create("w", "p");
		store.setState(run, "running");
		const started = Date.now();
		// Asking for far more than the store allows is clamped.
		const reason = await store.waitForChange(run, { maxWaitMs: 60_000 });
		const took = Date.now() - started;
		assert.strictEqual(reason, "timeout");
		assert.ok(took >= 70 && took < 1000, `took ${took} ms`);
	});

	test("a terminal state wakes the wait at once", async () => {
		const { store } = storeWith();
		const run = store.create("w", "p");
		store.setState(run, "running");
		const waiting = store.waitForChange(run, { maxWaitMs: 5000 });
		setTimeout(() => store.settle(run, "completed", {}), 20);
		const started = Date.now();
		assert.strictEqual(await waiting, "terminal");
		assert.ok(Date.now() - started < 1000);
		// Already terminal: no waiting at all.
		assert.strictEqual(
			await store.waitForChange(run, { maxWaitMs: 5000 }),
			"terminal",
		);
	});

	test("a new approval wakes the wait; one already seen does not", async () => {
		const { store } = storeWith({ maxWaitMs: 150 });
		const run = store.create("w", "p");
		store.setState(run, "running");
		const waiting = store.waitForChange(run, { maxWaitMs: 5000 });
		setTimeout(() => store.addApproval(run, approval("a1"), "x"), 20);
		assert.strictEqual(await waiting, "approval");

		// The caller has seen it: waiting from the current seq blocks again.
		const seen = run.seq;
		assert.strictEqual(
			await store.waitForChange(run, { sinceSeq: seen, maxWaitMs: 5000 }),
			"timeout",
		);
		// A second approval is new.
		const second = store.waitForChange(run, {
			sinceSeq: seen,
			maxWaitMs: 5000,
		});
		store.addApproval(run, approval("a2"), "x");
		assert.strictEqual(await second, "approval");
		// Without a cursor any pending approval returns at once.
		assert.strictEqual(
			await store.waitForChange(run, { maxWaitMs: 5000 }),
			"approval",
		);
	});

	test("an expired approval wakes the wait", async () => {
		const { store } = storeWith();
		const run = store.create("w", "p");
		store.setState(run, "running");
		store.addApproval(run, approval("a1"), "x");
		const seen = run.seq;
		const waiting = store.waitForChange(run, {
			sinceSeq: seen,
			maxWaitMs: 5000,
		});
		setTimeout(() => store.removeApproval(run, "a1", true), 20);
		assert.strictEqual(await waiting, "approval");
	});

	test("new output alone does not wake a wait", async () => {
		const { store } = storeWith({ maxWaitMs: 100 });
		const run = store.create("w", "p");
		store.setState(run, "running");
		const waiting = store.waitForChange(run, { maxWaitMs: 5000 });
		store.addOutput(run, "text");
		store.addActivity(run, "bash: ls");
		assert.strictEqual(await waiting, "timeout");
	});

	test("an aborted signal detaches the wait and leaves the run alone", async () => {
		const { store } = storeWith();
		const run = store.create("w", "p");
		store.setState(run, "running");
		const controller = new AbortController();
		const waiting = store.waitForChange(run, {
			maxWaitMs: 5000,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 20);
		assert.strictEqual(await waiting, "detached");
		assert.strictEqual(run.state, "running");
		// An already aborted signal detaches immediately.
		assert.strictEqual(
			await store.waitForChange(run, {
				maxWaitMs: 5000,
				signal: controller.signal,
			}),
			"detached",
		);
	});
});

describe("retention", () => {
	test("a result is kept after the worker closes, until retention passes", () => {
		const { store, clock } = storeWith({ retentionMs: 1000 });
		const run = store.create("w", "p");
		store.settle(run, "completed", {});
		store.workerClosed("w");
		clock.now += 999;
		assert.strictEqual(store.get(run.id), run);
		clock.now += 2;
		assert.strictEqual(store.get(run.id), undefined);
	});

	test("a finished run of a live worker is kept past the retention time", () => {
		const { store, clock } = storeWith({ retentionMs: 1000 });
		const run = store.create("w", "p");
		store.settle(run, "completed", {});
		clock.now += 10_000;
		assert.strictEqual(store.get(run.id), run);
	});

	test("the number of finished runs kept is capped, oldest first", () => {
		const { store, clock } = storeWith({ maxRetained: 3 });
		const live = store.create("w", "still going");
		const done: Run[] = [];
		for (let i = 0; i < 5; i++) {
			const run = store.create("w", `p${i}`);
			clock.now += 10;
			store.settle(run, "completed", {});
			done.push(run);
		}
		assert.strictEqual(store.get(done[0].id), undefined);
		assert.strictEqual(store.get(done[1].id), undefined);
		assert.strictEqual(store.get(done[2].id), done[2]);
		assert.strictEqual(store.get(done[4].id), done[4]);
		assert.strictEqual(store.get(live.id), live, "a live run is never pruned");
	});
});

describe("OutputBuffer", () => {
	test("keeps the newest characters and absolute offsets", () => {
		const out = new OutputBuffer(10);
		out.append("0123456789");
		out.append("abcde");
		assert.strictEqual(out.total, 15);
		assert.strictEqual(out.truncated, true);
		assert.strictEqual(out.all, "56789abcde");
		// An offset before what is held starts at what is held.
		assert.deepStrictEqual(out.slice(0, 4), {
			text: "5678",
			offset: 5,
			nextOffset: 9,
		});
		assert.deepStrictEqual(out.slice(9, 100), {
			text: "9abcde",
			offset: 9,
			nextOffset: 15,
		});
	});
});

const feedAll = (text: string) => {
	const check = new RepeatCheck();
	// In small pieces, as a stream arrives.
	for (let i = 0; i < text.length; i += 7) {
		if (check.feed(text.slice(i, i + 7))) return true;
	}
	return false;
};

describe("RepeatCheck", () => {
	test("Markdown rules and table separators are not repetition", () => {
		assert.strictEqual(
			feedAll("Title\n----\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n----\n"),
			false,
		);
		const rows = Array.from({ length: 150 }, (_, i) => `| ${i} | x |`);
		assert.strictEqual(feedAll(`|---|---|\n${rows.join("\n")}\n`), false);
		assert.strictEqual(feedAll(`${"----\n\n".repeat(50)}`), false);
	});

	test("the same line too many times in a row is", () => {
		assert.strictEqual(
			feedAll("same\n".repeat(MAX_REPEATED_LINES)),
			false,
			"the limit itself is allowed",
		);
		assert.strictEqual(feedAll("same\n".repeat(MAX_REPEATED_LINES + 1)), true);
	});

	test("blank lines between repeats do not hide them", () => {
		assert.strictEqual(
			feedAll("same\n\n".repeat(MAX_REPEATED_LINES + 1)),
			true,
		);
	});

	test("a different line starts the count again", () => {
		const text = `${"a\n".repeat(150)}b\n${"a\n".repeat(150)}`;
		assert.strictEqual(feedAll(text), false);
	});

	test("a long repeated block is caught by size too", () => {
		const line = `${"z".repeat(1000)}\n`;
		assert.strictEqual(
			feedAll(line.repeat(Math.ceil(MAX_REPEATED_BYTES / line.length) + 1)),
			true,
		);
	});

	test("reset forgets the state", () => {
		const check = new RepeatCheck();
		assert.strictEqual(check.feed("same\n".repeat(MAX_REPEATED_LINES)), false);
		check.reset();
		assert.strictEqual(check.feed("same\n"), false);
	});
});
