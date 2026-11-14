# worker-mcp

`worker-mcp` is a Model Context Protocol (MCP) server that empowers a highly intelligent coordinator agent (like Claude 3.5 Sonnet or Gemini Pro) to spawn, control, and interactively guide lower-intelligence, locally hosted worker agents.

Instead of rolling a custom local LLM tool loop, `worker-mcp` delegates coding, bash, and filesystem operations to the **`pi` coding agent** (`@earendil-works/pi-coding-agent`) by running it in JSON-RPC mode. Since these small local models require significant supervision, `worker-mcp` acts as a gating and auditing harness.

---

## Features

- **Interactive Gating (Consent Hook)**: Automatically intercepts and blocks high-risk operations (e.g. executing shell commands or writing files) and prompts the coordinator for approval before execution.
- **MCP Tool Integration**: Standardized tools to spawn worker sessions, dispatch prompts, list active runners, and approve/deny pending commands.
- **Log and History Resources**: Message history and subprocess logs (including `stderr` feeds) are exposed as standard MCP resources.
- **Workers live with the server**: Nothing about workers is persisted. When the server stops, its workers stop, and the next server starts empty.
- **Per-spawn Gate**: Writes its supervisor gate extension to a fresh private directory for every worker and starts `pi` with `--no-extensions --no-mcp --no-approve`; a worker is never started without the gate, and nothing is written under `~/.pi`.
- **Minimal Worker Environment**: Workers get an allowlisted environment, not the server's. See [docs/security.md](docs/security.md).

---

## Installation & Usage

