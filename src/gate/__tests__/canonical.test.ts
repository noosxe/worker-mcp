import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";

import {
	canonicalize,
	piToolMap,
	type CanonicalToolCall,
} from "../canonical.js";
import { isInside, realResolve } from "../paths.js";
import { ProtectedPaths } from "../protected-paths.js";
import { fixture, type Fixture } from "./helpers.js";

let fx: Fixture;
beforeEach(() => {
	fx = fixture();
});
afterEach(() => fx.cleanup());

const map = (
	toolName: string,
	input: Record<string, unknown>,
): CanonicalToolCall =>
	canonicalize(
		{ provider: "pi", toolName, input },
		{
			cwd: fx.ws,
			home: fx.home,
			protectedPaths: new ProtectedPaths({ workspace: fx.ws, home: fx.home }),
		},
	);

describe("pi tool map", () => {
	test("covers pi's seven tools with the right kinds", () => {
		assert.deepStrictEqual(
			Object.fromEntries(
				Object.entries(piToolMap).map(([k, v]) => [k, v.kind]),
			),
			{
				bash: "shell",
				read: "read",
				ls: "list",
				grep: "search",
				find: "search",
				edit: "edit",
				write: "write",
			},
		);
	});

	test("bash carries its command", () => {
		const call = map("bash", { command: "ls -la" });
		assert.strictEqual(call.kind, "shell");
		assert.strictEqual(call.command, "ls -la");
		assert.deepStrictEqual(call.paths, []);
		assert.strictEqual(call.malformed, undefined);
	});

	for (const tool of ["read", "edit", "write"] as const) {
		test(`${tool} resolves a relative path against the workspace`, () => {
			const call = map(tool, { path: "src/a.ts" });
			assert.strictEqual(call.paths.length, 1);
			assert.strictEqual(call.paths[0].abs, path.join(fx.ws, "src", "a.ts"));
			assert.strictEqual(call.paths[0].inWorkspace, true);
		});
	}

	for (const tool of ["ls", "grep", "find"] as const) {
		test(`${tool} defaults its path to the workspace`, () => {
			const call = map(tool, {});
			assert.strictEqual(call.paths[0].abs, fx.ws);
			assert.strictEqual(call.paths[0].inWorkspace, true);
		});
		test(`${tool} resolves a given path`, () => {
			const call = map(tool, { path: "../outside" });
			assert.strictEqual(call.paths[0].abs, fx.outside);
			assert.strictEqual(call.paths[0].inWorkspace, false);
		});
	}

	test("a missing or non-string argument makes the call malformed", () => {
		assert.ok(map("read", {}).malformed);
		assert.ok(map("write", { path: 5 }).malformed);
		assert.ok(map("edit", { path: "" }).malformed);
		assert.ok(map("bash", {}).malformed);
		assert.ok(map("bash", { command: ["ls"] }).malformed);
	});

	test("an unknown tool is kind other; mcp__ names are mcp", () => {
		assert.strictEqual(map("read_file", { path: "a" }).kind, "other");
		assert.strictEqual(map("Bash", { command: "ls" }).kind, "other");
		assert.strictEqual(map("mcp__x__y", {}).kind, "mcp");
		// Object.prototype names are not tools.
		assert.strictEqual(map("constructor", {}).kind, "other");
		assert.strictEqual(map("__proto__", {}).kind, "other");
	});
});

