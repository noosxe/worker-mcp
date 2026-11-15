# worker-mcp

`worker-mcp` is a Model Context Protocol (MCP) server that lets a coordinating agent (Claude Code, the Claude desktop app or any MCP client) spawn, supervise and guide third-party coding agents, called **workers**, running on your machine.

The server is a runner, not an agent: it starts a worker in a workspace, gives it tasks as **runs**, and gates every tool call the worker makes with a risk policy. The coordinator approves or rejects what the policy does not allow. The tool surface is provider-neutral; **pi** (`@earendil-works/pi-coding-agent`, run in JSON-RPC mode) is the provider today, and more can be added behind the same tools (see [docs/providers.md](docs/providers.md)).

---

## Features

- **Neutral tool surface**: 13 tools (`list_providers`, `spawn_worker`, `start_run`, `wait_run`, `get_run`, `cancel_run`, `get_pending_actions`, `approve_action`, `reject_action`, `list_workers`, `set_risk_policy`, `get_gate_log`, `terminate_worker`). Every result has `structuredContent` that matches the tool's `outputSchema`, plus one text block.
- **Asynchronous runs**: starting a run returns at once; the coordinator waits in short calls, so a long task never loses its result to a client timeout.
- **Approval gate**: every tool call is classified by risk. Low-risk calls run; the rest wait for the coordinator, and protected paths always do. See [docs/security.md](docs/security.md).
- **Untrusted output is labelled**: what a worker wrote is wrapped in `<worker_output>` tags in text and sits under `untrusted…` keys in structured results.
- **Workers live with the server**: nothing is persisted. When the server stops, its workers stop.
- **Minimal worker environment**: workers get an allowlisted environment, not the server's.
- **Server instructions**: on connect, the server tells the coordinator the flow (spawn, run, wait, approve) and the rule that worker output is data.

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

##### Option C: The Home Manager module

The flake also exports a Home Manager module, `homeManagerModules.default`
(also `homeManagerModules.worker-mcp`). It installs the package and writes
`~/.config/worker-mcp/config.json`, and **checks the generated config at build
time** by running the package with `--print-config`, so invalid settings fail
the build instead of the first start. It needs no overlay.

```nix
{ config, inputs, ... }:
{
  imports = [ inputs.worker-mcp.homeManagerModules.default ];

  programs.worker-mcp = {
    enable = true;

    # Typed options for the common keys...
    gate.mode = "auto";
    gate.maxAutoApprove = "MEDIUM";
    classifiers = [
      {
        name = "local";
        url = "http://127.0.0.1:8787/classify";
        # A path, never the token: a sops-nix secret owned by this user.
        tokenFile = config.sops.secrets.classifier_key.path;
      }
      # Or TypeSafe's hosted jev model (see Auto mode below):
      # {
      #   name = "jev";
      #   dialect = "jev";
      #   backend = "typesafe";
      #   tokenFile = config.sops.secrets.jev_key.path;
      # }
    ];

    # ...and `settings` for any key of the config file (it wins over the
    # typed options).
    settings = {
      gate.onClassifierFailure = "deny";
    };

    # Typed options for the pi provider and the limits (config file keys).
    piPath = lib.getExe pkgs.pi;
    defaultModel = "zai/glm-5.3";
    allowedRoots = [ "/home/user/src" ];
    legacyTools = false;

    # Secrets the worker agent needs, read from files when the server starts.
    # The names are also added to `env.allow`, so workers get them.
    envFiles.ZAI_API_KEY = config.sops.secrets.zai_api_key.path;
    # Plain values (these end up in the Nix store: no secrets).
    env.WORKER_MCP_MAX_WORKERS = 2;

    # Link the Claude Code plugin (skill and MCP server) into ~/.claude.
    claude.enable = true;
  };

  sops.secrets.classifier_key = { };
  sops.secrets.zai_api_key = { };
}
```

