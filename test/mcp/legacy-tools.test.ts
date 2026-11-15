import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import {
	createIsolation,
	type Isolation,
	waitUntil,
} from "../helpers/isolation.js";
import { RawServer, RUNTIME } from "../helpers/stdio.js";

async function toolNames(server: RawServer): Promise<string[]> {
	const res = await server.request("tools/list");
	return res.result.tools.map((t: { name: string }) => t.name);
}

async function expectOneWarning(server: RawServer) {
	await waitUntil(() => server.stderr.join("").includes("no longer used"));
	const warnings = server.stderr
		.join("")
		.split("\n")
		.filter((l) => l.includes("no longer used"));
	assert.strictEqual(warnings.length, 1, warnings.join("\n"));
	assert.match(warnings[0], /^Warning: /);
}

// `legacyTools` and WORKER_MCP_LEGACY_TOOLS were removed with the aliases.
// An existing setup that still sets one must start, ignore it and say so once.
describe(`legacyTools is accepted and ignored (${RUNTIME})`, () => {
	let iso: Isolation;
	const servers: RawServer[] = [];

	before(() => {
		iso = createIsolation();
	});
	after(async () => {
		for (const server of servers) await server.dispose();
		await iso.cleanup();
	});

	async function startWith(env: Record<string, string>) {
		const saved = { ...iso.env };
		Object.assign(iso.env, env);
		try {
			const server = new RawServer(iso);
			servers.push(server);
			await server.initialize();
			return server;
		} finally {
			for (const key of Object.keys(env)) delete iso.env[key];
			Object.assign(iso.env, saved);
		}
	}

	for (const value of ["0", "1"]) {
		test(`WORKER_MCP_LEGACY_TOOLS=${value} starts the server with one warning`, async () => {
			const server = await startWith({ WORKER_MCP_LEGACY_TOOLS: value });
			await expectOneWarning(server);
			const names = await toolNames(server);
			assert.strictEqual(names.length, 13);
			assert.ok(names.every((n) => !n.includes("_pi_")));
		});
	}

	test("a config file with legacyTools starts the server with one warning", async () => {
		const file = path.join(iso.root, "legacy-config.json");
		fs.writeFileSync(file, JSON.stringify({ legacyTools: false }), {
			mode: 0o600,
		});
		const server = await startWith({ WORKER_MCP_CONFIG: file });
		await expectOneWarning(server);
		assert.strictEqual((await toolNames(server)).length, 13);
	});
});
