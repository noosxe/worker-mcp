# Protocol Specification: worker-mcp

This document specifies the exact protocols and payload schemas for:

1. **The MCP Interface** (Coordinator agent <-> `worker-mcp` server).
2. **The Pi RPC Wire Protocol** (`worker-mcp` server <-> `pi --mode rpc` child process).
3. **The Gating & Approval Protocol** (Human-in-the-Loop interception).

---

## 1. Coordinator <-> worker-mcp (MCP API)

The coordinator (e.g., Antigravity or Claude Desktop) communicates with `worker-mcp` using standard MCP JSON-RPC.

### 1.1. Tool Definitions & Payload Schemas

#### A. `spawn_pi_session`

Initializes a new `pi` session by starting a child process or SDK session.

- **Request Schema**:
  ```json
  {
  	"name": "spawn_pi_session",
  	"arguments": {
  		"sessionId": "string",
  		"cwd": "string",
  		"model": "string (optional)",
  		"systemPrompt": "string (optional)"
  	}
  }
  ```
- **Response Schema (Success)**:
  ```json
  {
  	"content": [
  		{
  			"type": "text",
  			"text": "Successfully initialized session <sessionId> in <cwd>"
  		}
  	]
  }
  ```

#### B. `send_pi_command`

Legacy. Sends a prompt or slash command to a running session and blocks until the run ends (or `timeout`). Prefer `start_run` and `wait_run` (below). It is a wrapper over a run.

- **Request Schema**:
  ```json
  {
  	"name": "send_pi_command",
  	"arguments": {
  		"sessionId": "string",
  		"command": "string",
  		"summarize": "boolean (optional)",
  		"timeout": "number (optional)"
  	}
  }
  ```
- **Response Schema (Success - Blocking)**:
  ```json
  {
  	"content": [
  		{
  			"type": "text",
  			"text": "<Command execution result>"
  		}
  	]
  }
  ```

#### B2. `start_run`, `wait_run`, `get_run`, `cancel_run`

- `start_run {workerId, prompt, intent?, waitMs?}`: starts a run; returns its view at once (or after up to `waitMs`, max 50 000). Fails with `WORKER_BUSY` (naming the run in flight) when the worker has a run.
- `wait_run {runId, waitMs?, sinceSeq?, outputOffset?}`: waits up to `waitMs` (default 25 000, at most 50 000) and returns early only on a terminal state or a new approval. A cancelled request detaches the wait; the run goes on.
- `get_run {runId, part?, offset?, maxChars?}`: reads state and result without waiting; `part: "transcript"` lists tool calls.
- `cancel_run {runId}`: aborts a run and returns its view once it settled.

The view is text (one summary line, then JSON): `runId`, `workerId`, `state`, `seq`, `elapsedMs`, `pendingApprovals[]`, `activity[]`, `output {text, offset, nextOffset, totalChars, truncated, more}`, `error`, `usage`, `gate {autoAllowed, autoDenied, escalated, notable[]}` and `next`. When the request has a `progressToken`, waiting calls send `notifications/progress`.

#### C. `cancel_pi_command`

Aborts the currently running command in a session.

- **Request Schema**:
  ```json
  {
  	"name": "cancel_pi_command",
  	"arguments": {
  		"sessionId": "string"
  	}
  }
  ```

#### D. `terminate_pi_session`

Stops a session and removes it, freeing its id for reuse.

- **Request Schema**:
  ```json
  {
  	"name": "terminate_pi_session",
  	"arguments": {
  		"sessionId": "string"
  	}
  }
  ```

#### E. `list_pi_sessions`

Queries all active sessions and their states.

- **Request Schema**:
  ```json
  {
  	"name": "list_pi_sessions",
  	"arguments": {}
  }
  ```
- **Response Schema (Success)**:
  ```json
  {
  	"content": [
  		{
  			"type": "text",
  			"text": "[{\"sessionId\":\"sess_1\",\"cwd\":\"/path/to/project\",\"status\":\"AWAITING_APPROVAL\",\"pendingAction\":{...}}]"
  		}
  	]
  }
  ```

#### F. `get_pending_actions`

Retrieves details of a tool call or action currently awaiting approval.

- **Request Schema**:
  ```json
  {
  	"name": "get_pending_actions",
  	"arguments": {
  		"sessionId": "string"
  	}
  }
  ```

#### G. `approve_action`

Approves an intercepted tool execution. Returns at once; call `wait_run` with the run's id to follow the run.

- **Request Schema**:
  ```json
  {
  	"name": "approve_action",
  	"arguments": {
  		"sessionId": "string",
  		"actionId": "string",
  		"summarize": "boolean (optional)"
  	}
  }
  ```
- **Response Schema**:
  ```json
  {
  	"content": [
  		{
  			"type": "text",
  			"text": "Approved action <id>. This returns at once: call wait_run with runId <runId> to follow the run."
  		}
  	]
  }
  ```

#### H. `reject_action`

Denies an intercepted tool execution and feeds a rejection back to the worker.

- **Request Schema**:
  ```json
  {
  	"name": "reject_action",
  	"arguments": {
  		"sessionId": "string",
  		"actionId": "string",
  		"reason": "string (optional)",
  		"summarize": "boolean (optional)"
  	}
  }
  ```
- **Response Schema**:
  ```json
  {
  	"content": [{ "type": "text", "text": "Action rejected." }]
  }
  ```

#### I. `set_risk_policy`

Updates the risk-based auto-approval policy for a session at runtime.

- **Request Schema**:
  ```json
  {
  	"name": "set_risk_policy",
  	"arguments": {
  		"sessionId": "string",
  		"riskPolicy": "object"
  	}
  }
  ```

