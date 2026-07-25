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
1. `spawn_pi_session(sessionId, cwd, model?, systemPrompt?, riskPolicy?)`: Creates and initializes a supervisor-gated worker process in a target directory with an optional risk-based approval policy.
2. `send_pi_command(sessionId, command, summarize?)`: Dispatches a prompt or slash command to the worker. Set `summarize: true` to get a concise summary instead of raw output.
3. `terminate_pi_session(sessionId)`: Stops a session and removes it, freeing its id for reuse. Use this to clear sessions that have crashed, wedged, or are no longer needed.
4. `list_pi_sessions()`: Lists all active session IDs, directories, and statuses.
5. `get_pending_actions(sessionId)`: Retrieves details of the action currently waiting for your review. Includes `riskLevel` and `riskLabel` for risk-aware decision making.
6. `approve_action(sessionId, actionId, summarize?)`: Approves the execution of the paused tool call.
7. `reject_action(sessionId, actionId, reason?, summarize?)`: Blocks the execution of the tool call and returns feedback/instructions to correct the worker.
8. `set_risk_policy(sessionId, riskPolicy)`: Updates the risk-based auto-approval policy for a session at runtime.
9. `get_auto_approved_log(sessionId, pattern?)`: Retrieves the audit log of actions that were automatically approved by the risk policy. Pass `pattern` to filter entries by the override pattern that triggered them (e.g., `"pnpm*"`).

---

## 3. Smart Gating: Risk-Based Auto-Approval

The worker-mcp server classifies every tool call into a **risk level** and handles it according to the session's **risk policy**. This means you do not need to manually approve every single action — safe operations proceed automatically.

### 3.1. Risk Levels

| Level | Value | Examples | Default Behavior |
|---|---|---|---|
| **LOW** | `0` | `ls`, `cat`, `grep`, `git status`, `pwd`, `echo`, `find` | Auto-approve silently |
| **MEDIUM** | `1` | `pnpm install`, `npm test`, `node`, `tsc`, file writes in `src/`, `git add` | Auto-approve with notification |
| **HIGH** | `2` | `rm`, `mv`, `curl`, `wget`, config file writes (`.env`, `package.json`), `git commit`, `git push` | Require explicit approval |
| **CRITICAL** | `3` | `sudo`, `chmod`, writes outside workspace, `git reset --hard`, `git push --force`, piping to `sh`/`bash` | Require explicit approval |

### 3.2. Choosing a Risk Policy

When spawning a session, select a risk policy that matches the trust level and task type:

#### Conservative (default) — Best for unfamiliar projects or untrusted tasks
```json
{ "autoApproveUpTo": 0, "notifyUpTo": 1, "overrides": [] }
```
- Auto-approves only read-only commands (`ls`, `cat`, `grep`)
- Notifies you about builds/installs but lets them through
- You approve all destructive operations, network access, and git publishing

#### Moderate — Best for active development in trusted projects
```json
{ "autoApproveUpTo": 1, "notifyUpTo": 1, "overrides": [] }
```
- Auto-approves reads AND builds/installs/test runs/source file writes silently
- You only see HIGH and CRITICAL actions
- Good when the worker is doing iterative development (edit → build → test loops)

#### Permissive — Best for isolated scratch workspaces or disposable environments
```json
{ "autoApproveUpTo": 2, "notifyUpTo": 2, "overrides": [] }
```
- Auto-approves almost everything including `rm`, `curl`, `git commit`
- Only blocks CRITICAL actions (`sudo`, out-of-workspace writes, force-push)
- Use only in disposable/sandboxed environments where mistakes are cheap

#### Locked Down — Best for production-adjacent or sensitive environments
```json
{ "autoApproveUpTo": 0, "notifyUpTo": 0, "overrides": [] }
```
- Every single action requires your explicit approval
- Maximum control, but highest token cost
- Use when operating near production configs or secrets

### 3.3. Using Overrides for Fine-Grained Control

Overrides let you allow or block specific commands regardless of their classified risk level. Each override has:
- `pattern` (glob, required): Matches against the command string or tool name.
- `pathPattern` (glob, optional): Matches against the target file path. When set, **both** `pattern` and `pathPattern` must match for the override to apply. Useful for scoping file write permissions to specific directories.
- `action` (`"allow"` or `"block"`, required): Force allow (auto-approve) or block (require approval).
- `maxRiskLevel` (number, optional): Only apply this override if the classified risk is at or below this level (0=LOW, 1=MEDIUM, 2=HIGH, 3=CRITICAL). This prevents blanket allows from bypassing safety for unexpectedly dangerous operations.

**Example: Allow `pnpm` commands but block all network access:**
```json
{
  "autoApproveUpTo": 0,
  "notifyUpTo": 0,
  "overrides": [
    { "pattern": "pnpm *", "action": "allow" },
    { "pattern": "curl *", "action": "block" },
    { "pattern": "wget *", "action": "block" }
  ]
}
```

**Example: Allow everything but block git publishing:**
```json
{
  "autoApproveUpTo": 2,
  "notifyUpTo": 2,
  "overrides": [
    { "pattern": "git push*", "action": "block" },
    { "pattern": "git commit*", "action": "block" }
  ]
}
```

**Example: Allow file writes to `src/` and `tests/` but gate everything else:**
```json
{
  "autoApproveUpTo": 0,
  "notifyUpTo": 0,
  "overrides": [
    { "pattern": "write_file", "pathPattern": "*/src/*", "action": "allow" },
    { "pattern": "write_file", "pathPattern": "*/tests/*", "action": "allow" },
    { "pattern": "edit_file", "pathPattern": "*/src/*", "action": "allow" },
    { "pattern": "edit_file", "pathPattern": "*/tests/*", "action": "allow" }
  ]
}
```

