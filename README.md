# worker-mcp

`worker-mcp` is a Model Context Protocol (MCP) server that empowers a highly intelligent coordinator agent (like Claude 3.5 Sonnet or Gemini Pro) to spawn, control, and interactively guide lower-intelligence, locally hosted worker agents.

Instead of rolling a custom local LLM tool loop, `worker-mcp` delegates coding, bash, and filesystem operations to the **`pi` coding agent** (`@earendil-works/pi-coding-agent`) by running it in JSON-RPC mode. Since these small local models require significant supervision, `worker-mcp` acts as a gating and auditing harness.

---

## Features

- **Interactive Gating (Consent Hook)**: Automatically intercepts and blocks high-risk operations (e.g. executing shell commands or writing files) and prompts the coordinator for approval before execution.
- **MCP Tool Integration**: Standardized tools to spawn worker sessions, dispatch prompts, list active runners, and approve/deny pending commands.
- **Log and History Resources**: Message history and subprocess logs (including `stderr` feeds) are exposed as standard MCP resources.
- **Session Registry Persistence**: Session configurations and directory bindings survive server restarts via state files in `~/.config/worker-mcp/sessions.json`.
- **Automatic Extension Deployment**: Injects its supervisor gate extension directly into `~/.pi/agent/extensions/` on startup.

---

## Installation & Usage via Nix

This project provides a Nix flake to ensure consistent environments and easy installation.

### 1. Run Directly (Ad-hoc)
You can run the server on stdio immediately without installing it:
```bash
nix run github:noosxe/worker-mcp
```

### 2. Install to User Profile
Install the `worker-mcp` executable globally in your user profile:
```bash
nix profile install github:noosxe/worker-mcp
```
Once installed, run it with:
```bash
worker-mcp
```

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
* **Global Configuration**: `~/.gemini/config/mcp_config.json`
* **Project-local Configuration**: `.agents/mcp_config.json` (at the root of your project workspace)

#### Configuration file schemas:

##### Option A: If installed globally via Nix
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

##### Option B: If running ad-hoc via GitHub Flake
```json
{
  "mcpServers": {
    "worker-mcp": {
      "command": "nix",
      "args": [
        "run",
        "github:noosxe/worker-mcp?ref=main"
      ]
    }
  }
}
```

##### Option C: Declarative Home Manager Configuration
If you manage your user configuration via Home Manager, you can declare the global `mcp_config.json` file in your `home.nix` using `home.file` combined with `builtins.toJSON`:

```nix
home.file.".gemini/config/mcp_config.json".text = builtins.toJSON {
  mcpServers = {
    worker-mcp = {
      # If installed via overlay in system/home packages:
      command = "worker-mcp";
      args = [];

      # Alternatively, if running ad-hoc:
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

## Operational Configuration

### Environment Variables
- **`WORKER_MCP_PI_PATH`**: Absolute path to the `pi` coding-agent binary (defaults to searching `PATH` for `pi`).

### Pre-requisites
Make sure you have the global `pi` coding-agent CLI installed in your local system:
```bash
npm install -g @earendil-works/pi-coding-agent
```
Configure your models in `pi` (e.g. using `pi --mode rpc` to set default models, or registering Ollama model definitions).

---

## MCP Reference

### Exposed Tools
*   `spawn_pi_session`: Spawns a new supervisor-gated worker agent in the specified workspace directory.
*   `send_pi_command`: Dispatches prompts to the worker session (resolving when the turn settles).
*   `list_pi_sessions`: Returns a list of active sessions, directory targets, and current states.
*   `get_pending_actions`: Fetches the details of an intercepted command awaiting consent.
*   `approve_action`: Approves execution of a gated tool call.
*   `reject_action`: Blocks a gated tool call and forwards feedback to correct the agent's course.

### Exposed Resources
*   `worker-mcp://sessions/{sessionId}/history`: Returns the conversation log and internal message stream.
*   `worker-mcp://sessions/{sessionId}/logs`: Returns the stdout/stderr trace logs of the subprocess.

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
- **BiomeJS**

### Dev Tasks
- **Code Quality (Check, Lint, Format)**: `biome check --write src/`
- **Compile TypeScript**: `pnpm run build`
- **Run local server**: `pnpm run dev`
- **Build Nix Derivation**: `nix build`