#### J. `get_auto_approved_log`

Retrieves the audit log of actions that were auto-approved by the risk policy.

- **Request Schema**:
  ```json
  {
  	"name": "get_auto_approved_log",
  	"arguments": {
  		"sessionId": "string",
  		"pattern": "string (optional)"
  	}
  }
  ```

### 1.2. MCP Resources & Notifications

- **Resource URIs**:
  - `worker-mcp://sessions/{sessionId}/history`: Exposes the conversation log from the `pi` agent.
  - `worker-mcp://sessions/{sessionId}/logs`: Exposes stderr, stdout lines, and raw event traces.
- **Real-time Notifications**:
  `worker-mcp` sends custom notifications to the client when a state transitions or an action needs review.
  - Event: `notifications/session_status_changed`
    ```json
    {
    	"method": "notifications/resources/updated",
    	"params": {
    		"uri": "worker-mcp://sessions/{sessionId}/logs"
    	}
    }
    ```

---

## 2. worker-mcp <-> Pi Child Process (Wire Protocol)

Communication between `worker-mcp` and the `pi` subprocess is handled using strict **LF-delimited JSON Lines (JSONL)** over `stdin` and `stdout`.

### 2.1. Commands sent by worker-mcp (to child `stdin`)

Commands sent to the `pi` process must conform to the `RpcCommand` typescript types:

- **Send a Prompt**:
  ```json
  {
  	"id": "cmd_1",
  	"type": "prompt",
  	"message": "Write a hello world script in JS"
  }
  ```
- **Abort Execution**:
  ```json
  { "id": "cmd_2", "type": "abort" }
  ```
- **Query Current State**:
  ```json
  { "id": "cmd_3", "type": "get_state" }
  ```
- **UI Dialog Response (Gating Return)**:
  ```json
  { "type": "extension_ui_response", "id": "req_uuid_123", "confirmed": true }
  ```
  ```json
  { "type": "extension_ui_response", "id": "req_uuid_123", "confirmed": false }
  ```

### 2.2. Responses & Events emitted by Pi (on child `stdout`)

#### A. RpcResponse (Command Results)

Sent by `pi` to acknowledge the completion of an input command.

- **Success Response**:
  ```json
  {
  	"id": "cmd_3",
  	"type": "response",
  	"command": "get_state",
  	"success": true,
  	"data": {
  		"sessionId": "sess_1",
  		"model": { "id": "qwen2.5-coder" },
  		"isStreaming": false
  	}
  }
  ```
- **Error Response**:
  ```json
  {
  	"id": "cmd_1",
  	"type": "response",
  	"command": "prompt",
  	"success": false,
  	"error": "LLM timeout occurred"
  }
  ```

#### B. RpcExtensionUIRequest (UI & Tool Interception Hooks)

Emitted by `pi` when an extension (such as the permission gate) triggers a user-facing check.

- **Confirmation (Crucial for gating)**:
  ```json
  {
  	"type": "extension_ui_request",
  	"id": "ui_req_abc123",
  	"method": "confirm",
  	"title": "Allow tool execution",
  	"message": "Allow bash tool to run command 'npm install'?"
  }
  ```
- **Input Request**:
  ```json
  {
  	"type": "extension_ui_request",
  	"id": "ui_req_xyz",
  	"method": "input",
  	"title": "Enter API Key"
  }
  ```
- **Notification (Streaming log/status)**:
  ```json
  {
  	"type": "extension_ui_request",
  	"id": "ui_req_status",
  	"method": "notify",
  	"message": "Starting server...",
  	"notifyType": "info"
  }
  ```

#### C. Session Events (Real-time Progress)

Emitted during prompt execution to stream progress:

- **Turn Starts**: `{"type": "turn_start"}`
- **Message Streams**: `{"type": "message_update", "text": "Creating file..."}`
- **Tool Running**: `{"type": "tool_execution_start", "tool": "bash", "arguments": {"command": "npm install"}}`
- **Tool Finished**: `{"type": "tool_execution_end", "tool": "bash", "exitCode": 0}`

---

## 3. Human-in-the-Loop Interception Protocol

To restrict the `pi` agent from executing actions autonomously without consent, worker-mcp loads a gate extension into pi and answers its questions over the RPC UI sub-protocol. The full design is in [providers/pi.md](providers/pi.md); in short:

### 3.1. The Interception Mechanism

1. pi is started with `--no-extensions -e <gate>`. The gate is written fresh for each spawn from a constant in the server.
2. On `session_start` the gate reports `ready:<nonce>` through `setStatus`. The server does not consider the worker open until it sees it.
3. The gate registers a `tool_call` listener that sends each call through `ctx.ui.input`:
   ```json
   {
   	"type": "extension_ui_request",
   	"id": "req_123",
   	"method": "input",
   	"title": "worker-mcp-gate/v3",
   	"placeholder": "{\"v\":3,\"nonce\":\"…\",\"toolName\":\"bash\",\"input\":{…}}"
   }
   ```
4. `worker-mcp` classifies the call. It is allowed, denied or held for the coordinator (the session is `AWAITING_APPROVAL` meanwhile).
5. The answer goes back as the `value` of an `extension_ui_response`, a JSON decision: `{"v":3,"nonce":"…","decision":"allow"}`, `"deny"` with a `reason`, or `"mutate"` with a new `input`.
6. The gate allows, blocks with the reason (so a coordinator's `reject_action` reason reaches the model), or rewrites the input. Anything that is not a valid decision with the right nonce blocks the call.
