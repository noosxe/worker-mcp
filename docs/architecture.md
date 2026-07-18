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

Because the local `pi` agent is less intelligent, we must gate high-risk actions (like bash commands or file modifications). The following diagram describes how `worker-mcp` intercepts a tool execution to ask the coordinator for approval:

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
* **Returns**: `{ success: boolean, status: string }`

#### `send_pi_command`
Sends a prompt or slash command to a running session.
* **Arguments**:
  * `sessionId` (string, required): The ID of the target session.
  * `command` (string, required): The text prompt or slash command (e.g., `/model`, `/reload`, or a standard prompt).
* **Returns**: `{ success: boolean, responseText: string }` (or starts streaming response if supported).

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

---

## 4. MCP Resources & Prompt Templates

### 4.1. Resources
* **`worker-mcp://sessions/{sessionId}/history`**: Exposes the complete JSON history of messages exchanged inside the `pi` session. Useful for the coordinator to review the exact chain of thought.
* **`worker-mcp://sessions/{sessionId}/logs`**: A real-time log of events, tool executions, and stdout streams from the spawned process.

### 4.2. Prompts (Templates)
* **`supervise-task`**: A prompt template for the coordinator agent explaining how to command the worker, monitor the progress, and audit tool execution safely.
