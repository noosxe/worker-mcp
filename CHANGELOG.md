# Changelog

## Unreleased

### Added

- Configuration is one validated object (zod), built from an optional JSON
  file (`--config <path>`, `WORKER_MCP_CONFIG`, or
  `$XDG_CONFIG_HOME/worker-mcp/config.json`), then `WORKER_MCP_*` variables,
  then flags. All existing variables keep their names; new ones are
  `WORKER_MCP_STATE_DIR` and `WORKER_MCP_RUNTIME_DIR`. See the README
  "Configuration" section and `config.example.json`.
- `--print-config` prints the effective configuration (secret-looking values
  redacted) and exits.
- A name listed exactly in the config file's `env.allow` may pass to workers
  even when it matches a force-dropped pattern such as `*_TOKEN`. The same name
  from the environment or a flag, or a pattern, cannot.
- `zod` is a direct dependency.

### Security

- Workers no longer inherit the server's environment. It is built from an
  allowlist (`PATH`, `HOME`, locale, `TERM`, XDG and temp dirs, TLS/CA and Nix
  variables, `PI_*`). `SSH_AUTH_SOCK`, `*_TOKEN`, `*_SECRET*`, `AWS_*`, cloud
  and cluster credentials and `WORKER_MCP_*` are never passed. Set
  `WORKER_MCP_ENV_PASSTHROUGH=NAME1,NAME2` to opt other names in. **LLM keys
  set in the environment (for example `ANTHROPIC_API_KEY`) no longer reach
  workers unless listed there**; prefer pi's own auth file.
- The approval gate is written from a constant compiled into the server to a
  fresh private directory (0700) for every worker, and removed when the worker
  exits. If it cannot be written, the spawn is refused instead of starting pi
  ungated.
- pi is started with `--no-extensions --no-mcp --no-approve`, so only the gate
  is loaded and project-local extensions, MCP servers and files are ignored.
- The summarizer, which ran a second ungated pi on the worker's output, is
  removed. `summarize` is still accepted but ignored, with a note in the
  result. `WORKER_MCP_SUMMARIZE_TIMEOUT` is gone.
- The server no longer deletes `~/.pi/agent/extensions/worker-mcp-gate.ts` or
  writes anything else under `~/.pi`. It also stops writing the persistent
  `~/.config/worker-mcp/worker-mcp-gate.ts`; an old copy there is unused and
  can be deleted.
- Added `docs/security.md`.
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

- Override patterns for commands: `*` no longer matches shell metacharacters
  (`; & | < > ` $ ( ) \`) or newlines, so `git *` matches `git log --oneline`
  but not `git status; rm -rf ~`. An `allow` override never auto-approves a
  CRITICAL action unless it sets `maxRiskLevel` to CRITICAL. `pathPattern`
  matching is unchanged.

- Recursive or forced `rm` (and `find -delete`, `rm --no-preserve-root`) aimed
  at `/`, `~`, `$HOME`, the workspace itself, anything above it or any path
  outside it is CRITICAL. Targets are resolved against the session's working
  directory. Plain deletes inside the workspace stay HIGH. `chmod` and `chown`
  were already CRITICAL.

### Changed

- **Invalid configuration now fails startup**, with a message naming the source
  and key: bad JSON, unknown keys, wrong types, non-positive or non-numeric
  values, relative directories, unknown command-line flags, and a config file
  that is group- or world-writable, owned by neither you nor root, or in a
  directory others can write to.
- **Workers are no longer persisted.** `~/.config/worker-mcp/sessions.json` is
  no longer read or written, so a restarted server starts with no sessions.
  An existing file is left alone and ignored; it can be deleted. This also
  fixes servers sharing one registry file.
- The server creates nothing on disk until the first worker starts. Gate
  directories now live under one private per-server directory,
  `<runtimeDir>/worker-mcp-<pid>` (0700), removed on clean shutdown. At the
  next start, such directories of pids that are no longer running are removed.
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
