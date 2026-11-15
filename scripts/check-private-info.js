// Fails when a tracked file holds an absolute user path (`/home/<name>/...`,
// `/Users/<name>/...`) or an email address outside the placeholder domains.
// Placeholders such as `/home/user`, `$HOME` and `name@example.com` pass.
// Run: node scripts/check-private-info.js
import { execFileSync } from "node:child_process";
import fs from "node:fs";

// Path components that are obviously placeholders, not a real account.
const PLACEHOLDER_USERS = new Set([
	"u",
	"a",
	"user",
	"username",
	"name",
	"me",
	"you",
	"foo",
	"example",
]);

const EMAIL_DOMAINS = new Set([
	"example.com",
	"example.org",
	"example.net",
	"noreply.github.com",
	"users.noreply.github.com",
]);

// Nothing the lockfiles hold is private, and they carry registry author data.
const SKIP_FILES = new Set(["pnpm-lock.yaml", "flake.lock"]);

// `/tmp/home/...` is a scratch directory that tests build, not a home.
const PATH_RE = /(?<!\/tmp)\/(?:home|Users)\/([A-Za-z0-9._-]+)/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
	.split("\0")
	.filter((f) => f && !SKIP_FILES.has(f) && fs.existsSync(f));

const hits = [];
for (const file of files) {
	const buf = fs.readFileSync(file);
	if (buf.includes(0)) continue; // binary
	buf
		.toString("utf8")
		.split("\n")
		.forEach((line, i) => {
			for (const m of line.matchAll(PATH_RE)) {
				if (!PLACEHOLDER_USERS.has(m[1])) {
					hits.push(`${file}:${i + 1}: absolute user path "${m[0]}"`);
				}
			}
			for (const m of line.matchAll(EMAIL_RE)) {
				if (!EMAIL_DOMAINS.has(m[1].toLowerCase())) {
					hits.push(`${file}:${i + 1}: email address at "${m[1]}"`);
				}
			}
		});
}

if (hits.length > 0) {
	console.error(hits.join("\n"));
	console.error(
		`\n${hits.length} private-info hit(s). Use a placeholder ($HOME, /home/user, example.com) or extend the allowlists in scripts/check-private-info.js.`,
	);
	process.exit(1);
}
console.log(`No private info found in ${files.length} tracked files.`);
