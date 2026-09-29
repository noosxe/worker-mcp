# Release Process (npm)

This is the standard release process used in this repo, generalized so it can be
reproduced in any npm/pnpm package repo. It follows a
**script → PR → merge → CI publishes** flow: releases are initiated manually,
reviewed as a pull request, then tagged and published automatically by GitHub
Actions on merge to `main`.

- **Channel:** npm (public scoped package, published with provenance)
- **Trigger:** push to `main` with an untagged `package.json` version, or a
  manual tag push matching `v*`
- **Artifacts:** npm package + GitHub Release with auto-generated notes

---

## Prerequisites

The repo needs this setup (all snippets below):

| Piece                            | Purpose                                                             |
| -------------------------------- | ------------------------------------------------------------------- |
| `scripts/release.js`             | Local script that bumps the version and opens the release PR        |
| `package.json` scripts           | `build`, `lint`, `test`, `prepublishOnly`, `publish-npm`, `release` |
| `.github/workflows/ci.yml`       | Lint/build/test gate on every push/PR to `main`                     |
| `.github/workflows/release.yml`  | Tags, publishes to npm, creates the GitHub Release                  |
| Husky pre-commit hook (optional) | Auto-formats/lints staged files on every commit                     |
| `gh` CLI authenticated locally   | Used by the release script to create the PR                         |
| npm trusted publishing (OIDC)    | Lets CI publish with provenance and no long-lived `NPM_TOKEN`       |

Configure the package for trusted publishing on npmjs.com (package settings →
publishing access) so the GitHub Actions OIDC identity can publish. If you
prefer a token instead, add `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` to the
publish step and drop `--provenance`.

---

## Phase 1 — Local: version bump PR

Run:

```sh
pnpm release <patch | minor | major | x.y.z>
```

The script (`scripts/release.js`):

1. **Validates** — requires a release-type argument; aborts if `git status` is
   not clean (commit or stash first).
2. **Computes the next version** from `package.json` (manual semver math for
   `patch`/`minor`/`major`, or uses an explicit version string).
3. **Creates branch** `release/v{nextVersion}`.
4. **Bumps `package.json`** via `pnpm version {nextVersion} --no-git-tag-version`.
5. **Syncs the lockfile** — runs `pnpm install` and stages `pnpm-lock.yaml` if
   it changed.
6. **Commits** `chore(release): bump version to v{nextVersion}` (the pre-commit
   hook formats/lints staged files if installed).
7. **Pushes** the branch and **opens a PR to `main`** via `gh pr create`.

Note: no tag is created locally — tagging happens in CI after merge.

## Phase 2 — CI gate on the release PR

`ci.yml` runs on every push/PR to `main`:

- `pnpm install --frozen-lockfile`
- Lint (`pnpm run lint`)
- Build (`pnpm run build`)
- Tests (`pnpm run test`)

Merge the release PR once green.

## Phase 3 — Automated: tag, publish, GitHub Release

`release.yml` triggers on push to `main` or a tag push matching
`v[0-9]+.[0-9]+.[0-9]+*`.

**Job `check`** — decides whether to release:

- Tag push → release that tag.
- Main push → read `version` from `package.json`; if tag `v{version}` already
  exists, skip (this makes regular pushes to `main` no-ops). Otherwise release.

**Job `release`** (when needed):

1. If triggered by a main push: **creates and pushes the git tag** as
   `github-actions[bot]`.
2. Sets up pnpm + Node (cached), `pnpm install --frozen-lockfile`.
3. **Lint → Build → Test** (same gates as CI).
4. **Publishes to npm**: `pnpm publish --access public --provenance
--no-git-checks` (`prepublishOnly` runs the build again first).
5. **Creates the GitHub Release**: `gh release create {tag} --generate-notes`
   (changelog auto-generated from commits).

---

## Reference implementation

### `package.json` (relevant scripts)

```json
{
	"scripts": {
		"build": "tsc",
		"lint": "oxlint && oxfmt --check .",
		"test": "node --import tsx --test src/__tests__/*.test.ts",
		"prepublishOnly": "pnpm run build",
		"publish-npm": "pnpm publish --access public",
		"release": "node scripts/release.js"
	}
}
```

Swap lint/test commands for whatever your repo uses; only `prepublishOnly`,
`publish-npm`, and `release` are structurally required.

### `scripts/release.js`

```js
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

	// 5. Stage files
	console.log("Staging files...");
	execSync("git add package.json", { stdio: "inherit" });

	// Stage pnpm-lock.yaml if it was modified
	if (fs.existsSync("pnpm-lock.yaml")) {
		execSync("pnpm install", { stdio: "inherit" });
		execSync("git add pnpm-lock.yaml", { stdio: "inherit" });
	}

	// 6. Commit changes
	const commitMsg = `chore(release): bump version to v${nextVersion}`;
	console.log(`Committing: "${commitMsg}"...`);
	execSync(`git commit -m "${commitMsg}"`, { stdio: "inherit" });

	// 7. Push branch to remote origin
	console.log(`Pushing branch ${branchName} to origin...`);
	execSync(`git push -u origin ${branchName}`, { stdio: "inherit" });

	// 8. Create Pull Request
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
```

