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
* **Request Schema**:
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
* **Response Schema (Success)**:
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
Sends a prompt or slash command to a running session.
* **Request Schema**:
  ```json
  {
    "name": "send_pi_command",
    "arguments": {
      "sessionId": "string",
      "command": "string"
    }
  }
  ```
* **Response Schema (Success)**:
  ```json
  {
    "content": [
      {
        "type": "text",
        "text": "Command sent to session <sessionId>."
      }
    ]
  }
  ```

#### C. `list_pi_sessions`
Queries all active sessions and their states.
* **Request Schema**:
  ```json
  {
    "name": "list_pi_sessions",
    "arguments": {}
  }
  ```
* **Response Schema (Success)**:
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

#### D. `approve_action`
Approves an intercepted tool execution.
* **Request Schema**:
  ```json
  {
    "name": "approve_action",
    "arguments": {
      "sessionId": "string",
      "actionId": "string"
    }
  }
  ```
* **Response Schema**:
  ```json
  {
    "content": [{ "type": "text", "text": "Action approved." }]
  }
  ```

#### E. `reject_action`
Denies an intercepted tool execution and feeds a rejection back to the worker.
* **Request Schema**:
  ```json
  {
    "name": "reject_action",
    "arguments": {
      "sessionId": "string",
      "actionId": "string",
      "reason": "string (optional)"
    }
  }
  ```
* **Response Schema**:
  ```json
  {
    "content": [{ "type": "text", "text": "Action rejected." }]
  }
  ```

### 1.2. MCP Resources & Notifications
* **Resource URIs**:
  * `worker-mcp://sessions/{sessionId}/history`: Exposes the conversation log from the `pi` agent.
  * `worker-mcp://sessions/{sessionId}/logs`: Exposes stderr, stdout lines, and raw event traces.
* **Real-time Notifications**:
  `worker-mcp` sends custom notifications to the client when a state transitions or an action needs review.
  * Event: `notifications/session_status_changed`
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

* **Send a Prompt**:
  ```json
  { "id": "cmd_1", "type": "prompt", "message": "Write a hello world script in JS" }
  ```
* **Abort Execution**:
  ```json
  { "id": "cmd_2", "type": "abort" }
  ```
* **Query Current State**:
  ```json
  { "id": "cmd_3", "type": "get_state" }
  ```
* **UI Dialog Response (Gating Return)**:
  ```json
  { "type": "extension_ui_response", "id": "req_uuid_123", "confirmed": true }
  ```
  ```json
  { "type": "extension_ui_response", "id": "req_uuid_123", "confirmed": false }
  ```

### 2.2. Responses & Events emitted by Pi (on child `stdout`)

#### A. RpcResponse (Command Results)
Sent by `pi` to acknowledge the completion of an input command.
* **Success Response**:
  ```json
  { "id": "cmd_3", "type": "response", "command": "get_state", "success": true, "data": { "sessionId": "sess_1", "model": { "id": "qwen2.5-coder" }, "isStreaming": false } }
  ```
* **Error Response**:
  ```json
  { "id": "cmd_1", "type": "response", "command": "prompt", "success": false, "error": "LLM timeout occurred" }
  ```

#### B. RpcExtensionUIRequest (UI & Tool Interception Hooks)
Emitted by `pi` when an extension (such as the permission gate) triggers a user-facing check.
* **Confirmation (Crucial for gating)**:
  ```json
  {
    "type": "extension_ui_request",
    "id": "ui_req_abc123",
    "method": "confirm",
    "title": "Allow tool execution",
    "message": "Allow bash tool to run command 'npm install'?"
  }
  ```
* **Input Request**:
  ```json
  { "type": "extension_ui_request", "id": "ui_req_xyz", "method": "input", "title": "Enter API Key" }
  ```
* **Notification (Streaming log/status)**:
  ```json
  { "type": "extension_ui_request", "id": "ui_req_status", "method": "notify", "message": "Starting server...", "notifyType": "info" }
  ```

#### C. Session Events (Real-time Progress)
Emitted during prompt execution to stream progress:
* **Turn Starts**: `{"type": "turn_start"}`
* **Message Streams**: `{"type": "message_update", "text": "Creating file..."}`
* **Tool Running**: `{"type": "tool_execution_start", "tool": "bash", "arguments": {"command": "npm install"}}`
* **Tool Finished**: `{"type": "tool_execution_end", "tool": "bash", "exitCode": 0}`

---

## 3. Human-in-the-Loop Interception Protocol

To restrict the `pi` agent from executing actions autonomously without consent, we use a custom **Pi Permission Extension** combined with the standard `confirm` RPC UI message.

### 3.1. The Interception Mechanism

1. We configure the `pi` process to load a custom TypeScript extension: `worker-mcp-gate.ts`.
2. The extension registers a listener for `tool_call` events:
   ```typescript
   pi.on("tool_call", async (event, ctx) => {
     // Trigger the standard confirm UI context
     const approved = await confirm(
       "Allow tool execution",
       `Allow ${event.tool} tool to run with arguments ${JSON.stringify(event.input)}?`
     );
     if (!approved) {
       return { block: true, reason: "Command execution rejected by coordinator." };
     }
   });
   ```
3. Inside the `pi` engine, the `confirm` call is routed to `RpcExtensionUIRequest` because the agent is running in RPC mode.
4. `pi` outputs the `confirm` request to stdout:
   ```json
   { "type": "extension_ui_request", "id": "req_123", "method": "confirm", "title": "Allow tool execution", "message": "Allow bash tool to run with arguments ..." }
   ```
5. `worker-mcp` intercepts this message, marks the session as `AWAITING_APPROVAL`, and cache-maps `req_123` to the session.
6. The coordinator receives notification, reviews the payload, and calls:
   * **`approve_action`**: `worker-mcp` writes `{"type": "extension_ui_response", "id": "req_123", "confirmed": true}` to `pi`'s `stdin`.
   * **`reject_action`**: `worker-mcp` writes `{"type": "extension_ui_response", "id": "req_123", "confirmed": false}` to `pi`'s `stdin`.
7. The `confirm` promise inside the child process resolves with `true` or `false`, allowing or blocking the tool execution safely.
