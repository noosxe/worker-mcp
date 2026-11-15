# Agent Guidelines: worker-mcp Development

Welcome, AI Agent! To maintain environment consistency and reproducibility across development setups, this project enforces the use of a Nix development shell.

Please adhere to the following rules when contributing code, running tests, or managing dependencies:

---

## 1. Mandatory Nix Dev Shell Usage

You **MUST** run all build commands, linters, tests, and scripts inside the Nix development shell defined in [flake.nix](../flake.nix).

### How to Run Commands

- **One-off Commands**: Run shell commands prefixed with `nix develop --command`.
  - _Example_: `nix develop --command pnpm install`
  - _Example_: `nix develop --command pnpm build`
- **Never register the dev shell as the MCP server.** Do not use `nix develop --command …` as an MCP server's command. A shell hook or any other output on stdout corrupts the stdio protocol. Register the built binary or `nix run` instead (see the README).
- **Persistent Shell**: If you are running commands in a persistent shell terminal, ensure the terminal has entered the environment first by executing `nix develop` (or that `direnv` has automatically loaded it).

---

## 2. Managing Dependencies

- **Node.js Dependencies**: Manage all project libraries (dependencies and devDependencies) inside `package.json` using `pnpm`. Run installation with `nix develop --command pnpm install`.
- **System/Tooling Dependencies**: If the project requires new system packages, compiler tools, or external CLI binaries (e.g., `git`, custom linters, rust runtimes):
  1. Add them to the `buildInputs` list in [flake.nix](../flake.nix).
  2. Do **NOT** instruct the user to run global installations (e.g., `npm install -g` or `apt-get install`) for development tools.

---

## 3. General Development Guidelines

- **Project Structure**: Follow the architectural design documented in [../docs/architecture.md](../docs/architecture.md).
- **Code Style**: Ensure typescript linting and formatting conform to standard rules. Run format checks within the Nix shell.
- **Docs**: the files in [docs/](../docs) describe the current design. If you change behaviour, change the doc in the same PR. A doc kept for history carries a note at the top that says so.
- **Test isolation**: tests never touch the real home. Server processes and tests run with a private `HOME` and private `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_RUNTIME_DIR` (see [test/helpers/isolation.ts](../test/helpers/isolation.ts)). Use that helper for any test that starts the server or writes config, state or audit files.
- **Private information**: no absolute local paths, usernames, hostnames or real email addresses in tracked files. Use `$HOME`, `/home/user` and `example.com`. `node scripts/check-private-info.js` checks this and runs in CI.
- **Pre-commit Checklist**: You **MUST** run the project's linter and formatter before committing any code to avoid CI failures. Use `nix develop --command pnpm run lint:fix` to auto-fix and format issues.
