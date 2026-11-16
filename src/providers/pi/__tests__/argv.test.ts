import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

import { buildPiArgs, workspaceSkillDirs } from "../argv.js";
import { PI_SANDBOX_PROFILE, piSandboxProfile } from "../provider.js";

describe("skills", () => {
	const base = { gateFile: "/gate.ts" };

	test("are left to pi by default and when on", () => {
		assert.ok(!buildPiArgs(base).includes("--no-skills"));
		assert.ok(!buildPiArgs({ ...base, skills: true }).includes("--no-skills"));
	});

	test("off: --no-skills, then the workspace's own directories", () => {
		const args = buildPiArgs({
			...base,
			skills: false,
			workspaceSkillDirs: ["/ws/.pi/skills"],
		});
		assert.ok(args.includes("--no-skills"));
		assert.strictEqual(args[args.indexOf("--skill") + 1], "/ws/.pi/skills");
	});

	test("the sandbox profile omits the skills directory only when off", () => {
		assert.strictEqual(piSandboxProfile(true), PI_SANDBOX_PROFILE);
		assert.strictEqual(PI_SANDBOX_PROFILE.overlayOmitHome, undefined);
		assert.deepStrictEqual(piSandboxProfile(false).overlayOmitHome, [
			".pi/agent/skills",
		]);
	});
});

const mk = (...p: string[]) => {
	const d = path.join(...p);
	fs.mkdirSync(d, { recursive: true });
	return d;
};

describe("workspaceSkillDirs", () => {
	test("finds the directories from cwd up to the repository root", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));
		try {
			mk(root, "repo", ".git");
			mk(root, "repo", ".pi", "skills");
			mk(root, "repo", "pkg", ".agents", "skills");
			mk(root, ".pi", "skills"); // above the repository: not the project's
			const cwd = mk(root, "repo", "pkg");
			assert.deepStrictEqual(workspaceSkillDirs(cwd), [
				path.join(root, "repo", "pkg", ".agents", "skills"),
				path.join(root, "repo", ".pi", "skills"),
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("outside a repository only cwd counts", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));
		try {
			mk(root, ".agents", "skills");
			const cwd = mk(root, "w", ".pi", "skills");
			assert.deepStrictEqual(
				workspaceSkillDirs(path.dirname(path.dirname(cwd))),
				[cwd],
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
