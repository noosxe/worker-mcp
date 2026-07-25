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

	// 3. Read current version and calculate next version
	const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
	const currentVersion = pkg.version;

	let nextVersion;
	if (releaseType === "patch") {
		const parts = currentVersion.split(".").map(Number);
		nextVersion = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
	} else if (releaseType === "minor") {
		const parts = currentVersion.split(".").map(Number);
		nextVersion = `${parts[0]}.${parts[1] + 1}.0`;
	} else if (releaseType === "major") {
		const parts = currentVersion.split(".").map(Number);
		nextVersion = `${parts[0] + 1}.0.0`;
	} else {
		// Assume a specific version string was passed
		nextVersion = releaseType;
	}

	console.log(`Current version: ${currentVersion}`);
	console.log(`Bumping to next version: ${nextVersion}`);

	const branchName = `release/v${nextVersion}`;
	console.log(`Creating release branch: ${branchName}...`);
	execSync(`git checkout -b ${branchName}`, { stdio: "inherit" });

	// 4. Update package.json using pnpm version
	execSync(`pnpm version ${nextVersion} --no-git-tag-version`, {
		stdio: "inherit",
	});

	// 5. Update flake.nix
	const flakePath = "flake.nix";
	if (fs.existsSync(flakePath)) {
		console.log(`Updating version to ${nextVersion} in ${flakePath}...`);
		let flakeContent = fs.readFileSync(flakePath, "utf8");

		// Replace version = "x.y.z"; with the new version
		flakeContent = flakeContent.replace(
			/version\s*=\s*"[0-9]+\.[0-9]+\.[0-9]+[^"]*";/g,
			`version = "${nextVersion}";`,
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
	const commitMsg = `chore(release): bump version to v${nextVersion}`;
	console.log(`Committing: "${commitMsg}"...`);
	execSync(`git commit -m "${commitMsg}"`, { stdio: "inherit" });

	// 8. Push branch to remote origin
	console.log(`Pushing branch ${branchName} to origin...`);
	execSync(`git push -u origin ${branchName}`, { stdio: "inherit" });

	// 9. Create Pull Request
	console.log("Creating Pull Request to main...");
	execSync(
		`gh pr create --title "${commitMsg}" --body "Automated version bump to v${nextVersion} in preparation for release." --base main --head ${branchName}`,
		{ stdio: "inherit" },
	);

	console.log(
		`\nRelease PR created successfully! Switched to branch ${branchName}.`,
	);
} catch (error) {
	console.error("Release script failed:", error.message);
	process.exit(1);
}
