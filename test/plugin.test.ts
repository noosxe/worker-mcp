import assert from "node:assert";
import * as fs from "node:fs";
import { describe, test } from "node:test";

import { ENV_VARS } from "../src/config.js";

const read = (file: string) =>
	JSON.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

describe("Claude Code plugin files", () => {
	const manifest = read(".claude-plugin/plugin.json");
	const mcp = read(".mcp.json");
	const server = mcp.mcpServers["worker-mcp"];

	test("the manifest names the plugin and its options", () => {
		assert.strictEqual(manifest.name, "worker-mcp");
		// A release bumps package.json; the plugin follows the repository
		// revision, so the manifest carries no version of its own.
		assert.strictEqual(manifest.version, undefined);
		assert.deepStrictEqual(
			new Set(Object.keys(manifest.userConfig)),
			new Set(["allowed_roots", "default_model", "pi_path"]),
		);
	});

	test(".mcp.json runs worker-mcp with variables the server understands", () => {
		assert.strictEqual(server.command, "worker-mcp");
		const known = new Set<string>(Object.values(ENV_VARS).map((v) => v.name));
		for (const [name, value] of Object.entries<string>(server.env)) {
			assert.ok(known.has(name), `${name} is a WORKER_MCP_* variable`);
			for (const [, key] of value.matchAll(/\$\{user_config\.(\w+)\}/g)) {
				assert.ok(manifest.userConfig[key], `${name} uses option ${key}`);
			}
		}
	});

	test("the marketplace lists the plugin at the repository root", () => {
		const market = read(".claude-plugin/marketplace.json");
		assert.strictEqual(market.plugins[0].name, manifest.name);
		assert.strictEqual(market.plugins[0].source, "./");
	});

	test("the skill is named like the plugin's skill folder", () => {
		const skill = fs.readFileSync(
			new URL("../skills/worker-mcp/SKILL.md", import.meta.url),
			"utf8",
		);
		assert.match(skill, /^---\nname: worker-mcp\n/);
	});
});
