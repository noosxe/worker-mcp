# Agent Guidelines: worker-mcp Development

Welcome, AI Agent! To maintain environment consistency and reproducibility across development setups, this project enforces the use of a Nix development shell. 

Please adhere to the following rules when contributing code, running tests, or managing dependencies:

---

## 1. Mandatory Nix Dev Shell Usage

You **MUST** run all build commands, linters, tests, and scripts inside the Nix development shell defined in [flake.nix](file:///home/mechsoull/Projects/worker-mcp/flake.nix).

### How to Run Commands
* **One-off Commands**: Run shell commands prefixed with `nix develop --command`.
  * *Example*: `nix develop --command pnpm install`
  * *Example*: `nix develop --command pnpm build`
  * *Example*: `nix develop --command node dist/index.js`
* **Persistent Shell**: If you are running commands in a persistent shell terminal, ensure the terminal has entered the environment first by executing `nix develop` (or that `direnv` has automatically loaded it).

---

## 2. Managing Dependencies

* **Node.js Dependencies**: Manage all project libraries (dependencies and devDependencies) inside `package.json` using `pnpm`. Run installation with `nix develop --command pnpm install`.
* **System/Tooling Dependencies**: If the project requires new system packages, compiler tools, or external CLI binaries (e.g., `git`, custom linters, rust runtimes):
  1. Add them to the `buildInputs` list in [flake.nix](file:///home/mechsoull/Projects/worker-mcp/flake.nix).
  2. Do **NOT** instruct the user to run global installations (e.g., `npm install -g` or `apt-get install`) for development tools.

---

## 3. General Development Guidelines

* **Project Structure**: Follow the architectural design documented in [/docs/architecture.md](file:///home/mechsoull/Projects/worker-mcp/docs/architecture.md).
* **Code Style**: Ensure typescript linting and formatting conform to standard rules. Run format checks within the Nix shell.
* **Pre-commit Checklist**: You **MUST** run the project's linter and formatter before committing any code to avoid CI failures. Use `nix develop --command pnpm exec biome check --write .` to auto-fix and format issues.