| Option                                                  | Meaning                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `piPath`, `defaultModel`, `allowedRoots`, `legacyTools` | `providers.pi.path`, `providers.pi.defaultModel`, `limits.allowedRoots`, `legacyTools` in the generated, build-checked config file (`settings` wins)                                                                                                                                                                                                                                                      |
| `envPassthrough`                                        | `env.allow`: extra environment names workers receive                                                                                                                                                                                                                                                                                                                                                      |
| `env`                                                   | Plain environment variables for the server, set by the launcher                                                                                                                                                                                                                                                                                                                                           |
| `envFiles`                                              | Environment name → absolute file outside the store, read at start-up by the launcher (one trailing newline stripped). The names are added to `env.allow` automatically                                                                                                                                                                                                                                    |
| `claude.enable`                                         | Link the plugin as **one** `home.file` symlink to the plugin folder at `<configDir>/skills/<claude.name>`. `<configDir>` is `programs.claude-code.configDir` when that module is imported, else `~/.claude`; `programs.claude-code` need not be enabled. `programs.claude-code.plugins` is not used: it links entries one by one, and Claude Code rejects such a plugin ("Path escapes plugin directory") |
| `claude.name`                                           | Name of the link (default `worker-mcp`)                                                                                                                                                                                                                                                                                                                                                                   |
| `claude.command`                                        | Absolute path of a wrapper of your own to run as the server, in place of the generated launcher                                                                                                                                                                                                                                                                                                           |

The generated launcher (`programs.worker-mcp.launcher`) exports `env`, reads
each `envFiles` entry into its variable and runs `worker-mcp`. It prints
nothing before that, since stdout is the MCP channel; a file that cannot be
read stops it with a message on stderr that names the variable, never a value.
Use it for any harness, not only Claude Code.

