---
name: worker-mcp-orchestrator
description: Guides the coordinator agent on how to orchestrate, delegate to, and supervise local worker agents using the worker-mcp server.
---

# Skill: worker-mcp Orchestrator

This skill allows you (the coordinator agent) to delegate tasks to simpler, locally hosted worker AI agents using the `worker-mcp` server. 

Local workers are useful for isolating tasks, running tests, searching large codebases, or saving token budget. However, because they are less intelligent, you must actively supervise ("handhold") them using the protocol described below.

---

## 1. When to Delegate Tasks

Delegate a task to a local worker if it is:
- **Boilerplate generation**: Creating multiple files with standard structures.
- **Bulk filesystem analysis**: Searching, grep-matching, or listing large directories.
- **Repetitive debugging**: Running compilation and editing files iteratively until tests pass.
- **Isolated execution**: Operating in an isolated workspace where you want to review shell commands before they run on the system.

---

## 2. Tools Reference

You have access to the following MCP tools for worker management:
1. `spawn_pi_session(sessionId, cwd, model?, systemPrompt?)`: Creates and initializes a supervisor-gated worker process in a target directory.
2. `send_pi_command(sessionId, command)`: Dispatches a prompt or slash command to the worker.
3. `list_pi_sessions()`: Lists all active session IDs, directories, and statuses.
4. `get_pending_actions(sessionId)`: Retrieves details of the action currently waiting for your review.
5. `approve_action(sessionId, actionId)`: Approves the execution of the paused tool call.
6. `reject_action(sessionId, actionId, reason?)`: Blocks the execution of the tool call and returns feed-back/instructions to correct the worker.

---

## 3. Delegation & Supervision Protocol

Always follow this step-by-step flow when managing a worker agent:

### Step 1: Initialize the Session
Determine the target workspace directory (`cwd`) for the task and spawn a gated session.
- **Tool Call**: `spawn_pi_session(sessionId: "sess_debug_1", cwd: "/path/to/target/project", model: "ollama/qwen2.5-coder:7b")`
- *Tip*: If you want the worker to focus on a specific role, provide a tailored system prompt (e.g. `"You are a junior unit testing assistant, write Jest tests for..."`).

### Step 2: Dispatch the Task Command
Send the initial instruction to the worker.
- **Tool Call**: `send_pi_command(sessionId: "sess_debug_1", command: "Write unit tests for src/math.ts and run them")`

### Step 3: Stream and Monitor Progress
While the worker is running, it will output logs. You should inspect the logs resource:
- **Resource**: `worker-mcp://sessions/sess_debug_1/logs`
- Inspect this resource to see real-time updates of what the agent is thinking, what messages it writes, and what tools it triggers.

### Step 4: Audit & Gating Loop (Crucial)
Whenever the worker attempts to execute a shell command (via `bash`) or edit files, the `worker-mcp` server will intercept the action, pause the worker's execution loop, transition the session status to `AWAITING_APPROVAL`, and yield control to you.

When you detect this state (e.g., when a tool returns `AWAITING_APPROVAL` or logs indicate a pause):
1. **Fetch Action Details**: Call `get_pending_actions(sessionId: "sess_debug_1")` to inspect the exact tool, arguments, and command parameters.
2. **Review Safety & Accuracy**:
   - Check if the command is safe to run (no recursive deletion, no malicious code).
   - Check if the command is correct (no syntax errors, proper flags).
3. **Decide Action**:
   - **Approve**: If it is correct and safe, call `approve_action(sessionId: "sess_debug_1", actionId: "action_id_uuid")`. The worker will execute the tool and continue.
   - **Reject & Correct**: If it is incorrect, call `reject_action(sessionId: "sess_debug_1", actionId: "action_id_uuid", reason: "The test command is missing the coverage flag. Use 'pnpm test -- --coverage' instead.")`. The execution is blocked, the simulated failure is fed back to the worker, and the worker will re-plan using your correction.

### Step 5: Verify & Retrieve Results
When the worker finishes its task and transitions to `Idle` or `Finished`:
1. Read the complete conversation history using `worker-mcp://sessions/sess_debug_1/history`.
2. Inspect the workspace directory using standard file tools to verify that the files written are correct and compile successfully.
3. Terminate or keep the session open for follow-up prompts.
