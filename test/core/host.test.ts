import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import { ChildRegistry, type ManagedChild } from "../../src/core/child.js";
import { openWorker } from "../../src/core/host.js";
import { FakeProvider } from "../../src/providers/fake/provider.js";
import type {
	ProviderHost,
	WorkerHandle,
	WorkerProvider,
} from "../../src/providers/types.js";
import { RuntimeDir } from "../../src/session/runtime-dir.js";
import {
	createIsolation,
	FAKE_PI,
	type Isolation,
	pidGone,
	waitUntil,
} from "../helpers/isolation.js";

describe("core/host: opening workers through a provider", () => {
	let iso: Isolation;
	let runtime: RuntimeDir;
	let children: ChildRegistry;

	before(() => {
		iso = createIsolation();
		runtime = new RuntimeDir(path.join(iso.root, "runtime"));
		children = new ChildRegistry({
			env: iso.env,
			envConfig: { allow: [], forceDropExempt: [] },
		});
	});
	after(async () => {
		await children.terminateAll(200);
		runtime.dispose();
		await iso.cleanup();
	});

	const base = () => ({
		spec: { workerId: "w_test0001", cwd: iso.cwd, options: {} },
		children,
		runtime,
		policy: { sandbox: "none" as const, allowUngatedInSandbox: false },
		emit: () => {},
		approve: async () => ({ kind: "allow" as const }),
	});

	/** A provider that starts fake-pi through the host, then fails to open. */
	function failingProvider(): WorkerProvider & { child?: ManagedChild } {
		const fake = new FakeProvider();
		const provider = Object.assign(Object.create(fake), {
			async open(_spec: unknown, host: ProviderHost): Promise<WorkerHandle> {
				provider.child = host.spawn({
					argv: [FAKE_PI],
					cwd: iso.cwd,
					stdio: "jsonl",
					sandbox: "none",
				});
				await provider.child.started;
				throw new Error("gate never became active");
			},
		});
		return provider;
	}

	test("a failed open kills what the provider started and removes its dir", async () => {
		const provider = failingProvider();
		const entries = fs.readdirSync(runtime.ensure()).length;
		await assert.rejects(
			openWorker({ ...base(), provider }),
			/gate never became active/,
		);
		const pid = provider.child!.pid!;
		await waitUntil(() => pidGone(pid), 3000, "the half-open worker to die");
		assert.strictEqual(fs.readdirSync(runtime.dir).length, entries);
	});

	test("a provider with no gate is refused before anything starts", async () => {
		const provider = new FakeProvider({ capabilities: { approvals: "none" } });
		await assert.rejects(openWorker({ ...base(), provider }), /cannot gate/);
	});

	test("close stops the provider, kills its processes and removes the private dir", async () => {
		const spawned: { child?: ManagedChild; dir?: string } = {};
		const fake = new FakeProvider();
		const provider = Object.assign(Object.create(fake), {
			async open(spec: never, host: ProviderHost) {
				spawned.dir = host.privateDir;
				spawned.child = host.spawn({
					argv: [FAKE_PI],
					cwd: iso.cwd,
					stdio: "jsonl",
					sandbox: "none",
				});
				return fake.open(spec, host);
			},
		});
		const opened = await openWorker({ ...base(), provider });
		assert.ok(fs.existsSync(spawned.dir!));
		const first = opened.close({ graceMs: 200, reason: "requested" });
		assert.strictEqual(
			first,
			opened.close({ graceMs: 200, reason: "shutdown" }),
		);
		await first;
		assert.ok(pidGone(spawned.child!.pid!));
		assert.ok(!fs.existsSync(spawned.dir!));
	});

	test("an approval that throws becomes a deny", async () => {
		let host!: ProviderHost;
		const fake = new FakeProvider();
		const provider = Object.assign(Object.create(fake), {
			async open(spec: never, h: ProviderHost) {
				host = h;
				return fake.open(spec, h);
			},
		});
		const opened = await openWorker({
			...base(),
			provider,
			approve: async () => {
				throw new Error("classifier down");
			},
		});
		const decision = await host.requestApproval(
			{ callId: "c", toolName: "bash", input: {} },
			new AbortController().signal,
		);
		assert.strictEqual(decision.kind, "deny");
		await opened.close({ graceMs: 50, reason: "requested" });
	});
});
