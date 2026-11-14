# Changelog

## Unreleased

### Security

- The shell risk classifier is no longer bypassed by command chaining. Any
  command with `;`, `&&`, `||`, `|`, `&`, backticks, `$`, parentheses,
  redirections, backslashes or newlines is at least HIGH, as are wrappers
  (`sh -c`, `env`, `xargs`, `timeout`, `find -exec`, ...), interpreters
  (`python`, `node`, ...), package installers and build runners, reads of
  secrets and the environment, and leading `NAME=value` assignments.
- `git` is classified by subcommand and arguments: read-only subcommands stay
  LOW; `-c`, `--upload-pack`, `push`, `config`, `remote` and similar are HIGH.
- The default policy is now `autoApproveUpTo: LOW, notifyUpTo: LOW`. To restore
  the old behaviour pass `riskPolicy: { autoApproveUpTo: 0, notifyUpTo: 1,
  overrides: [] }` to `spawn_pi_session` or `set_risk_policy`.

### Changed

- `send_pi_command` results list the actions that were auto-approved during the
  run (tool, risk level, truncated command or path).
- Users will see more approval prompts: simple pipelines and package manager
  commands that used to pass now wait for approval.

## 0.4.2

Hotfix that makes the server usable from clients that don't use MCP tasks.

### Fixed

- `send_pi_command` returns the worker's output to clients that don't use MCP
  tasks. A task is created only when the request asks for one, and the
  requested task TTL is honoured (default 1 hour).
- Task results are stored at most once, and every task store call is guarded.
  Cancelling, terminating or outliving the TTL no longer crashes the server.
- A run that stops at an approval prompt no longer completes its task; the task
  stays `input_required` until the action is approved or rejected.
- A task is created only after the command is accepted, so a busy session no
  longer leaves an orphaned task or replaces the live task's id.
- Writes to a worker's stdin after it exits no longer crash the server.
- The server terminates its workers and exits when the client closes the
  connection or stdin, and on unhandled rejections and uncaught exceptions.
- `sessionId` must match `^[A-Za-z0-9_-]{1,64}$`; anything else is rejected.
- Invalid numeric environment variables (`WORKER_MCP_COMMAND_TIMEOUT`,
  `WORKER_MCP_MAX_OUTPUT_CHARS`, `WORKER_MCP_SUMMARIZE_TIMEOUT`) and an invalid
  `timeout` argument are rejected instead of being treated as `NaN`.

### Documentation

- Added a "Use with Claude Code" section to the README.
