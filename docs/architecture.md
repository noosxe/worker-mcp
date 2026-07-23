# Architecture & API Design: worker-mcp

This document details the software architecture, process interactions, and MCP tool/resource schemas for `worker-mcp`.

---

## 1. Component Architecture

The system consists of three layers:

```mermaid
graph TD
    subgraph Host Environment
        C[MCP Client / Coordinator Agent] <-->|MCP JSON-RPC over stdio| S[worker-mcp Server]
        
        subgraph Session Manager
            S <-->|Spawn & Manage| P[PiSession Instance]
        end

        subgraph Worker Runtime
            P <-->|JSONL over Stdin/Stdout| CLI[pi coding-agent --mode rpc]
            CLI <-->|Execute Tools| WS[Isolated Workspace Directory]
            CLI <-->|API Calls| LLM[LLM Provider / Ollama / API]
        end
    end
    
    classDef main fill:#3b82f6,stroke:#1d4ed8,color:#fff;
    classDef secondary fill:#10b981,stroke:#047857,color:#fff;
    class C,S main;
    class P,CLI secondary;
```

### 1.1. Components
1. **MCP Client (Coordinator Agent)**: The orchestrator (e.g., Antigravity, Claude Desktop) that wants to delegate work but supervise the local execution.
2. **`worker-mcp` Server**: The MCP server that registers tools and resources, monitors child processes, and manages the interactive supervision loop.
3. **PiSession Instance**: A state wrapper in `worker-mcp` managing a single active worker session. It handles the stdin/stdout JSON Line parser, keeps track of command history, logs, and pending approval states.
4. **`pi` CLI Subprocess**: The globally/locally installed `@earendil-works/pi-coding-agent` executing in RPC mode (`pi --mode rpc`).
5. **LLM Provider**: The model runtime (e.g. Ollama for local LLMs, or cloud models via API) that the `pi` agent connects to.
6. **Workspace**: The specific local directory where the `pi` agent is executing commands and modifying files.

---

## 2. Interactive Supervision & Approval Flow

Because the local `pi` agent is less intelligent, we must gate high-risk actions (like bash commands or file modifications). `worker-mcp` uses a **smart gating system with risk levels** to automatically approve low-risk actions while requiring explicit coordinator approval for high-risk operations.

### 2.1. Risk Levels

| Level | Value | Examples | Default Behavior |
|---|---|---|---|
| **LOW** | `0` | `ls`, `cat`, `grep`, `git status`, `pwd` | Auto-approve silently |
| **MEDIUM** | `1` | `pnpm install`, file writes in `src/`, `git add` | Auto-approve with notification |
| **HIGH** | `2` | `rm`, `curl`, config file writes, `git commit` | Require explicit approval |
| **CRITICAL** | `3` | `sudo`, `chmod`, writes outside workspace, `git push --force` | Block by default, require approval |

Risk policy is configurable per session via `spawn_pi_session` (at creation) or `set_risk_policy` (at runtime). The default policy auto-approves LOW silently, auto-approves MEDIUM with notification, and requires approval for HIGH and CRITICAL.

### 2.2. Approval Flow

The following diagram describes how `worker-mcp` intercepts a tool execution, classifies its risk, and either auto-approves or asks the coordinator:

```mermaid
sequenceDiagram
    autonumber
    actor Coordinator as Coordinator (MCP Client)
    participant Server as worker-mcp Server
    participant Session as PiSession
    participant Pi as pi CLI (Subprocess)
    
    Coordinator->>Server: Call tool `send_pi_command(sessionId, "Build the project")`
    Server->>Session: Forward prompt
    Session->>Pi: Write JSONL prompt to stdin
    Pi->>Pi: Think & decide to execute a tool (e.g., run `npm install`)
    Pi->>Session: Emit tool call event via stdout (JSONL)
    Note over Session: Intercept event. Pause reading stdout.<br/>Transition session to AWAITING_APPROVAL.
    Session->>Server: Emit event 'pending_action'
    Server->>Coordinator: Send MCP notification / tool response with approval request
    
    alt Approved
        Coordinator->>Server: Call tool `approve_action(sessionId, actionId)`
        Server->>Session: Approve
        Session->>Pi: Write confirmation response to stdin
        Pi->>Pi: Execute tool (`npm install`)
        Pi->>Session: Emit tool execution result
        Session->>Coordinator: Forward execution result
    else Rejected
        Coordinator->>Server: Call tool `reject_action(sessionId, actionId, reason)`
        Server->>Session: Reject with reason
        Session->>Pi: Write simulated failure/refusal to stdin
        Pi->>Pi: Re-plan based on tool failure
        Pi->>Session: Emit updated plan/message
        Session->>Coordinator: Forward updated output
    end
```

---

## 3. API Schema

### 3.1. MCP Tools

`worker-mcp` exposes the following tools to the coordinator:

#### `spawn_pi_session`
Creates and initializes a new `pi` agent session.
* **Arguments**:
  * `sessionId` (string, required): A unique identifier for the session.
  * `cwd` (string, required): The directory path where the `pi` agent will execute.
  * `model` (string, optional): LLM model name to override the default (e.g., `ollama/qwen2.5-coder:7b`, `anthropic/claude-3-5-sonnet`).
  * `systemPrompt` (string, optional): Custom system instructions to append or override.
  * `riskPolicy` (object, optional): Risk-based auto-approval policy. Controls which tool calls are auto-approved based on risk level.
    * `autoApproveUpTo` (number): Actions at or below this risk level (0=LOW, 1=MEDIUM, 2=HIGH, 3=CRITICAL) are auto-approved silently. Default: `0` (LOW).
    * `notifyUpTo` (number): Actions at or below this level (but above `autoApproveUpTo`) are auto-approved with a logged notification. Default: `1` (MEDIUM).
    * `overrides` (array, optional): Custom overrides for specific command patterns. Each entry has `pattern` (glob string) and `action` (`"allow"` or `"block"`).
