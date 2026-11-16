import assert from "node:assert";
import { describe, test } from "node:test";

import { buildPiArgs } from "../argv.js";
import { PI_SANDBOX_PROFILE, piSandboxProfile } from "../provider.js";

describe("skills", () => {
	const base = { gateFile: "/gate.ts" };

	test("are left to pi by default and when on", () => {
		assert.ok(!buildPiArgs(base).includes("--no-skills"));
		assert.ok(!buildPiArgs({ ...base, skills: true }).includes("--no-skills"));
	});

	test("off: only --no-skills", () => {
		const args = buildPiArgs({ ...base, skills: false });
		assert.ok(args.includes("--no-skills"));
		assert.ok(!args.includes("--skill"));
	});

	test("the sandbox profile omits the skills directory only when off", () => {
		assert.strictEqual(piSandboxProfile(true), PI_SANDBOX_PROFILE);
		assert.strictEqual(PI_SANDBOX_PROFILE.overlayOmitHome, undefined);
		assert.deepStrictEqual(piSandboxProfile(false).overlayOmitHome, [
			".pi/agent/skills",
		]);
	});
});
