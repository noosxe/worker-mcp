import assert from "node:assert";
import * as fs from "node:fs";
import { describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";
import { SessionManager } from "../../src/session/session-manager.js";
import { call } from "../helpers/behaviour.js";
import {
	applyEnv,
	createIsolation,
	type Isolation,
	waitUntil,
} from "../helpers/isolation.js";

async function withServer<T>(
	argv: string[],
	extraEnv: Record<string, string>,
	fn: (ctx: { iso: Isolation; client: Client }) => Promise<T>,
): Promise<T> {
	const iso = createIsolation();
	const restore = applyEnv(iso);
	const env = { ...process.env, ...iso.env, ...extraEnv };
	const manager = new SessionManager(loadConfig(argv, env).config, env);
	const server = createServer(manager, "0.0.0-test");
	const [a, b] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([server.connect(b), client.connect(a)]);
	try {
		return await fn({ iso, client });
	} finally {
		await manager.terminateAll();
		await client.close();
		restore();
		await iso.cleanup();
	}
}

const setModels = (iso: Isolation) =>
	fs
		.readFileSync(iso.recordFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.filter((l) => l.kind === "recv" && l.type === "set_model")
		.map((l) => `${l.provider}/${l.modelId}`);

const structured = (r: unknown) =>
	(r as { structuredContent: any }).structuredContent;

describe("default model", () => {
	test("config layering: file < env < flag", () => {
		const dir = createIsolation();
		try {
			const file = `${dir.root}/c.json`;
			fs.writeFileSync(
				file,
				JSON.stringify({ providers: { pi: { defaultModel: "a/file" } } }),
				{ mode: 0o600 },
			);
			const get = (argv: string[], env: Record<string, string>) =>
				loadConfig(["--config", file, ...argv], { ...dir.env, ...env }).config
					.providers.pi.defaultModel;
			assert.strictEqual(get([], {}), "a/file");
			assert.strictEqual(
				get([], { WORKER_MCP_PI_DEFAULT_MODEL: "b/env" }),
				"b/env",
			);
			assert.strictEqual(
				get(["--pi-default-model", "c/flag"], {
					WORKER_MCP_PI_DEFAULT_MODEL: "b/env",
				}),
				"c/flag",
			);
		} finally {
			void dir.cleanup();
		}
	});

	test("spawn without model uses the default; an explicit model wins", async () => {
		await withServer(
			[],
			{ WORKER_MCP_PI_DEFAULT_MODEL: "zai/default-1" },
			async ({ iso, client }) => {
				const providers = structured(await call(client, "list_providers", {}));
				assert.strictEqual(
					providers.providers[0].defaultModel,
					"zai/default-1",
				);

				const plain = await call(client, "spawn_worker", { cwd: iso.cwd });
				assert.strictEqual(structured(plain).worker.model, "zai/default-1");
				await waitUntil(() => setModels(iso).length === 1, 5000, "set_model");
				assert.deepStrictEqual(setModels(iso), ["zai/default-1"]);

				const explicit = await call(client, "spawn_worker", {
					cwd: iso.cwd,
					model: "other/explicit",
				});
				assert.strictEqual(structured(explicit).worker.model, "other/explicit");
				await waitUntil(() => setModels(iso).length === 2, 5000, "set_model");
				assert.deepStrictEqual(setModels(iso), [
					"zai/default-1",
					"other/explicit",
				]);
			},
		);
	});

	test("without a default, no model is set", async () => {
		await withServer([], {}, async ({ iso, client }) => {
			const providers = structured(await call(client, "list_providers", {}));
			assert.strictEqual(providers.providers[0].defaultModel, undefined);
			const r = await call(client, "spawn_worker", { cwd: iso.cwd });
			assert.strictEqual(structured(r).worker.model, undefined);
			assert.deepStrictEqual(setModels(iso), []);
		});
	});
});