### `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-test-lint:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v7

      - name: Install pnpm
        uses: pnpm/action-setup@v6
        with:
          version: 11

      - name: Setup Node.js
        uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Lint code
        run: pnpm run lint

      - name: Build code
        run: pnpm run build

      - name: Run tests
        run: pnpm run test
```

### `.github/workflows/release.yml`

```yaml
name: Release

on:
  push:
    branches:
      - main
    tags:
      - "v[0-9]+.[0-9]+.[0-9]+*"
      - "[0-9]+.[0-9]+.[0-9]+*"

permissions:
  contents: write
  id-token: write

jobs:
  check:
    name: Check if Release is Needed
    runs-on: ubuntu-latest
    outputs:
      should_release: ${{ steps.check_tag.outputs.should_release }}
      tag_name: ${{ steps.check_tag.outputs.tag_name }}
    steps:
      - name: Checkout repository
        uses: actions/checkout@v7
        with:
          fetch-depth: 0

      - name: Determine if tag exists
        id: check_tag
        run: |
          if [[ "${{ github.ref }}" == refs/tags/* ]]; then
            TAG_NAME="${{ github.ref_name }}"
            echo "Triggered by tag push. Tag: $TAG_NAME"
            echo "should_release=true" >> "$GITHUB_OUTPUT"
            echo "tag_name=$TAG_NAME" >> "$GITHUB_OUTPUT"
          else
            VERSION=$(jq -r .version package.json)
            TAG_NAME="v$VERSION"
            echo "Triggered by main push. Package version: $VERSION (tag: $TAG_NAME)"
            if git rev-parse "$TAG_NAME" >/dev/null 2>&1; then
              echo "Tag $TAG_NAME already exists. Skipping release."
              echo "should_release=false" >> "$GITHUB_OUTPUT"
            else
              echo "Tag $TAG_NAME does not exist. Proceeding with release."
              echo "should_release=true" >> "$GITHUB_OUTPUT"
              echo "tag_name=$TAG_NAME" >> "$GITHUB_OUTPUT"
            fi
          fi

  release:
    name: Build, Test, and Publish
    needs: check
    if: needs.check.outputs.should_release == 'true'
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v7
        with:
          fetch-depth: 0

      - name: Create and Push Git Tag
        if: github.ref == 'refs/heads/main'
        run: |
          git config --global user.name "github-actions[bot]"
          git config --global user.email "github-actions[bot]@users.noreply.github.com"
          git tag "${{ needs.check.outputs.tag_name }}"
          git push origin "${{ needs.check.outputs.tag_name }}"

      - name: Install pnpm
        uses: pnpm/action-setup@v6
        with:
          version: 11

      - name: Setup Node.js
        uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Lint code
        run: pnpm run lint

      - name: Build code
        run: pnpm run build

      - name: Run tests
        run: pnpm run test

      - name: Publish to NPM
        run: pnpm run publish-npm --provenance --no-git-checks

      - name: Create GitHub Release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh release create ${{ needs.check.outputs.tag_name }} \
            --title "${{ needs.check.outputs.tag_name }}" \
            --generate-notes
```

### Husky pre-commit hook (optional)

`.husky/pre-commit` — formats and lints only the staged files:

```sh
# Lint + format staged files only (oxlint/oxfmt have no --staged flag).
FILES=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '\.(js|mjs|cjs|ts|tsx|jsx|json|jsonc|md|css)$' || true)

if [ -n "$FILES" ]; then
	printf '%s\n' "$FILES" | xargs pnpm exec oxfmt
	printf '%s\n' "$FILES" | xargs pnpm exec oxlint --fix
	printf '%s\n' "$FILES" | xargs git add --
fi
```

---

## Porting to another repo — checklist

Adjust the following when copying this setup:

- [ ] `package.json`: name, `publishConfig` (for scoped access), and the
      `lint`/`test`/`build` commands for your toolchain.
- [ ] `pnpm publish --access public` — drop for unscoped packages, or set
      `publishConfig.access` and simplify to `pnpm publish`.
- [ ] Node and pnpm versions in both workflows.
- [ ] Default branch name (`main`) in `release.js`, `gh pr create --base`, and
      workflow `branches:` filters.
- [ ] npm trusted publishing: register the repo + workflow + environment on
      npmjs.com, or switch to an `NPM_TOKEN` secret.
- [ ] `files`/`bin` in `package.json` — make sure only what should ship is
      included (e.g. `dist`).
- [ ] Install the pre-commit hook (`pnpm exec husky init`) if you want the
      formatting gate.

## Notes and quirks

- Regular pushes to `main` never release anything: the `check` job compares
  `package.json`'s version against existing tags and skips if the tag exists.
  A release happens only when the version bumps.
- Tags are created by CI (`github-actions[bot]`) during the release job — not
  locally. Pushing a `v*` tag manually also triggers a release, which is the
  escape hatch for re-releasing.
- The lockfile is re-synced (`pnpm install`) during the bump so the release PR
  always contains a consistent `pnpm-lock.yaml`.
- `--no-git-checks` on publish allows publishing even though the working tree
  and branch name wouldn't pass pnpm's default git checks in CI.
