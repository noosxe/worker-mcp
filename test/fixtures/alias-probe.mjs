// Runs inside an outer bubblewrap where the home directory is also mounted at
// a second path. Starts the sandbox the way the server does and reports what
// can be listed through each path. Usage: alias-probe.mjs <bwrap> <home> <alias> <cwd> <privateDir>
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const [bwrap, home, alias, cwd, privateDir] = process.argv.slice(2);
const dist = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"dist",
	"core",
	"sandbox.js",
);
const { planSandbox, buildBwrapArgs } = await import(dist);
const plan = planSandbox({
	cwd,
	privateDir,
	home,
	profile: { roHome: [], rwHome: [] },
	extraRo: [],
	extraRw: [],
});
const script = `echo probe-ran; echo "via-home: $(ls -A ${home}/.ssh 2>&1 | tr '\\n' ' ')"; echo "via-alias: $(ls -A ${alias}/.ssh 2>&1 | tr '\\n' ' ')"`;
const r = spawnSync(
	bwrap,
	[...buildBwrapArgs(plan), "--", "sh", "-c", script],
	{
		encoding: "utf8",
	},
);
console.log(
	JSON.stringify({
		hidden: plan.hidden,
		status: r.status,
		out: r.stdout,
		err: r.stderr,
	}),
);
