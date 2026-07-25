# Token Conservation Improvements

This document outlines proposed enhancements to `worker-mcp` aimed at reducing the token consumption of the coordinator agent. The core value of `worker-mcp` is offloading work to cheaper local models — these improvements amplify that benefit by minimizing how much the coordinator needs to read, write, and reason about during supervision.

---

## 1. Summarized Responses Instead of Full Transcripts (Done)

**Status**: ✅ Implemented

**Problem**: `send_pi_command` currently returns `responseText` containing the full worker output. The coordinator must read and process the entire stream of consciousness from the worker, including irrelevant intermediate reasoning steps.

**Proposal**: Introduce a response summarization layer — either at the worker level or within the `worker-mcp` server — that distills worker output into a concise summary before returning it to the coordinator. The coordinator needs the *outcome* and key *decisions*, not every line of thought.

**Implementation Details**:
- **Output Extraction**: `worker-mcp` now extracts the clean assistant message text (excluding the thinking and reasoning steps) from completed turns.
- **Optional Summarization**: Added an optional `summarize` boolean parameter to `send_pi_command`, `approve_action`, and `reject_action`.
- **LLM-Based Summarization**: When `summarize` is enabled, the server invokes the local LLM in a background process using `pi --no-session` to produce a concise summary of the outcome, decisions, and files changed.
- **Robust Fallback**: Includes a 10-second timeout that automatically falls back to raw extracted text if the local model server is busy or fails to respond.

---

## 2. Batch Approval / Auto-Approval Rules

**Status**: ✅ Implemented

**Problem**: Every high-risk action requires a full round-trip approval call from the coordinator. Each approval cycle costs coordinator tokens (reading the pending action details, reasoning about it, calling `approve_action`). For routine operations this overhead is wasteful.

**Proposal**: Allow the coordinator to define **auto-approval policies** at session creation or during a session, so that known-safe operations proceed without coordinator intervention.

**Example Policies**:
- Allow all `pnpm install` / `pnpm build` commands.
- Allow file writes within `src/` but gate writes to config files.
- Allow read-only shell commands (`ls`, `cat`, `grep`) unconditionally.
- Allow all operations matching a glob/regex pattern.

**Implementation Details**:
- **Path-Scoped Overrides**: Extended `RiskOverride` with an optional `pathPattern` field — a glob pattern matched against the target file path. When set, both the command/tool `pattern` and `pathPattern` must match for the override to apply. This enables rules like "allow `write_file` to `*/src/*` but gate config files".
- **Risk-Capped Overrides**: Added an optional `maxRiskLevel` field to `RiskOverride`. The override only activates if the classified risk is at or below this level, preventing blanket allows from bypassing safety for unexpectedly dangerous operations (e.g., `pnpm*` with `maxRiskLevel: MEDIUM` allows `pnpm install` but not a risky script).
- **Override Audit Trail**: Auto-approval decisions now track `matchedOverride` — the pattern that triggered the decision. The `get_auto_approved_log` tool accepts an optional `pattern` filter to query entries by their triggering override.
- **`getTargetPath()` Helper**: Extracted file-path resolution into a dedicated function for cleaner separation between command-string matching and path matching.
- **Full Backward Compatibility**: All new fields are optional. Existing overrides without `pathPattern` or `maxRiskLevel` work identically to before.

---

## 3. Structured Result Schemas

**Problem**: Free-text responses force the coordinator to parse prose to understand what happened. This is token-expensive and error-prone.

**Proposal**: Return **structured JSON results** from worker interactions with well-defined fields, so the coordinator can quickly extract what it needs.

**Example Schema**:
```json
{
  "summary": "Implemented the login form component with validation",
  "filesChanged": [
    { "path": "src/components/LoginForm.tsx", "action": "created" },
    { "path": "src/styles/login.css", "action": "created" }
  ],
  "commandsRun": [
    { "command": "pnpm install zod", "exitCode": 0 }
  ],
  "errors": [],
  "status": "completed"
}
```

