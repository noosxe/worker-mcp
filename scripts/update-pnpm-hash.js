import { execSync } from "node:child_process";
import fs from "node:fs";

const FLAKE_PATH = "flake.nix";
const FAKE_HASH = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function main() {
	if (!fs.existsSync(FLAKE_PATH)) {
		console.error(`Error: ${FLAKE_PATH} not found.`);
		process.exit(1);
	}

	const flakeContent = fs.readFileSync(FLAKE_PATH, "utf8");

	// Match pnpmHash = "..."; or hash = "..."; in flake.nix
	const hashRegex = /pnpmHash\s*=\s*"([^"]+)";/;
	const match = flakeContent.match(hashRegex);

	if (!match) {
		console.error(`Error: Could not find 'pnpmHash = "...";' in ${FLAKE_PATH}`);
		process.exit(1);
	}

	const originalHash = match[1];
	console.log(`Current pnpmHash in ${FLAKE_PATH}: ${originalHash}`);

	// Temporarily replace hash with FAKE_HASH to trigger Nix hash mismatch
	const tempContent = flakeContent.replace(
		hashRegex,
		`pnpmHash = "${FAKE_HASH}";`,
	);
	fs.writeFileSync(FLAKE_PATH, tempContent, "utf8");

	console.log("Calculating new pnpmDeps hash via Nix...");
	let output = "";
	try {
		execSync("nix build .#worker-mcp --no-link --print-build-logs", {
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (err) {
		output = (err.stdout || "") + (err.stderr || "");
	} finally {
		// If anything goes wrong or before finishing, ensure we don't leave broken content if parsing fails
	}

	const gotMatch = output.match(/got:\s*(sha256-[A-Za-z0-9+/=]+)/);

	if (!gotMatch) {
		// Restore original flake content
		fs.writeFileSync(FLAKE_PATH, flakeContent, "utf8");
		console.error("Error: Could not determine new hash from Nix output.");
		console.error("Nix output:\n", output);
		process.exit(1);
	}

	const newHash = gotMatch[1];

	if (newHash === originalHash) {
		console.log(
			`pnpmHash in ${FLAKE_PATH} is already up to date (${originalHash}).`,
		);
		fs.writeFileSync(FLAKE_PATH, flakeContent, "utf8");
		return;
	}

	console.log(`New hash calculated: ${newHash}`);

	const updatedContent = flakeContent.replace(
		hashRegex,
		`pnpmHash = "${newHash}";`,
	);
	fs.writeFileSync(FLAKE_PATH, updatedContent, "utf8");

	console.log("Verifying Nix build with updated hash...");
	try {
		execSync("nix build .#worker-mcp --no-link", {
			encoding: "utf8",
			stdio: "inherit",
		});
		console.log(
			`Successfully updated pnpmHash in ${FLAKE_PATH} to ${newHash}!`,
		);
	} catch (_err) {
		console.error("Verification build failed. Restoring original flake.nix.");
		fs.writeFileSync(FLAKE_PATH, flakeContent, "utf8");
		process.exit(1);
	}
}

main();
