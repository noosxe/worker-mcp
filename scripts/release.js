import { execSync } from "node:child_process";
import fs from "node:fs";

// 1. Get the release type or version argument
const releaseType = process.argv[2];
if (!releaseType) {
	console.error(
		"Error: Please specify a release type (patch, minor, major) or a specific version.",
	);
	process.exit(1);
}

try {
	// 2. Check if git status is clean
	const gitStatus = execSync("git status --porcelain", {
		encoding: "utf8",
	}).trim();
	if (gitStatus) {
		console.error(
			"Error: Git working directory is not clean. Please commit or stash your changes first.",
		);
		process.exit(1);
	}

	console.log(`Bumping version using release type/version: ${releaseType}...`);

	// 3. Run pnpm version to update package.json
	execSync(`pnpm version ${releaseType} --no-git-tag-version`, {
		stdio: "inherit",
	});

	// 4. Read the new version from package.json
	const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
	const newVersion = pkg.version;
	console.log(`New version determined: ${newVersion}`);

	// 5. Update flake.nix
	const flakePath = "flake.nix";
	if (fs.existsSync(flakePath)) {
		console.log(`Updating version to ${newVersion} in ${flakePath}...`);
		let flakeContent = fs.readFileSync(flakePath, "utf8");

		// Replace version = "x.y.z"; with the new version
		flakeContent = flakeContent.replace(
			/version\s*=\s*"[0-9]+\.[0-9]+\.[0-9]+[^"]*";/g,
			`version = "${newVersion}";`,
		);

		fs.writeFileSync(flakePath, flakeContent, "utf8");
	}

	// 6. Stage files
	console.log("Staging files...");
	execSync("git add package.json flake.nix", { stdio: "inherit" });

	// Staging pnpm-lock.yaml if it was modified
	if (fs.existsSync("pnpm-lock.yaml")) {
		execSync("pnpm install", { stdio: "inherit" });
		execSync("git add pnpm-lock.yaml", { stdio: "inherit" });
	}

	// 7. Commit changes
	const commitMsg = `chore(release): bump version to v${newVersion}`;
	console.log(`Committing: "${commitMsg}"...`);
	execSync(`git commit -m "${commitMsg}"`, { stdio: "inherit" });

	// 8. Create Git Tag
	const tagName = `v${newVersion}`;
	console.log(`Creating Git tag: ${tagName}...`);
	execSync(`git tag ${tagName}`, { stdio: "inherit" });

	console.log(
		"\nRelease prepared successfully! To push to remote and trigger release workflow, run:",
	);
	console.log(`  git push && git push origin ${tagName}\n`);
} catch (error) {
	console.error("Release script failed:", error.message);
	process.exit(1);
}