describe("path resolution", () => {
	test("`..` out of the workspace is outside", () => {
		assert.strictEqual(
			map("read", { path: "src/../../outside/x" }).paths[0].inWorkspace,
			false,
		);
		assert.strictEqual(
			map("read", { path: "../ws/src/x" }).paths[0].inWorkspace,
			true,
		);
	});

	test("a sibling that shares the workspace's name as a prefix is outside", () => {
		const sibling = `${fx.ws}-evil`;
		fs.mkdirSync(sibling);
		const call = map("write", { path: path.join(sibling, "x") });
		assert.strictEqual(call.paths[0].inWorkspace, false);
		assert.ok(!isInside(fx.ws, `${fx.ws}-evil/x`));
		assert.ok(isInside(fx.ws, `${fx.ws}/..foo`));
		assert.ok(!isInside(fx.ws, `${fx.ws}/../x`));
	});

	test("a symlink to a directory outside leads outside", () => {
		fs.symlinkSync(fx.outside, path.join(fx.ws, "link"));
		fs.writeFileSync(path.join(fx.outside, "secret"), "x");
		const existing = map("read", { path: "link/secret" }).paths[0];
		assert.strictEqual(existing.inWorkspace, false);
		assert.strictEqual(existing.abs, path.join(fx.outside, "secret"));
		// A file that does not exist yet is judged by the real parent.
		const created = map("write", { path: "link/new.txt" }).paths[0];
		assert.strictEqual(created.inWorkspace, false);
		assert.strictEqual(created.abs, path.join(fx.outside, "new.txt"));
	});

	test("a symlink to a file outside is outside", () => {
		fs.writeFileSync(path.join(fx.outside, "f"), "x");
		fs.symlinkSync(path.join(fx.outside, "f"), path.join(fx.ws, "f"));
		assert.strictEqual(map("edit", { path: "f" }).paths[0].inWorkspace, false);
	});

	test("`..` after a symlink follows the link, as the OS does", () => {
		// ws/link -> outside/deep; `link/..` is outside, not the workspace.
		fs.mkdirSync(path.join(fx.outside, "deep"));
		fs.symlinkSync(path.join(fx.outside, "deep"), path.join(fx.ws, "link"));
		const p = map("write", { path: "link/../x" }).paths[0];
		assert.strictEqual(p.abs, path.join(fx.outside, "x"));
		assert.strictEqual(p.inWorkspace, false);
	});

	test("a symlink that stays inside is inside", () => {
		fs.symlinkSync(path.join(fx.ws, "src"), path.join(fx.ws, "alias"));
		const p = map("write", { path: "alias/a.ts" }).paths[0];
		assert.strictEqual(p.abs, path.join(fx.ws, "src", "a.ts"));
		assert.strictEqual(p.inWorkspace, true);
	});

	test("a workspace reached through a symlink is compared by its real path", () => {
		const alias = path.join(fx.root, "ws-alias");
		fs.symlinkSync(fx.ws, alias);
		const call = canonicalize(
			{ provider: "pi", toolName: "read", input: { path: "src/a" } },
			{
				cwd: alias,
				home: fx.home,
				protectedPaths: new ProtectedPaths({ workspace: fx.ws, home: fx.home }),
			},
		);
		assert.strictEqual(call.paths[0].inWorkspace, true);
	});

	test("a symlink loop is unresolved and counts as outside", () => {
		fs.symlinkSync(path.join(fx.ws, "b"), path.join(fx.ws, "a"));
		fs.symlinkSync(path.join(fx.ws, "a"), path.join(fx.ws, "b"));
		const p = map("write", { path: "a" }).paths[0];
		assert.strictEqual(p.unresolved, true);
		assert.strictEqual(p.inWorkspace, false);
		assert.strictEqual(realResolve(fx.ws, "a").unresolved, true);
	});

	test("`~` and a leading `@` are both read as the tool might", () => {
		const home = map("read", { path: "~/.ssh/id" }).paths;
		assert.ok(home.some((p) => p.abs === path.join(fx.home, ".ssh", "id")));
		const at = map("read", { path: "@src/a.ts" }).paths;
		assert.ok(at.some((p) => p.abs === path.join(fx.ws, "src", "a.ts")));
		assert.ok(at.some((p) => p.abs === path.join(fx.ws, "@src", "a.ts")));
	});

	test("protected paths are marked, by access", () => {
		const w = map("write", { path: ".mcp.json" }).paths[0];
		assert.strictEqual(w.protected, "coordinator-config");
		// Reading .mcp.json is fine; reading a secret is not.
		assert.strictEqual(
			map("read", { path: ".mcp.json" }).paths[0].protected,
			undefined,
		);
		assert.strictEqual(
			map("read", { path: ".env" }).paths[0].protected,
			"secrets",
		);
	});
});