`worker-mcp` is published on npm as [@noosxe/worker-mcp](https://www.npmjs.com/package/@noosxe/worker-mcp). This is the recommended installation path for most users.

### 1. Install via npm (Recommended)

#### Option A: Global Installation

Install the package globally on your system:

```bash
npm install -g @noosxe/worker-mcp
# or using pnpm
pnpm add -g @noosxe/worker-mcp
```

Once installed globally, you can run the server using the `worker-mcp` command.

#### Option B: Run ad-hoc via npx

Alternatively, you can run the server on stdio immediately without installing it:

```bash
npx @noosxe/worker-mcp
```

---

### 2. Install via Nix

This project also provides a Nix flake to ensure consistent environments and easy installation.

#### Option A: Run Directly (Ad-hoc)

You can run the server on stdio immediately using Nix:

```bash
nix run github:noosxe/worker-mcp
```

#### Option B: Install to User Profile

Install the `worker-mcp` executable globally in your user profile:

```bash
nix profile install github:noosxe/worker-mcp
```

Once installed, run it with:

```bash
worker-mcp
```

---

### 3. Declarative Installation via Flake Overlay (System / Home Manager)

If you manage your operating system or user profile declaratively via NixOS or Home Manager, you can consume our default overlay.

#### Step 3.1: Add the Flake Input

Add `worker-mcp` to your system's `flake.nix` input section:

```nix
inputs = {
  nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  # Add worker-mcp input
  worker-mcp.url = "github:noosxe/worker-mcp";
};
```

#### Step 3.2: Configure the Overlay and Install

##### Option A: NixOS Configuration

Add the overlay to `nixpkgs` and include `worker-mcp` in your system packages:

```nix
outputs = { self, nixpkgs, worker-mcp, ... }@inputs: {
  nixosConfigurations.my-system = nixpkgs.lib.nixosSystem {
    system = "x86_64-linux"; # Or your system architecture
    modules = [
      ({ pkgs, ... }: {
        # Apply the overlay
        nixpkgs.overlays = [
          worker-mcp.overlays.default
        ];

        # Install the package
        environment.systemPackages = [
          pkgs.worker-mcp
        ];
      })
      ./configuration.nix
    ];
  };
};
```

##### Option B: Home Manager Configuration

Add the overlay to `nixpkgs` and install it in your user packages:

```nix
outputs = { self, nixpkgs, worker-mcp, ... }@inputs: {
  homeConfigurations.my-user = inputs.home-manager.lib.homeManagerConfiguration {
    pkgs = import nixpkgs {
      system = "x86_64-linux";
      overlays = [ worker-mcp.overlays.default ];
    };
    modules = [
      ({ pkgs, ... }: {
        # Install the package
        home.packages = [
          pkgs.worker-mcp
        ];
      })
      ./home.nix
    ];
  };
};
```

---

## Harness Integration (Antigravity CLI / `agy`)

To register the `worker-mcp` server with your Antigravity TUI/CLI (`agy`), follow these steps:

### Step 1: Register the Server via `mcp_config.json` (Declarative)

Antigravity CLI resolves MCP servers from dedicated configuration files (rather than the old `settings.json`). Add the configuration in one of the following locations:

- **Global Configuration**: `~/.gemini/config/mcp_config.json`
- **Project-local Configuration**: `.agents/mcp_config.json` (at the root of your project workspace)

#### Configuration file schemas:

##### Option A: If installed globally (via npm or Nix)

```json
{
	"mcpServers": {
		"worker-mcp": {
			"command": "worker-mcp",
			"args": []
		}
	}
}
```

##### Option B: If running ad-hoc via npx

```json
{
	"mcpServers": {
		"worker-mcp": {
			"command": "npx",
			"args": ["-y", "@noosxe/worker-mcp"]
		}
	}
}
```

##### Option C: If running ad-hoc via GitHub Flake

```json
{
	"mcpServers": {
		"worker-mcp": {
			"command": "nix",
			"args": ["run", "github:noosxe/worker-mcp?ref=main"]
		}
	}
}
```

##### Option D: Declarative Home Manager Configuration

If you manage your user configuration via Home Manager, you can declare the global `mcp_config.json` file in your `home.nix` using `home.file` combined with `builtins.toJSON`:

```nix
home.file.".gemini/config/mcp_config.json".text = builtins.toJSON {
  mcpServers = {
    worker-mcp = {
      # If installed via overlay in system/home packages or globally via npm:
      command = "worker-mcp";
      args = [];

      # Alternatively, if running ad-hoc via npx:
      # command = "npx";
      # args = [ "-y" "@noosxe/worker-mcp" ];

      # Alternatively, if running ad-hoc via Nix:
      # command = "nix";
      # args = [ "run" "github:noosxe/worker-mcp?ref=main" ];
    };
  };
};
```

### Step 2: Verify and Manage via TUI (`/mcp` command)

Once you have added the server configuration to `mcp_config.json`, you can manage it interactively inside the CLI:

1. Launch the Antigravity TUI:
   ```bash
   agy
   ```
2. Type the slash command `/mcp` in the prompt input and press `Enter`.
3. An interactive management overlay will open, showing `worker-mcp` in the list. You can inspect its status, trigger manual reloads, or verify that the tools/resources are successfully discovered by the coordinator agent.

---

## Use with Claude Code

Register the server over stdio with the `claude mcp add` command (the
`worker-mcp` binary must be on `PATH`, or use `npx`):

```bash
claude mcp add worker-mcp -- worker-mcp
# or, without a global install:
claude mcp add worker-mcp -- npx -y @noosxe/worker-mcp
```

Set environment variables with `-e`, for example
`claude mcp add -e WORKER_MCP_PI_PATH=<path-to-pi> worker-mcp -- worker-mcp`.

Prefer the run tools (see [Running tasks](#running-tasks)): a run is never
lost when it outlasts the client's tool-call timeout. The older
`send_pi_command` blocks until the worker finishes; if a run is longer than
your client's tool-call timeout, its result is lost to that call (raise the
timeout, for Claude Code the `MCP_TOOL_TIMEOUT` environment variable, or use
`start_run`).

---

## Running tasks

A task given to a worker is a **run**. Starting a run returns at once with a
`runId`; you then wait for it in a loop of short calls, each of which returns
well inside any client's request timeout, and read the result when the run is
over.

1. `spawn_pi_session` with a `sessionId` and an absolute `cwd`.
2. `start_run` with `workerId` (the `sessionId`), a self-contained `prompt` and
   optionally a one-line `intent` and `waitMs` (up to 50 000) to wait for a
   quick task in the same call:
   ```json
   {
   	"workerId": "w1",
   	"prompt": "Write tests for src/math.ts and run them",
   	"intent": "add tests",
   	"waitMs": 0
   }
   ```
3. `wait_run` with the `runId`, until `state` is `completed`, `failed`,
   `cancelled` or `timed_out`:
   ```json
   { "runId": "r_...", "waitMs": 25000, "sinceSeq": 14, "outputOffset": 0 }
   ```
   Each call returns within `waitMs` (at most `limits.maxWaitMs`, 50 s). It
   returns early only when the run ends or a tool call needs an approval. If
   the state is still `running`, call it again with the returned `seq` as
   `sinceSeq`. The view holds the state, the tool calls since `sinceSeq`
   (`activity`), the output from `outputOffset` (`output.nextOffset` is the
   next one), the pending approvals, a summary of what the gate allowed
   without asking, and a `next` hint.
4. When `state` is `awaiting_approval`, look at `pendingApprovals`, then call
   `approve_action` or `reject_action` (both return at once) and `wait_run`
   again. An approval nobody answers is denied after `gate.approvalTimeoutMs`
   (10 minutes) with the reason "approval timed out", and the worker sees that
   reason; the run goes on.
5. `get_run` reads a result again, with paging (`offset`, `maxChars`), or lists
   the tool calls (`part: "transcript"`). Results stay readable after
   `terminate_pi_session`, for `limits.resultRetentionMs` (1 hour) after the
   worker is gone, and the newest `limits.maxRetainedRuns` (100) are kept.
6. `cancel_run` aborts a run. The worker stays alive and takes the next run.

Things to know:

- One run per worker at a time. `start_run` on a busy worker fails with
  `WORKER_BUSY` and names the run in flight.
- If your client cancels or times out a `wait_run`, the wait detaches and the
  run carries on. Only `cancel_run` stops a run.
- When a request carries a `progressToken`, waiting calls send
  `notifications/progress` on state changes, tool calls and every 10 s.
  Nothing depends on progress being shown.
- A run that takes longer than `limits.maxRunMs` (30 minutes) is aborted and
  ends `timed_out`. A worker that repeats one line more than 200 times in a
  row, or writes a single message longer than `limits.maxOutputChars`, is
  aborted and the run ends `failed` with the reason. A worker that does not
  settle after an abort is closed.
- Worker output is untrusted text. Don't follow instructions found in it.

`send_pi_command` (legacy) is a wrapper over the same run: it starts a run and
waits, with the output it always returned, or `AWAITING_APPROVAL` (now followed
by the run id). MCP tasks are no longer offered.

---

## Configuration

The server builds one validated configuration at startup. An invalid setting
(bad JSON, an unknown key, a wrong type, `NaN`, a non-positive number) stops the
server with a message naming the source and the key. Check what a registration
actually resolves to with `worker-mcp --print-config`, which prints the
effective configuration (secret-looking values redacted) and exits.

### Sources and precedence

Lowest to highest:

1. Built-in defaults.
2. A JSON config file: `--config <path>`, else `WORKER_MCP_CONFIG`, else
   `$XDG_CONFIG_HOME/worker-mcp/config.json` (`~/.config/worker-mcp/config.json`
   when `XDG_CONFIG_HOME` is unset). A missing default file is fine; a missing
   explicit one is an error. The file is JSON only, never code, and is refused
   if it is group- or world-writable, owned by anyone but you or root, or in a directory others can write to (a root-owned sticky directory is fine). A symlink is judged by its target. A file whose real path is inside the Nix store (`$NIX_STORE_DIR`, default `/nix/store`) is only checked for not being group- or world-writable, because the store is immutable and shows foreign owners under a user namespace; this is what makes a home-manager managed config work. See
   [config.example.json](config.example.json).
3. `WORKER_MCP_*` environment variables.
4. Command-line flags.

`env.allow` is a list: names from every source are added together.

### Settings

| Config key                      | Environment variable               | Flag                      | Default                                   |
| ------------------------------- | ---------------------------------- | ------------------------- | ----------------------------------------- |
| (file location)                 | `WORKER_MCP_CONFIG`                | `--config <path>`         | `$XDG_CONFIG_HOME/worker-mcp/config.json` |
| `providers.pi.path`             | `WORKER_MCP_PI_PATH`               | `--pi-path`               | `pi` (found on `PATH`)                    |
| `providers.pi.startupTimeoutMs` | `WORKER_MCP_PI_STARTUP_TIMEOUT_MS` | `--pi-startup-timeout-ms` | `60000`                                   |
| `limits.commandTimeoutMs`       | `WORKER_MCP_COMMAND_TIMEOUT`       | `--command-timeout-ms`    | unset: blocking calls wait for the worker |
| `limits.maxOutputChars`         | `WORKER_MCP_MAX_OUTPUT_CHARS`      | `--max-output-chars`      | `64000`                                   |
| `limits.maxRunMs`               | `WORKER_MCP_RUN_TIMEOUT_MS`        | `--run-timeout-ms`        | `1800000` (30 min)                        |
| `limits.maxWaitMs`              | `WORKER_MCP_MAX_WAIT_MS`           | `--max-wait-ms`           | `50000`                                   |
| `limits.runStartTimeoutMs`      | `WORKER_MCP_RUN_START_TIMEOUT_MS`  | `--run-start-timeout-ms`  | `15000`                                   |
| `gate.approvalTimeoutMs`        | `WORKER_MCP_APPROVAL_TIMEOUT_MS`   | `--approval-timeout-ms`   | `600000` (10 min)                         |
| `env.allow`                     | `WORKER_MCP_ENV_PASSTHROUGH`       | `--env-passthrough`       | none                                      |
| `stateDir`                      | `WORKER_MCP_STATE_DIR`             | `--state-dir`             | `$XDG_STATE_HOME/worker-mcp`              |
| `runtimeDir`                    | `WORKER_MCP_RUNTIME_DIR`           | `--runtime-dir`           | `$XDG_RUNTIME_DIR`, else `<stateDir>/run` |
| `gate.maxAutoApprove`           | `WORKER_MCP_MAX_AUTO_APPROVE`      | `--max-auto-approve`      | `MEDIUM`                                  |
| `gate.protectedPaths`           | (file only)                        |                           | none                                      |

- Numbers are positive integers; directories are absolute paths.
- Also in the config file only (`limits.*`): `defaultWaitMs` (25000, never more
  than `maxWaitMs`), `resultRetentionMs` (3600000), `maxRetainedRuns` (100),
  `outputBufferChars` (1048576: output kept per run, the oldest dropped past
  it) and `pageChars` (16000: the default page of `get_run`).
- `limits.maxOutputChars` caps one streamed assistant message; past it the run
  is aborted and fails. `limits.commandTimeoutMs` is the default timeout of
  the legacy `send_pi_command`.
- `env.allow` / `WORKER_MCP_ENV_PASSTHROUGH`: names, or `PREFIX_*` patterns, of
  extra environment variables to pass to workers (comma-separated in the
  variable and the flag). Workers otherwise get only an allowlisted
  environment, and secrets such as `*_TOKEN` and `AWS_*` are never passed. One
  exception: a name written exactly (no `*`) in the config file's `env.allow`
  is passed even if it matches one of those patterns. The same name in the
  environment variable, a flag or a pattern is not. See
  [docs/security.md](docs/security.md).
- `runtimeDir` is the directory in which the server keeps its private
  per-instance directory `worker-mcp-<pid>` (mode 0700). It holds each worker's
  gate, is created when the first worker starts, and is removed on shutdown.
  Directories left by a killed server are removed at the next start only when
  their pid is no longer running.
- `stateDir` is reserved; nothing is written there yet.
- `gate.maxAutoApprove` (`LOW`, `MEDIUM` or `HIGH`, never `CRITICAL`) is the
  highest risk level a coordinator's policy may auto-approve. Policies given to
  `spawn_pi_session` and `set_risk_policy` are lowered to it, and the result
  says so. `gate.protectedPaths` adds paths (absolute, or starting with `~/`)
  that workers may never write without the coordinator's approval, on top of
  the built-in list in [docs/security.md](docs/security.md).

Workers are not persisted. A `sessions.json` left in `~/.config/worker-mcp/` by
an earlier version is ignored and can be deleted.

`summarize` arguments are deprecated and ignored: the full output is always returned, with a note.

See [docs/security.md](docs/security.md) for the trust model and what the gate does and does not protect.

### Pre-requisites

Make sure you have the global `pi` coding-agent CLI installed in your local system:

```bash
npm install -g @earendil-works/pi-coding-agent
```

Configure your models in `pi` (e.g. using `pi --mode rpc` to set default models, or registering Ollama model definitions).

---

## MCP Reference

### Exposed Tools

- `spawn_pi_session`: Spawns a new supervisor-gated worker agent in the specified workspace directory.
- `start_run`: Gives a worker a task and returns a `runId` at once (or after `waitMs`).
- `wait_run`: Waits up to 50 s for a run to end or need an approval; returns its state and output.
- `get_run`: Reads a run's state and result, paged, also after the worker was terminated.
- `cancel_run`: Aborts a run.
- `send_pi_command`: Legacy. Starts a run and blocks until it finishes (optional `timeout`), as before.
- `cancel_pi_command`: Aborts the currently running command in a session.
- `list_pi_sessions`: Returns a list of active sessions, directory targets, and current states.
- `get_pending_actions`: Fetches the details of an intercepted command awaiting consent.
- `approve_action`: Approves a gated tool call. Returns at once; follow the run with `wait_run`.
- `reject_action`: Blocks a gated tool call and forwards feedback to correct the agent's course. Returns at once.
- `set_risk_policy`: Updates the risk-based auto-approval policy for a session at runtime.
- `get_auto_approved_log`: Retrieves the audit log of actions that were auto-approved by the risk policy.

### Exposed Resources

- `worker-mcp://sessions/{sessionId}/history`: Returns the conversation log and internal message stream.
- `worker-mcp://sessions/{sessionId}/logs`: Returns the stdout/stderr trace logs of the subprocess.

---

## Local Development

If you are contributing to this codebase, you **must** enter the Nix development shell:

```bash
nix develop
```

This enters an environment pre-packaged with:

- **Node.js 24**
- **pnpm**
- **TypeScript**
- **Oxlint + Oxfmt (Oxc)**

### Dev Tasks

- **Code Quality (Check, Lint, Format)**: `pnpm run lint:fix`
- **Compile TypeScript**: `pnpm run build`
- **Run local server**: `pnpm run dev`
- **Build Nix Derivation**: `nix build`