* **Returns**: `{ success: boolean, status: string }`

#### `send_pi_command`
Sends a prompt or slash command to a running session.
* **Arguments**:
  * `sessionId` (string, required): The ID of the target session.
  * `command` (string, required): The text prompt or slash command (e.g., `/model`, `/reload`, or a standard prompt).
* **Returns**: `{ success: boolean, responseText: string }` (or starts streaming response if supported).

#### `terminate_pi_session`
Stops a session and removes it, freeing its id for reuse. Use this to clear sessions that have crashed, wedged, or are no longer needed.
* **Arguments**:
  * `sessionId` (string, required): The ID of the session to terminate.
* **Returns**: `{ success: boolean }`

#### `list_pi_sessions`
Lists all active sessions and their status.
* **Arguments**: None.
* **Returns**: An array of objects: `[{ sessionId: string, cwd: string, status: string, pendingAction: object | null }]`

#### `get_pending_actions`
Retrieves details of any action currently awaiting coordinator approval.
* **Arguments**:
  * `sessionId` (string, required): The target session ID.
* **Returns**: `{ sessionId: string, actionId: string, tool: string, arguments: object, context: string }`

#### `approve_action`
Approves a pending tool call.
* **Arguments**:
  * `sessionId` (string, required): The target session ID.
  * `actionId` (string, required): The ID of the intercepted tool call.
* **Returns**: `{ success: boolean }`

#### `reject_action`
Denies a pending tool call and sends a rejection/error message back to the worker agent.
* **Arguments**:
  * `sessionId` (string, required): The target session ID.
  * `actionId` (string, required): The ID of the intercepted tool call.
  * `reason` (string, optional): The reason for rejection (which will be fed back to the LLM to help it correct course).
* **Returns**: `{ success: boolean }`

#### `set_risk_policy`
Updates the risk-based auto-approval policy for a session at runtime.
* **Arguments**:
  * `sessionId` (string, required): The target session ID.
  * `riskPolicy` (object, required): The new risk policy (same schema as `spawn_pi_session.riskPolicy`).
* **Returns**: Summary of the applied policy.

#### `get_auto_approved_log`
Retrieves the audit log of actions that were auto-approved by the risk policy.
* **Arguments**:
  * `sessionId` (string, required): The target session ID.
* **Returns**: An array of auto-approved action records, each containing `actionId`, `toolName`, `input`, `riskLevel`, `riskLabel`, `reason`, and `timestamp`.

---

## 4. MCP Resources & Prompt Templates

### 4.1. Resources
* **`worker-mcp://sessions/{sessionId}/history`**: Exposes the complete JSON history of messages exchanged inside the `pi` session. Useful for the coordinator to review the exact chain of thought.
* **`worker-mcp://sessions/{sessionId}/logs`**: A real-time log of events, tool executions, and stdout streams from the spawned process.

### 4.2. Prompts (Templates)
* **`supervise-task`**: A prompt template for the coordinator agent explaining how to command the worker, monitor the progress, and audit tool execution safely.

---

## 5. Operational Design

### 5.1. Locating the Pi Executable
* By default, `worker-mcp` attempts to execute the `pi` binary from the system's `PATH`.
* The binary path can be explicitly overridden by setting the `WORKER_MCP_PI_PATH` environment variable (e.g., `WORKER_MCP_PI_PATH=/usr/local/bin/pi`).

### 5.2. Automatic Gating Extension Injection
* Upon server startup, `worker-mcp` checks for the presence of the supervisor gating extension file at `~/.config/worker-mcp/worker-mcp-gate.ts` (creating directories as needed).
* If missing **or outdated** (version mismatch), `worker-mcp` automatically writes the extension file.
* When spawning a `pi` agent session, `worker-mcp` explicitly loads the extension file using the `--extension` flag. This ensures that standalone runs of `pi` (which auto-discover extensions from `~/.pi/agent/extensions/`) remain unpolluted and fully functional.
* The extension is versioned (currently v2). v2 sends structured JSON payloads (`{ toolName, input }`) instead of human-readable text, enabling server-side risk classification.

### 5.3. Session Registry Persistence
* To survive restarts of the `worker-mcp` server, session metadata (mapping of `sessionId` -> `cwd`, model overrides, status, and system prompts) is persisted locally in `~/.config/worker-mcp/sessions.json`.
* When the server boots up, it reads this registry. Active sessions are marked as `Finished` or `Disconnected` until they are explicitly re-connected or spawned.

### 5.4. Subprocess Lifecycle & Stderr Management
* **Stderr Capture**: Stderr is piped separately from stdout. All stderr output from the `pi` child process is buffered and appended directly to the session's log stream (`worker-mcp://sessions/{sessionId}/logs`) to aid debugging.
* **Crash Detection**: If the child process exits with a non-zero code without completing, the session state transitions to `Crashed`.
* **State Transition back to Idle**: When `pi` emits the `agent_settled` event on stdout, `worker-mcp` updates the session status from `Running Task` back to `Idle`, notifying the coordinator that it is ready for the next command.

