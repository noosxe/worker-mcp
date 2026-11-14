// Runs ChildRegistry (from the build) under whichever runtime executes this
// file, so process handling is tested on Node and on Bun alike.
//   <runtime> child-driver.mjs <scenario> <fake-pi path>
// Prints one JSON object on stdout when done. Env: FAKE_PI_RECORD as usual.
import { ChildRegistry } from "../../dist/core/child.js";

const [scenario, fakePi] = process.argv.slice(2);
const registry = new ChildRegistry({
	env: process.env,
	envConfig: { allow: ["FAKE_PI_*"], forceDropExempt: [] },
	limits: { maxLineChars: 3000, maxStderrLineChars: 50 },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const piSpec = () => ({
	argv: [fakePi],
	cwd: process.cwd(),
	stdio: "jsonl",
	sandbox: "none",
});
const nodeSpec = (code) => ({
	argv: [process.execPath, "-e", code],
	cwd: process.cwd(),
	stdio: "jsonl",
	sandbox: "none",
});

/** Start fake-pi, run one scenario, resolve with the final text's pid. */
async function runScenario(child, spec) {
	const texts = [];
	child.onMessage((m) => {
		if (m.type === "message_end") texts.push(m.message.content[0].text);
	});
	await child.started;
	child.send({ id: "1", type: "prompt", message: `scenario:${spec}` });
	for (let i = 0; i < 200 && texts.length === 0; i++) await sleep(25);
	return texts[0];
}

const out = {};
if (scenario === "grandchild") {
	const child = registry.spawn(piSpec());
	const text = await runScenario(child, "grandchild");
	out.grandchild = Number(text.match(/pid: (\d+)/)[1]);
	out.pid = child.pid;
	out.aliveBefore = alive(out.grandchild);
	await child.terminate(500);
	await sleep(100);
	out.grandchildAlive = alive(out.grandchild);
	out.alive = alive(child.pid);
} else if (scenario === "ignore-sigterm") {
	const child = registry.spawn(piSpec());
	child.send({ id: "1", type: "prompt", message: "scenario:ignore-sigterm" });
	await child.started;
	await sleep(300);
	out.pid = child.pid;
	const began = Date.now();
	await child.terminate(400);
	out.ms = Date.now() - began;
	out.exit = await child.exited;
	out.alive = alive(child.pid);
} else if (scenario === "shutdown") {
	// What the server does on a signal: terminate everything, in parallel.
	const a = registry.spawn(piSpec());
	const b = registry.spawn(piSpec());
	const text = await runScenario(a, "grandchild");
	b.send({ id: "1", type: "prompt", message: "scenario:ignore-sigterm" });
	await sleep(300);
	out.grandchild = Number(text.match(/pid: (\d+)/)[1]);
	out.pids = [a.pid, b.pid];
	await registry.terminateAll(400);
	await sleep(100);
	out.size = registry.size;
	out.alive = [a.pid, b.pid, out.grandchild].map(alive);
} else if (scenario === "double-terminate") {
	const child = registry.spawn(piSpec());
	await child.started;
	const first = child.terminate(400);
	const second = child.terminate(5);
	out.samePromise = first === second;
	await Promise.all([first, second]);
	await child.terminate(400); // after the exit: still fine
	out.exit = await child.exited;
	out.alive = alive(child.pid);
} else if (scenario === "epipe") {
	// A worker that really closes stdin (the read end of our pipe).
	const child = registry.spawn(
		nodeSpec("require('fs').closeSync(0); setInterval(() => {}, 1000)"),
	);
	const problems = [];
	child.onProblem((p) => problems.push(p.kind));
	await child.started;
	await sleep(300);
	const results = [];
	for (let i = 0; i < 5; i++) {
		results.push(
			await new Promise((resolve) => {
				let accepted;
				// Success and failure both call back; guard against silence.
				const timer = setTimeout(
					() => resolve({ accepted, err: "no callback" }),
					1000,
				);
				accepted = child.send({ n: i }, (err) => {
					clearTimeout(timer);
					resolve({ accepted, err: err?.message ?? null });
				});
			}),
		);
		await sleep(50);
	}
	out.results = results;
	out.problems = [...new Set(problems)];
	out.stillThere = alive(child.pid);
	await child.terminate(300);
} else if (scenario === "send-after-exit") {
	const child = registry.spawn(nodeSpec("process.exit(0)"));
	await child.exited;
	let threw = false;
	let accepted;
	let cbErr;
	try {
		accepted = child.send({ a: 1 }, (e) => (cbErr = e?.message));
	} catch {
		threw = true;
	}
	out.threw = threw;
	out.accepted = accepted;
	out.cbErr = cbErr;
} else if (scenario === "oversize") {
	const child = registry.spawn(
		nodeSpec(
			`process.stdout.write('{"a":1}\\n' + 'x'.repeat(5000) + '\\n{"b":2}\\n' + 'y'.repeat(3500)); process.stderr.write('e'.repeat(200) + '\\n'); setTimeout(() => {}, 200)`,
		),
	);
	const lines = [];
	const problems = [];
	const stderr = [];
	child.onLine((l) => lines.push(l.length));
	child.onProblem((p) => problems.push(p.kind));
	child.onStderr((l) => stderr.push(l.length));
	await child.exited;
	out.lines = lines;
	out.problems = [...new Set(problems)];
	out.stderr = stderr;
} else if (scenario === "spawn-failure") {
	const child = registry.spawn({ ...piSpec(), argv: ["/nonexistent/binary"] });
	out.startedRejected = await child.started.then(
		() => false,
		() => true,
	);
	const exit = await child.exited;
	out.hasError = Boolean(exit.error);
	out.size = registry.size;
	out.terminateOk = await child.terminate().then(() => true);
} else if (scenario === "env") {
	const child = registry.spawn({
		...nodeSpec(
			"process.stdout.write(JSON.stringify(Object.keys(process.env)) + '\\n')",
		),
		env: { WM_EXTRA: "1" },
	});
	let env;
	child.onMessage((m) => (env = m));
	await child.exited;
	out.names = env;
}
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
