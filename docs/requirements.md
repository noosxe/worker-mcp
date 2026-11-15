# Requirements: worker-mcp

`worker-mcp` is a Model Context Protocol (MCP) server that lets a coordinating agent (Claude Code, the Claude desktop app, any MCP client) spawn, supervise and guide third-party coding agents running locally. The agents are **workers**; each kind of agent is a **provider**. pi is the provider today.

The server is a runner, not an agent: it owns process control, runs, gating and limits, and leaves the thinking to the worker and the coordinator.

---

## 1. Functional requirements

### 1.1. Worker lifecycle

- Spawn a worker of a chosen provider in an absolute workspace directory, with an optional name, model, system prompt and risk policy (`spawn_worker`). The server makes the id.
- List the live workers with their status, current run and pending approvals (`list_workers`); stop one and free its name and slot (`terminate_worker`).
- List the providers and whether each is usable (`list_providers`).
- Bound the number of workers, close idle ones, and restrict workspaces to configured roots.

### 1.2. Runs

- Give a worker a task as a run and return at once (`start_run`); wait in short calls (`wait_run`); read results, paged, also after the worker is gone (`get_run`); cancel (`cancel_run`).
- No call blocks longer than the configured wait limit (50 s by default), so a long task never loses its result to a client timeout.

### 1.3. Supervision

- Intercept every tool call a worker makes, classify its risk and apply the worker's policy within the server's ceiling. Calls that need the coordinator wait as pending approvals (`get_pending_actions`, `approve_action`, `reject_action`); an unanswered approval is denied after a timeout.
- Let the coordinator change a worker's policy at runtime (`set_risk_policy`) and review every gate decision (`get_gate_log`).
- Protected paths (agent and shell configuration, credentials) are never auto-approved.

### 1.4. Visibility

- Expose, for people and debugging, a worker's log, a run's transcript and a worker's gate log as MCP resources, and announce changes to the resource list.

---

## 2. Non-functional requirements

- **MCP compliance**: stdio transport, strict input schemas, `structuredContent` that matches an `outputSchema` plus one text block, tool annotations, server `instructions`. Errors are `isError` results with a stable code and a next step.
- **Untrusted output**: everything a worker wrote is labelled as untrusted wherever it reaches the coordinator.
- **Robust processes**: parse the worker's protocol robustly, capture errors, kill the whole process tree, never leave runaway children, bound output size and run time.
- **Minimal environment**: workers get an allowlisted environment, never the server's secrets.
- **Provider neutrality**: the tools and results name no provider; a provider is a module behind one internal interface (see [providers.md](providers.md)).
- **No persistence**: workers live with the server.
- **Compatibility**: runs on Node and Bun. The 0.4 tool names remain as deprecated aliases for one minor release (`WORKER_MCP_LEGACY_TOOLS`).

## 3. Out of scope (for now)

A sandbox around workers, an HTTP risk classifier, cross-restart resume, and providers other than pi.