**Example: Allow `pnpm` commands but only up to MEDIUM risk (blocks risky scripts):**
```json
{
  "autoApproveUpTo": 0,
  "notifyUpTo": 0,
  "overrides": [
    { "pattern": "pnpm*", "action": "allow", "maxRiskLevel": 1 }
  ]
}
```
This allows `pnpm install` and `pnpm build` (MEDIUM risk) but still requires approval if `pnpm` somehow triggers a HIGH-risk classification.

### 3.4. Adjusting Policy at Runtime

You can tighten or loosen the policy mid-session using `set_risk_policy`. Common scenarios:
- **Start strict, then loosen**: Begin with conservative policy, observe the worker's behavior via the auto-approved log, then loosen once you trust the pattern.
- **Tighten before sensitive operations**: If the worker is about to touch config files or deploy, tighten the policy temporarily.

### 3.5. Auditing Auto-Approved Actions

Periodically call `get_auto_approved_log(sessionId)` to review what the worker did without your direct approval. Each entry includes the tool name, arguments, risk level, timestamp, and the `matchedOverride` pattern (if an override rule triggered the auto-approval).

You can filter the log by override pattern to verify a specific rule is working as intended:
- `get_auto_approved_log(sessionId, pattern: "pnpm*")` — only shows actions auto-approved by the `pnpm*` override.

This is especially important when using moderate or permissive policies, or after adding new override rules.

---

## 4. Delegation & Supervision Protocol

Always follow this step-by-step flow when managing a worker agent:

### Step 1: Initialize the Session
Determine the target workspace directory (`cwd`) for the task, choose an appropriate risk policy, and spawn a gated session.
- **Tool Call**: `spawn_pi_session(sessionId: "sess_debug_1", cwd: "/path/to/target/project", model: "ollama/qwen2.5-coder:7b", riskPolicy: { "autoApproveUpTo": 1, "notifyUpTo": 1, "overrides": [] })`
- *Tip*: If you want the worker to focus on a specific role, provide a tailored system prompt (e.g. `"You are a junior unit testing assistant, write Jest tests for..."`).
- *Tip*: For iterative dev tasks (edit-build-test loops), use `autoApproveUpTo: 1` so builds and test runs don't block on approval. For sensitive tasks near config/deploy, use `autoApproveUpTo: 0`.

### Step 2: Dispatch the Task Command
Send the initial instruction to the worker.
- **Tool Call**: `send_pi_command(sessionId: "sess_debug_1", command: "Write unit tests for src/math.ts and run them")`

### Step 3: Stream and Monitor Progress
While the worker is running, it will output logs. You should inspect the logs resource:
- **Resource**: `worker-mcp://sessions/sess_debug_1/logs`
- Inspect this resource to see real-time updates of what the agent is thinking, what messages it writes, and what tools it triggers.

### Step 4: Audit & Gating Loop
With smart gating, **LOW and MEDIUM risk actions are auto-approved** by default — the worker proceeds without waiting. You only need to intervene for HIGH and CRITICAL risk actions.

Whenever the worker attempts a high-risk operation (e.g., `rm`, `curl`, config file writes, `git commit`), the server will intercept the action, pause the worker, transition the session to `AWAITING_APPROVAL`, and yield control to you.

When you detect this state (e.g., when a tool returns `AWAITING_APPROVAL` or logs indicate a pause):
1. **Fetch Action Details**: Call `get_pending_actions(sessionId: "sess_debug_1")` to inspect the exact tool, arguments, risk level, and command parameters.
2. **Review Safety & Accuracy**:
   - Check the `riskLevel` and `riskLabel` to understand why this was escalated.
   - Check if the command is safe to run (no recursive deletion, no malicious code).
   - Check if the command is correct (no syntax errors, proper flags).
3. **Decide Action**:
   - **Approve**: If it is correct and safe, call `approve_action(sessionId: "sess_debug_1", actionId: "action_id_uuid")`. The worker will execute the tool and continue.
   - **Reject & Correct**: If it is incorrect, call `reject_action(sessionId: "sess_debug_1", actionId: "action_id_uuid", reason: "The test command is missing the coverage flag. Use 'pnpm test -- --coverage' instead.")`. The execution is blocked, the simulated failure is fed back to the worker, and the worker will re-plan using your correction.
   - **Adjust Policy**: If you find yourself approving the same type of action repeatedly, consider loosening the policy with `set_risk_policy` to auto-approve that risk level.

### Step 5: Verify & Retrieve Results
When the worker finishes its task and transitions to `Idle` or `Finished`:
1. **Review auto-approved actions**: Call `get_auto_approved_log(sessionId: "sess_debug_1")` to see what the worker did without your direct approval. Verify nothing unexpected slipped through.
2. Read the complete conversation history using `worker-mcp://sessions/sess_debug_1/history`.
3. Inspect the workspace directory using standard file tools to verify that the files written are correct and compile successfully.
4. Keep the session open for follow-up prompts, or clean it up with `terminate_pi_session(sessionId: "sess_debug_1")` to free the id for reuse.

### Recovering Dead / Wedged Sessions
If a session's process has exited (crashed, finished, or lost after a server restart), it may appear stuck — you cannot send commands to it, and you cannot respawn the same id. To recover:
1. Call `terminate_pi_session(sessionId: "sess_debug_1")` to remove the dead session and free its id.
2. Call `spawn_pi_session(sessionId: "sess_debug_1", cwd: "...")` to start a fresh session with the same id.
