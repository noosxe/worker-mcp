# Token Conservation Improvements

This document outlines proposed enhancements to `worker-mcp` aimed at reducing the token consumption of the coordinator agent. The core value of `worker-mcp` is offloading work to cheaper local models — these improvements amplify that benefit by minimizing how much the coordinator needs to read, write, and reason about during supervision.

---

## 1. Summarized Responses Instead of Full Transcripts

**Problem**: `send_pi_command` currently returns `responseText` containing the full worker output. The coordinator must read and process the entire stream of consciousness from the worker, including irrelevant intermediate reasoning steps.

**Proposal**: Introduce a response summarization layer — either at the worker level or within the `worker-mcp` server — that distills worker output into a concise summary before returning it to the coordinator. The coordinator needs the *outcome* and key *decisions*, not every line of thought.

**Implementation Ideas**:
- Add a `summarize` option to `send_pi_command` that triggers post-processing of the response.
- Use the local LLM itself to produce a summary before forwarding.
- Alternatively, implement rule-based extraction (files changed, commands run, errors encountered).

---

## 2. Batch Approval / Auto-Approval Rules

**Problem**: Every high-risk action requires a full round-trip approval call from the coordinator. Each approval cycle costs coordinator tokens (reading the pending action details, reasoning about it, calling `approve_action`). For routine operations this overhead is wasteful.

**Proposal**: Allow the coordinator to define **auto-approval policies** at session creation or during a session, so that known-safe operations proceed without coordinator intervention.

**Example Policies**:
- Allow all `pnpm install` / `pnpm build` commands.
- Allow file writes within `src/` but gate writes to config files.
- Allow read-only shell commands (`ls`, `cat`, `grep`) unconditionally.
- Allow all operations matching a glob/regex pattern.

**Implementation Ideas**:
- Add an `approvalPolicy` argument to `spawn_pi_session`.
- Add a `set_approval_policy` tool for runtime policy updates.
- Persist policies in the session registry (`sessions.json`).

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

## 6. Smart Gating with Risk Levels

**Problem**: The current gating model is binary — an action is either gated or not. This means the coordinator sees the same level of detail for a harmless `ls` command as for a destructive `rm -rf`. Processing low-risk approvals wastes coordinator tokens.

**Proposal**: Assign **risk scores** to intercepted actions and vary the approval behavior accordingly:

| Risk Level | Examples | Behavior |
|---|---|---|
| **Low** | `ls`, `cat`, `grep`, `git status` | Auto-approve silently |
| **Medium** | `pnpm install`, file writes in `src/` | Auto-approve with one-line notification |
| **High** | `rm`, network commands, config file changes | Full detail, require explicit approval |
| **Critical** | `sudo`, writes outside workspace | Block by default, require approval + justification |

**Implementation Ideas**:
- Define a risk classification engine with configurable rules.
- Integrate risk levels into the gating extension.
- Allow the coordinator to adjust risk thresholds per session.
- Log all auto-approved actions for post-hoc audit.

---

## Priority & Impact Matrix

| Improvement | Token Savings | Implementation Effort | Priority |
|---|---|---|---|
| Batch Approval / Auto-Approval Rules | 🟢 High | 🟡 Medium | **P0** |
| Smart Gating with Risk Levels | 🟢 High | 🟡 Medium | **P0** |
| Structured Result Schemas | 🟢 High | 🟡 Medium | **P1** |
| Summarized Responses | 🟡 Medium | 🟡 Medium | **P1** |
| Task Templates / Recipes | 🟡 Medium | 🔴 High | **P2** |
| Progress Checkpoints / Diffs | 🟡 Medium | 🔴 High | **P2** |

---

## Next Steps

1. Discuss and finalize which improvements to pursue first.
2. Design detailed specs for the selected improvements.
3. Implement incrementally, starting with the highest-impact, lowest-effort items.
