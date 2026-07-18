# Requirements: worker-mcp

`worker-mcp` is a Model Context Protocol (MCP) server that empowers a highly intelligent coordinator agent (such as Gemini Pro/Claude 3.5 Sonnet) to orchestrate, monitor, and guide lower-intelligence, locally hosted worker agents. 

Rather than building a custom agent execution loop from scratch, `worker-mcp` delegates the local agent runtime execution to the **`pi` coding agent** (from `@earendil-works/pi-coding-agent`), running it either programmatically via its SDK or in a subprocess using its built-in JSON-RPC mode (`pi --mode rpc`). 

Because local smaller models running inside the `pi` agent require significant guidance and supervisor verification, `worker-mcp` acts as a supervisory wrapper, providing tight loop controls, interactive permission gating, and state inspection.

---

## 1. Functional Requirements

### 1.1. Pi Session Lifecycle Management
The coordinator agent must be able to spin up and control `pi` agent sessions.
* **Spawn Pi Session**: Spawn a new `pi` agent instance.
  * Inputs: Unique session ID, target workspace directory (`cwd`), model overrides (e.g., Ollama model, Claude, etc.), and custom system prompt.
  * Operation: Under the hood, this spawns a `pi --mode rpc` process in the specified directory or instantiates the programmatic `AgentSession` from the Pi SDK.
* **Terminate Session**: Gracefully shut down or force-stop a running `pi` session.
* **Session Listing & Status**: Query the list of active sessions and their current status (`Idle`, `Running Task`, `Awaiting Coordinator Approval`, `Crashed`, `Finished`).

### 1.2. Interactive Control & Handholding (Permission Gating)
Since the `pi` worker agent is running local tools (bash command execution, file read/write/edit), the coordinator needs to supervise its work.
* **Event Interception**: `worker-mcp` must listen to the JSON-RPC event stream of the `pi` agent process.
* **Intercepting Tool Calls**: When `pi` attempts to run a tool (e.g. executing a shell script, making edits to code):
  * **Pause** the execution of that tool.
  * Emit an MCP event/resource update notifying the coordinator of a pending action.
  * Provide the tool name, arguments, and context to the coordinator.
* **Approve / Deny / Modify Action**: The coordinator must be able to:
  * Approve the execution.
  * Deny the execution, returning a simulated error or refusal back to the `pi` agent loop.
  * Provide guidance or feedback prompts that are injected directly into the `pi` conversation flow to correct its course.

### 1.3. Communication & Logging Stream
* **Stream Events**: Stream thinking tokens, output messages, tool executions, and file diffs from the `pi` process to the coordinator in real-time.
* **History Inspection**: Expose the session history (messages exchanged between the `pi` agent and the LLM) as a readable MCP resource.
* **Inject System Prompt/Message**: Allow the coordinator to manually append context or system prompts to a session at any time.

### 1.4. Workspace Inspection
* **Shared Workspace Access**: Since both the coordinator (via `worker-mcp`) and the `pi` worker operate in the same filesystem, `worker-mcp` should expose tools to let the coordinator inspect, read, and write files in the worker's target workspace, ensuring the coordinator can verify the worker's outputs or prepare files for them.

---

## 2. Non-Functional Requirements

### 2.1. Protocol Compatibility
* **MCP Compliance**: Fully compatible with the Model Context Protocol (MCP).
  * Expose tools like `spawn_pi_session`, `send_pi_command`, `approve_action`, `reject_action`, and `list_pi_sessions`.
  * Expose active sessions, log streams, and current tool call statuses as MCP resources.

### 2.2. Robust Process Isolation & Communication
* **Robust JSONL Parsing**: Correctly parse the `\n`-delimited JSON Lines (JSONL) protocol used by `pi --mode rpc`, avoiding issues with Unicode splits.
* **Error Recovery**: If the `pi` process crashes, hangs, or encounters an LLM timeout, `worker-mcp` must capture the error logs, terminate any runaway child processes, and report the state cleanly back to the coordinator.
* **Resource Limiting**: Limit the maximum duration of a single `pi` execution or set process limits (e.g., max execution time, maximum file write size) to prevent infinite loops.