**Implementation Ideas**:
- Instrument the gating extension to track file operations and command executions.
- Build the structured result from tracked events rather than parsing LLM output.
- Offer both `responseText` (for detailed debugging) and `structuredResult` (for token-efficient consumption).

---

## 4. Progress Checkpoints / Incremental Diffs

**Problem**: When the coordinator needs to check on a long-running task or review history, it must read the full conversation history resource (`worker-mcp://sessions/{sessionId}/history`). This re-ingests all prior content.

**Proposal**: Implement **incremental checkpoints** — the server tracks a cursor and only returns what changed since the coordinator last checked.

**Implementation Ideas**:
- Add a `since` parameter (timestamp or sequence number) to the history resource.
- Introduce a `get_session_diff` tool that returns only new events since a given checkpoint.
- Emit checkpoint markers in the event stream so the coordinator can resume from a known point.

---

## 5. Task Templates / Recipes

**Problem**: Many common workflows (run tests, lint and fix, scaffold a component) require the coordinator to orchestrate multiple back-and-forth turns with the worker. Each turn costs coordinator tokens for reasoning and tool calls.

**Proposal**: Define **pre-built task templates** (recipes) that bundle multi-step workflows into a single tool call. The coordinator sends one high-level instruction and gets back a consolidated result.

**Example Templates**:
- `run-tests`: Execute the test suite and report pass/fail summary with failure details.
- `lint-and-fix`: Run the linter, auto-fix what's possible, report remaining issues.
- `implement-function`: Given a function signature and description, implement it, write tests, and report.
- `review-diff`: Review staged git changes and provide a summary of issues.

**Implementation Ideas**:
- Add a `recipes/` directory with YAML/JSON recipe definitions.
- Add a `run_recipe` tool that accepts a recipe name and parameters.
- Allow users to define custom recipes.

---

## 6. Smart Gating with Risk Levels (Done)

**Status**: ✅ Implemented

**Problem**: The current gating model is binary — an action is either gated or not. This means the coordinator sees the same level of detail for a harmless `ls` command as for a destructive `rm -rf`. Processing low-risk approvals wastes coordinator tokens.

**Proposal**: Assign **risk scores** to intercepted actions and vary the approval behavior accordingly:

| Risk Level | Examples | Behavior |
|---|---|---|
| **Low** | `ls`, `cat`, `grep`, `git status` | Auto-approve silently |
| **Medium** | `pnpm install`, file writes in `src/` | Auto-approve with one-line notification |
| **High** | `rm`, network commands, config file changes | Full detail, require explicit approval |
| **Critical** | `sudo`, writes outside workspace | Block by default, require approval + justification |

**Implementation Details**:
- **Risk Classification Engine**: Implemented to classify intercepted actions into LOW, MEDIUM, HIGH, and CRITICAL levels.
- **Configurable Policies**: Added `riskPolicy` configuration in `spawn_pi_session` to specify `autoApproveUpTo`, `notifyUpTo`, and rule overrides.
- **Dynamic Adjustment**: Added `set_risk_policy` tool to modify the risk policy of active sessions at runtime.
- **Audit Logging**: Added `get_auto_approved_log` tool to retrieve a record of auto-approved actions.

---

## Priority & Impact Matrix

| Improvement | Token Savings | Implementation Effort | Priority |
|---|---|---|---|
| Smart Gating with Risk Levels | 🟢 High | 🟡 Medium | ✅ **Done** |
| Summarized Responses | 🟡 Medium | 🟡 Medium | ✅ **Done** |
| Batch Approval / Auto-Approval Rules | 🟢 High | 🟡 Medium | ✅ **Done** |
| Structured Result Schemas | 🟢 High | 🟡 Medium | **P1** |
| Task Templates / Recipes | 🟡 Medium | 🔴 High | **P2** |
| Progress Checkpoints / Diffs | 🟡 Medium | 🔴 High | **P2** |

---

## Next Steps

1. Discuss and finalize which improvements to pursue first.
2. Design detailed specs for the selected improvements.
3. Implement incrementally, starting with the highest-impact, lowest-effort items.