`settings` mirrors the whole config schema (see [Settings](#settings)).
Secrets are file paths only; the module refuses a path in the Nix store, which
is world-readable. A sops-nix secret works as `tokenFile` because it is a
symlink to a mode 0400 file owned by you; give the secret the right `owner` if
sops-nix runs as another user. pi is not in the package's closure; to use a Nix-built pi,
set `settings.providers.pi.path = "${pkgs.some-pi}/bin/pi"` or export
`WORKER_MCP_PI_PATH`.

##### Option D: Build the Claude Code plugin yourself

`lib.mkClaudePlugin { pkgs, command ? …, env ? { } }` returns the plugin folder
(`.claude-plugin/plugin.json`, a `.mcp.json` whose `command` is absolute, and
the skill) as a directory of real files. `command` defaults to this flake's
`worker-mcp`; pass your own launcher to set up the environment, and `env` for
plain variables. Link the whole folder, for example to `~/.claude/skills/worker-mcp`.

```nix
home.file.".claude/skills/worker-mcp".source = inputs.worker-mcp.lib.mkClaudePlugin {
  inherit pkgs;
  command = "${myLauncher}/bin/my-launcher";
};
```

`programs.worker-mcp.claude.enable` does this for you.

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

## Use from Claude Code and the Claude desktop app

### Claude Code

Register the server for every project (user scope):

```bash
claude mcp add --scope user worker-mcp -- worker-mcp
```

With settings:

```bash
claude mcp add --scope user -e WORKER_MCP_ALLOWED_ROOTS=$HOME/Projects -e WORKER_MCP_MAX_WORKERS=2 worker-mcp -- worker-mcp
```

`--scope project` writes a `.mcp.json` into the repository instead. That file is a protected path: a worker cannot change it without your approval.

Check it: run `claude mcp list`, then ask Claude to call `list_providers`.

### Claude desktop app

Add the server to `claude_desktop_config.json` (on macOS under `~/Library/Application Support/Claude/`, on Linux under `~/.config/Claude/`):

```json
{
	"mcpServers": {
		"worker-mcp": {
			"command": "/absolute/path/to/worker-mcp",
			"env": {
				"WORKER_MCP_PI_PATH": "/absolute/path/to/pi",
				"WORKER_MCP_ALLOWED_ROOTS": "/absolute/path/to/projects"
			}
		}
	}
}
```

Restart the app, then ask Claude to call `list_providers`.

### The Claude Code plugin

The repository is also a Claude Code plugin: the server, the skill that teaches
the coordinator the delegation flow (`skills/worker-mcp/SKILL.md`) and its
settings in one install. Claude Code loads plugins in both the terminal and the
desktop app. Without Nix, install `worker-mcp` and `pi` first (see above), then:

```
/plugin marketplace add noosxe/worker-mcp
/plugin install worker-mcp@worker-mcp
```

Claude Code asks for three values when the plugin is enabled and passes them to
the server (`/config` shows them again):

| Option          | Server setting                                        |
| --------------- | ----------------------------------------------------- |
| `allowed_roots` | `WORKER_MCP_ALLOWED_ROOTS`, comma-separated, required |
| `pi_path`       | `WORKER_MCP_PI_PATH`, default `pi`                    |
| `default_model` | `WORKER_MCP_PI_DEFAULT_MODEL`, e.g. `zai/glm-5.3`     |

The plugin runs the command `worker-mcp`, so it must be on the `PATH` of the
app (the desktop app does not inherit your shell's; see the pitfalls below), and
the tools appear as `mcp__plugin_worker-mcp_worker-mcp__*`. Other settings come
from the [config file](#settings). A model provider's API key is not a plugin
option: put it in the environment the app starts with, and name it in
`env.allow` / `WORKER_MCP_ENV_PASSTHROUGH` so that pi gets it.

The plugin files are not part of the npm package: the plugin is installed from
the repository (the marketplace entry is the repository root, so it follows the
revision you installed) or built by Nix, and a copy inside the package would
only be a second one to keep in step. The Nix package leaves them out for the
same reason; `lib.mkClaudePlugin` builds the folder from the same files.

### Pitfalls

- The desktop app does not inherit your shell's `PATH`. Use absolute paths for `worker-mcp` and `pi`; `worker-mcp --print-config` shows what the server resolved.
- `nix run github:noosxe/worker-mcp` builds on first launch and can exceed the client's startup timeout (`MCP_TIMEOUT` in Claude Code). Build once with `nix profile install` or `nix build` and point the registration at the result.
- Never register `nix develop --command …`: a banner on stdout breaks the stdio protocol. (The dev shell prints its banner to stderr, but a plain binary path is safer.)
- pi may need network access at startup if it is installed through an `npx` wrapper.
- A run that outlasts the client's tool timeout is fine: use `start_run` and `wait_run` (each call returns within 50 s). The deprecated `send_pi_command` also stops waiting after at most 50 s.
- `WORKER_MCP_LEGACY_TOOLS=0` hides the six deprecated pi-named tools, so the coordinator reads 13 tool definitions instead of 19.

---

## Running tasks

A task given to a worker is a **run**. Starting a run returns at once with a
`runId`; you then wait for it in a loop of short calls, each of which returns
well inside any client's request timeout, and read the result when the run is
over.

1. `list_providers` shows what can run; `spawn_worker` takes an absolute `cwd`
   and optionally a `name`, `provider`, `model` and `policy`.
2. `start_run` with `workerId` (its id or name), a self-contained `prompt` and
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
   (`untrustedActivity`), the output from `outputOffset` (`output.nextOffset` is the
   next one), the pending approvals, a summary of what the gate allowed
   without asking, and a `next` hint.
4. When `state` is `awaiting_approval`, look at `pendingApprovals`, then call
   `approve_action` or `reject_action` (both return at once, with the approval's `approvalId`) and `wait_run`
   again. An approval nobody answers is denied after `gate.approvalTimeoutMs`
   (10 minutes) with the reason "approval timed out", and the worker sees that
   reason; the run goes on.
5. `get_run` reads a result again, with paging (`offset`, `maxChars`), or lists
   the tool calls (`part: "transcript"`). Results stay readable after
   `terminate_worker`, for `limits.resultRetentionMs` (1 hour) after the
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

`send_pi_command` (deprecated) is a wrapper over the same run: it starts a run
and waits at most `min(timeout, limits.maxWaitMs)`, returning the output, or
`AWAITING_APPROVAL`, or `RUNNING` with the run id when the wait ran out. MCP
tasks are no longer offered.

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

| Config key                         | Environment variable               | Flag                      | Default                                      |
| ---------------------------------- | ---------------------------------- | ------------------------- | -------------------------------------------- |
| (file location)                    | `WORKER_MCP_CONFIG`                | `--config <path>`         | `$XDG_CONFIG_HOME/worker-mcp/config.json`    |
| `providers.pi.path`                | `WORKER_MCP_PI_PATH`               | `--pi-path`               | `pi` (found on `PATH`)                       |
| `providers.pi.defaultModel`        | `WORKER_MCP_PI_DEFAULT_MODEL`      | `--pi-default-model`      | none (pi's own default)                      |
| `providers.pi.startupTimeoutMs`    | `WORKER_MCP_PI_STARTUP_TIMEOUT_MS` | `--pi-startup-timeout-ms` | `60000`                                      |
| `legacyTools`                      | `WORKER_MCP_LEGACY_TOOLS`          |                           | `true` (`0` hides the deprecated tools)      |
| `limits.commandTimeoutMs`          | `WORKER_MCP_COMMAND_TIMEOUT`       | `--command-timeout-ms`    | unset: the deprecated send waits `maxWaitMs` |
| `limits.maxOutputChars`            | `WORKER_MCP_MAX_OUTPUT_CHARS`      | `--max-output-chars`      | `64000`                                      |
| `limits.maxRunMs`                  | `WORKER_MCP_RUN_TIMEOUT_MS`        | `--run-timeout-ms`        | `1800000` (30 min)                           |
| `limits.maxWaitMs`                 | `WORKER_MCP_MAX_WAIT_MS`           | `--max-wait-ms`           | `50000`                                      |
| `limits.runStartTimeoutMs`         | `WORKER_MCP_RUN_START_TIMEOUT_MS`  | `--run-start-timeout-ms`  | `15000`                                      |
| `limits.maxWorkers`                | `WORKER_MCP_MAX_WORKERS`           | `--max-workers`           | `4`                                          |
| `limits.idleTimeoutMs`             | `WORKER_MCP_IDLE_TIMEOUT_MS`       | `--idle-timeout-ms`       | `1800000` (30 min)                           |
| `limits.allowedRoots`              | `WORKER_MCP_ALLOWED_ROOTS`         | `--allowed-roots`         | none: any directory                          |
| `gate.approvalTimeoutMs`           | `WORKER_MCP_APPROVAL_TIMEOUT_MS`   | `--approval-timeout-ms`   | `600000` (10 min)                            |
| `env.allow`                        | `WORKER_MCP_ENV_PASSTHROUGH`       | `--env-passthrough`       | none                                         |
| `stateDir`                         | `WORKER_MCP_STATE_DIR`             | `--state-dir`             | `$XDG_STATE_HOME/worker-mcp`                 |
| `runtimeDir`                       | `WORKER_MCP_RUNTIME_DIR`           | `--runtime-dir`           | `$XDG_RUNTIME_DIR`, else `<stateDir>/run`    |
| `gate.maxAutoApprove`              | `WORKER_MCP_MAX_AUTO_APPROVE`      | `--max-auto-approve`      | `MEDIUM`                                     |
| `gate.protectedPaths`              | (file only)                        |                           | none                                         |
| `gate.mode`                        | `WORKER_MCP_GATE_MODE`             | `--gate-mode`             | `manual` (`auto` needs a classifier)         |
| `gate.httpAllowCeiling`            | `WORKER_MCP_HTTP_ALLOW_CEILING`    | `--http-allow-ceiling`    | `HIGH`                                       |
| `gate.onClassifierFailure`         | `WORKER_MCP_ON_CLASSIFIER_FAILURE` | `--on-classifier-failure` | `escalate` (or `deny`; never allow)          |
| `gate.classifiers`                 | (file only)                        |                           | none                                         |
| `gate.cache`, `gate.recentActions` | (file only)                        |                           | 1000 entries, 10 min; 10 actions             |
| `audit.enabled`                    | `WORKER_MCP_AUDIT`                 | `--audit`                 | `true`                                       |
| `audit.file`                       | `WORKER_MCP_AUDIT_FILE`            | `--audit-file`            | `<stateDir>/audit.jsonl`                     |

- Numbers are positive integers; directories are absolute paths.
- Also in the config file only (`limits.*`): `defaultWaitMs` (25000, never more
  than `maxWaitMs`), `resultRetentionMs` (3600000), `maxRetainedRuns` (100),
  `outputBufferChars` (1048576: output kept per run, the oldest dropped past
  it) and `pageChars` (16000: the default page of `get_run`).
- `limits.maxOutputChars` caps one streamed assistant message; past it the run
  is aborted and fails. `limits.commandTimeoutMs` is the default wait of
  the deprecated `send_pi_command` (never more than `limits.maxWaitMs`).
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
- `stateDir` holds the audit log (see [Auto mode](#auto-mode-and-the-audit-log)); it is a protected path.
- `gate.maxAutoApprove` (`LOW`, `MEDIUM` or `HIGH`, never `CRITICAL`) is the
  highest risk level a coordinator's policy may auto-approve. Policies given to
  `spawn_worker` and `set_risk_policy` are lowered to it, and the result
  says so. `gate.protectedPaths` adds paths (absolute, or starting with `~/`)
  that workers may never write without the coordinator's approval, on top of
  the built-in list in [docs/security.md](docs/security.md).

Workers are not persisted. A `sessions.json` left in `~/.config/worker-mcp/` by
an earlier version is ignored and can be deleted.

`summarize` arguments are deprecated and ignored: the full output is always returned, with a note.

See [docs/security.md](docs/security.md) for the trust model and what the gate does and does not protect.

### Auto mode and the audit log

By default (`gate.mode: manual`) a call the rules rate above the worker's policy
waits for the coordinator. In `auto` mode those calls go to an external HTTP
classifier first. It allows or denies on its own when it is confident, and
only uncertain calls, or ones it cannot answer, reach the coordinator.

```json
{
	"gate": {
		"mode": "auto",
		"classifiers": [
			{
				"name": "local",
				"url": "http://127.0.0.1:8787/classify",
				"tokenFile": "/run/secrets/classifier_key"
			}
		]
	}
}
```

- The rules still decide first. LOW calls run; hard limits (protected paths)
  and CRITICAL calls always go to the coordinator and are never sent to the
  classifier. A classifier's `allow` needs confidence of 0.85 and a risk level
  up to `gate.httpAllowCeiling` (default `HIGH`, separate from
  `gate.maxAutoApprove`, which only bounds the coordinator's own policy); a
  `deny` needs 0.6. If it fails (timeout, bad answer, breaker open), the call
  goes to the coordinator, or is denied with `gate.onClassifierFailure: deny`.
- `dialect: "jev"` uses TypeSafe's hosted System One model ("jev") as the
  classifier: worker-mcp asks it four typed questions (`risk`, `approval`,
  `user_requested`, `from_untrusted`) and maps the answers to allow, deny or
  escalate. `backend` is `typesafe` (default), `openrouter` or `custom` (with
  `url`); `thresholds` tune the mapping, `cacheTtlMs` optionally caches
  answers. The probabilities decide the verdict through their thresholds; the
  confidence of an allow is the lowest confidence jev itself reports (the
  `risk` answer's, and a noul answer's own when sent). An allow whose
  probabilities or score lie within `thresholds.thresholdMargin` (default
  0.05) of a threshold escalates instead. **Commands and up to 8 KiB of arguments are sent to the backend**,
  so it is off unless you configure it. Details in
  [docs/classifier-api.md](docs/classifier-api.md#dialect-jev-typesafe-system-one).

  ```json
  {
  	"name": "jev",
  	"dialect": "jev",
  	"backend": "typesafe",
  	"tokenFile": "/run/secrets/jev_key"
  }
  ```

- A coordinator can switch classifiers off for one worker with
  `policy.classifiers: "off"` in `spawn_worker` or `set_risk_policy`.
- `auto` with no classifier is a configuration error. Commands, paths and up to
  8 KiB of arguments are sent to the classifier: use a local or self-hosted
  service. The protocol is in [docs/classifier-api.md](docs/classifier-api.md)
  and is **provisional**.
- The token is only ever a file path (`tokenFile`: mode 0600 or stricter, owned
  by you; a symlink such as a sops-nix secret is judged by its target). It is
  read at startup and again on `SIGHUP`, and is never in the environment, the
  tool arguments, the logs or `--print-config`.
- `get_gate_log` shows who decided each call (`decidedBy`: `rules`,
  `http:<name>`, `cache`, `coordinator`, `timeout`, `cancel`; filter with
  `decidedBy`) and every classifier consulted. A call that reaches you says
  why (`escalatedBecause`) and what the classifiers answered.
- Every decision is appended to a JSONL audit file (`audit.file`, default
  `<stateDir>/audit.jsonl`, mode 0600, rotated at 10 MiB, three kept). It holds
  metadata only: a digest of the arguments, a short preview, the `providerCallId` and, for a call sent to the coordinator, its `approvalId`, never full
  arguments, file contents or tokens. If it cannot be written, decisions go on,
  the problem is logged once and `list_workers` reports `auditDegraded: true`.
  Set `audit.enabled: false` to turn it off.

### Pre-requisites

Make sure you have the global `pi` coding-agent CLI installed in your local system:

```bash
npm install -g @earendil-works/pi-coding-agent
```

Configure your models in `pi` (e.g. using `pi --mode rpc` to set default models, or registering Ollama model definitions).

---

## MCP Reference

The full reference (inputs, results, errors, aliases) is in [docs/mcp-api.md](docs/mcp-api.md).

### Tools

| Tool                  | What it does                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `list_providers`      | The providers the server can run and whether each is usable.                             |
| `spawn_worker`        | Starts a gated worker in an absolute `cwd`. Returns its id (`w_…`) and effective policy. |
| `start_run`           | Gives a worker a task; returns a `runId` at once (or after `waitMs`).                    |
| `wait_run`            | Waits up to 50 s for a run to end or need an approval; returns its state and output.     |
| `get_run`             | Reads a run's state and result, paged; also its tool-call transcript.                    |
| `cancel_run`          | Aborts a run; the worker stays alive.                                                    |
| `get_pending_actions` | The tool calls waiting for approval.                                                     |
| `approve_action`      | Allows one pending call. Returns at once.                                                |
| `reject_action`       | Blocks one pending call and tells the worker why. Returns at once.                       |
| `list_workers`        | The live workers with their current run and approvals.                                   |
| `set_risk_policy`     | Replaces a worker's auto-approval policy, lowered to the server's ceiling.               |
| `get_gate_log`        | Every decision of the approval gate for a worker.                                        |
| `terminate_worker`    | Stops a worker and frees its name and slot.                                              |

`approve_action` takes `remember: "worker"` to also allow identical calls from that worker without asking, until it is terminated or its policy changes. It is ignored for hard limits, protected paths and CRITICAL calls, and the result says whether it applied (`remembered`).

The deprecated 0.4 names stay for 0.5.x while `WORKER_MCP_LEGACY_TOOLS` is not `0`:
`spawn_pi_session` (`spawn_worker`), `send_pi_command` (`start_run` and `wait_run`),
`cancel_pi_command` (`cancel_run`), `terminate_pi_session` (`terminate_worker`),
`list_pi_sessions` (`list_workers`) and `get_auto_approved_log` (`get_gate_log`).
They are removed in 0.6.0.

### Resources

For people and debugging, not for the model. Content a worker wrote is wrapped as untrusted.

- `worker-mcp://workers/{workerId}/log`: the server's log of a live worker (at most 256 KiB).
- `worker-mcp://runs/{runId}/transcript`: a run's tool calls and output as Markdown (at most 1 MiB).
- `worker-mcp://gate/{workerId}`: the gate log of a live worker, as JSON.

The server sends `notifications/resources/list_changed` when a worker starts or closes. The 0.4 URIs `worker-mcp://sessions/{id}/history` (now the latest run's transcript) and `.../logs` still work in 0.5.x.

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
