# Changelog

## Unreleased

### Workspace sandbox

- **`sandbox: "workspace"`** (Linux, bubblewrap) for `spawn_worker`: the
  worker runs with a read-only filesystem, an empty `$HOME` and `/tmp`, and
  only its workspace writable. It is killed with the server even on SIGKILL,
  protected paths (`.git/hooks`, `.git/config`, `.claude`, `.mcp.json`,
  `.envrc`, `.husky`, `.pi`, `.env*`) are read-only inside the workspace, and
  a git worktree can still commit. The network is not restricted and the worker
  can still read its own API key. macOS has no sandbox: `sandbox.minimum` must
  stay `none` there. See docs/security.md.
- **Config**: `sandbox.minimum` (default `none`), `sandbox.default` (default
  `workspace` when it works), `sandbox.extraRo`, `sandbox.extraRw`,
  `sandbox.bwrapPath` (else `WORKER_MCP_BWRAP`, else `PATH`); env vars
  `WORKER_MCP_SANDBOX_MINIMUM` and `WORKER_MCP_SANDBOX_DEFAULT`, flags
  `--sandbox-minimum` and `--sandbox-default`.
- **Other paths to `$HOME` are hidden too**: the sandbox reads the mounts and
  puts an empty tmpfs on every other path to the home directory's data (a
  persistent-storage bind, a device mounted twice). If the mounts cannot be
  read, the sandbox is unavailable. `sandbox.hide` lists extra paths to hide
  (also a Nix option).
- **Spawn**: the new `sandbox` argument is raised to the minimum and reported
  in `clamped`. Without a working sandbox a `workspace` minimum fails the spawn
  with the new error code `SANDBOX_UNAVAILABLE`; otherwise the worker runs
  unsandboxed and `notes` says so. `list_providers` reports
  `sandbox: {available, reason, minimum, default}`, and a worker's `sandbox`
  field is now real. The default is `workspace` wherever bubblewrap and
  unprivileged user namespaces work, so existing setups start sandboxed:
  set `sandbox.default` to `none` to keep the old behaviour.
- **Nix**: the package sets `WORKER_MCP_BWRAP` to its bubblewrap on Linux; the
  Home Manager module has typed `sandbox.*` options, checked at build time.

### Jev classifier dialect

- **Jev risk confidence**: with valid risk `probabilities`, the risk part of an
  allow or deny confidence is now the probability of the levels on the right
  side of the threshold (below `askScore` for a not-risky allow, below
  `denyScore` for a risky-but-requested allow, above `denyScore` for a deny),
  not jev's own risk `confidence`, which measures the spread around the top level.
  A score alone still uses jev's confidence. The raw probabilities and jev's
  risk confidence are now in the reason in the gate log.

- **Jev confidence**: an allow's confidence is now the lowest confidence jev
  reports (the `risk` answer's, plus a noul answer's own when present), no
  longer a function of the probabilities, so a confidently low-risk call can be
  auto-allowed. New `thresholds.thresholdMargin` (default 0.05; Nix
  `thresholds.thresholdMargin`) escalates an allow whose values sit next to a
  threshold.

- **`dialect: "jev"`** for `gate.classifiers`: asks TypeSafe's System One API
  (`POST <base>/v1/systemone`) four typed questions about a call (`risk`,
  `approval`, `user_requested`, `from_untrusted`) and maps the answers to
  allow, deny or escalate, with confidence, on top of the existing thresholds,
  `gate.httpAllowCeiling` and the CRITICAL and hard-limit exclusions. Backends:
  `typesafe` (default, `jev-latest`), `openrouter` (`jev-1.13`) and `custom`
  (`url`); `model`, `thresholds` and `cacheTtlMs` are new classifier keys.
  One request in flight per classifier, retries on 429, 5xx and network errors
  within the call's deadline. Commands and up to 8 KiB of arguments leave the
  machine, so it stays off unless configured; see `docs/classifier-api.md`.
- **Nix**: classifier options `dialect`, `backend`, `model`, `thresholds` and
  `cacheTtlMs`; `url` is optional.

### Claude Code plugin, default model and module options

- **Default model**: `providers.pi.defaultModel` (`WORKER_MCP_PI_DEFAULT_MODEL`,
  `--pi-default-model`) is used when `spawn_worker` omits `model`; an explicit
  `model` wins. It shows in `list_providers` (`defaultModel`), in the
  `spawn_worker` result and in `--print-config`.
- **Claude Code plugin** in the repository: `.claude-plugin/plugin.json`, a
  server declared in `plugin.json`, a `marketplace.json` (`/plugin marketplace add
  noosxe/worker-mcp`) and the skill. Plugin options ask for the allowed
  directories, the pi path and the default model. `skills/worker-mcp/SKILL.md`
  is rewritten for the 13-tool surface (default model, `remember`, auto mode and
  `escalatedBecause`). The plugin is not in the npm or Nix package.
- **Nix**: `lib.mkClaudePlugin { pkgs, command, env }` builds the plugin
  folder. The Home Manager module gets `piPath`, `defaultModel`, `allowedRoots`,
  `legacyTools`, `envPassthrough`, `env`, `envFiles` (read by a generated
  launcher; their names are passed through to workers), `claude.enable`,
  `claude.name` and `claude.command`. `claude.enable` links the plugin as one
  symlink into the Claude Code skills directory.

### Auto mode, classifiers and a Home Manager module

- **Auto mode** (`gate.mode: auto`, default `manual`): calls the rules
  escalate are first sent to the configured HTTP classifiers; only uncertain
  ones, or ones a classifier cannot answer, reach the coordinator. A classifier
  `allow` needs confidence 0.85 (`deny` 0.6), is limited by the new
  `gate.httpAllowCeiling` (default `HIGH`, separate from `gate.maxAutoApprove`)
  and can never allow a hard limit or CRITICAL. `gate.onClassifierFailure` is
  `escalate` (default) or `deny`, never allow. Auto mode needs at least one
  classifier. A worker can opt out with `policy.classifiers: "off"`. Settings:
  `gate.mode`, `gate.httpAllowCeiling`, `gate.onClassifierFailure`,
  `gate.classifiers`, `gate.cache`, `gate.recentActions`, with
  `WORKER_MCP_GATE_MODE`, `WORKER_MCP_HTTP_ALLOW_CEILING`,
  `WORKER_MCP_ON_CLASSIFIER_FAILURE` and matching flags.
- **HTTP classifier, dialect `worker-mcp-v1`** (provisional, version
  `1-provisional`; see `docs/classifier-api.md`): https or loopback http, no
  redirects, no proxy, 3 s timeout, 16 KiB response cap, strict response
  validation (confidence required), 8 KiB argument cap, a circuit breaker and a
  per-worker verdict cache (LRU, 10 min at most), cleared on `set_risk_policy`
  and when the worker closes.
- **Token from a file**: `tokenFile` per classifier (mode 0600 or stricter,
  owned by the server's user, symlinks judged by their target, so a sops-nix
  secret works). Read at startup (a missing or insecure file is a clear
  startup error) and again on `SIGHUP`. Never in env, tool arguments, logs,
  the audit file or `--print-config`, which shows only the path.
- **`approve_action` `remember: "worker"`**: allows identical calls from that
  worker until it closes or its policy changes; never for hard limits, protected
  paths or CRITICAL. Reuse shows as `decidedBy: "cache"`. The result has
  `remembered`.
- **Audit file**: every gate decision is appended to
  `<stateDir>/audit.jsonl` (JSONL, `O_APPEND`, mode 0600, rotated at 10 MiB,
  three kept; `audit.enabled`, `audit.file`). Metadata only: no full arguments
  or tokens. The state directory and token files are protected paths. A write
  failure is logged once and `list_workers` reports `auditDegraded: true`.
- `get_gate_log` entries and pending approvals carry `consulted` and
  `escalatedBecause`; `decidedBy` filters `rules`, `cache`, `http:<name>`,
  `coordinator`, `timeout` and `cancel`.
- **Home Manager module** `homeManagerModules.default` (`programs.worker-mcp`):
  installs the package and writes `config.json` from a freeform `settings`
  plus typed options, running `--print-config` on it at build time so invalid
  settings fail the build. Secrets are file paths only. The flake has a
  `checks` entry that evaluates the module.

### Fixed

- pi workers run with `--no-session`, so pi no longer saves worker
  conversations under its own session directory.

## 0.5.0

### Neutral tool surface (0.5.0)

The server is provider-neutral: pi is a provider behind the same tools. The
tools are renamed and their results are structured. The deprecated names stay
for one minor release.

- **13 tools**: `list_providers`, `spawn_worker`, `start_run`, `wait_run`,
  `get_run`, `cancel_run`, `get_pending_actions`, `approve_action`,
  `reject_action`, `list_workers`, `set_risk_policy`, `get_gate_log` and
  `terminate_worker`. New: `list_providers`, `spawn_worker` (takes
  `provider`, `name`, `model`, `systemPrompt` and `policy`), `list_workers`,
  `get_gate_log` and `terminate_worker`. `approve_action` has no `remember`
  option in this release.
- **Structured results.** Every neutral tool returns `structuredContent` that
  matches its `outputSchema`, plus one text block: a summary line, then the
  same data as JSON. Fields a worker wrote sit under keys named `untrusted…`
  (`untrustedFinalText`, `untrustedActivity`, `untrustedCommand`,
  `untrustedPaths`, `untrustedPreview`, `untrustedTranscript`,
  `untrustedNotable`), and are wrapped in `<worker_output>` tags in the text
  block.
- **Annotations and descriptions.** Each tool has a title, a 2-5 sentence
  description and `readOnlyHint`, `destructiveHint`, `idempotentHint` and
  `openWorldHint`, set honestly for the tools that let a worker act. Model
  examples are generic (`<provider>/<model>`).
- **Server `instructions`**: a short coordinator guide (the flow, the 50 s
  wait, approvals, and the rule that worker output is data) sent on connect.
- **Aliases.** The six 0.4 tools `spawn_pi_session`, `send_pi_command`,
  `cancel_pi_command`, `terminate_pi_session`, `list_pi_sessions` and
  `get_auto_approved_log` still work, with their old text results, and are
  removed in 0.6.0. Each description starts "Deprecated, use X:". They are
  listed only while `WORKER_MCP_LEGACY_TOOLS` is on (config key `legacyTools`,
  default on in 0.5.x, shown by `--print-config`); with `0` a call to one
  returns an error that names the replacement. `send_pi_command` waits at most
  `limits.maxWaitMs` and then returns the run id; `get_auto_approved_log`
  matches `pattern` against the preview. The aliases carry the annotations of
  the tools they map to. Gate log entries name the `approvalId` of a call that
  was sent to the coordinator, and the provider's own id as `providerCallId`. The old argument keys `sessionId`
  (on `spawn_pi_session`, and on the neutral tools that kept their names),
  `riskPolicy` and `actionId` are still accepted, deprecated.
- **Resources v2**, for people and debugging: templates
  `worker-mcp://workers/{workerId}/log`, `worker-mcp://runs/{runId}/transcript`
  and `worker-mcp://gate/{workerId}`, with `notifications/resources/list_changed`
  when a worker starts or closes. The old `worker-mcp://sessions/{id}/history`
  (now the latest run's transcript, as Markdown) and `.../logs` are served until
  0.6.0. Worker-written content in every resource is wrapped as untrusted.
- **Docs.** README rewritten, with "Use from Claude Code and the Claude desktop
  app" and the pitfalls list; `docs/mcp-api.md` replaces `docs/protocols.md`
  (pi's protocol is in `docs/providers/pi.md`); architecture and requirements
  updated; the worker-mcp skill describes the run workflow. The dev shell
  prints its banner to stderr.

Breaking changes in 0.5.0 (together with the run model and limits below):

- `approve_action` and `reject_action` no longer return the worker's output;
  call `wait_run`.
- MCP tasks are gone.
- `summarize` is gone (ignored, with a note).
- Workers are not restored after a restart.
- `notifyUpTo` is gone (accepted and ignored).
- Worker ids are server-generated; names are the caller's handle.
- `get_pending_actions` returns `approvals` (structured), an empty list when
  none, not the text `null`.
- `list_pi_sessions` entries carry `workerId`, `name` and `pendingActions` (a
  count).
- Worker text in results is wrapped as untrusted.
- A worker whose process died is removed at once (it used to stay listed as
  `CRASHED`).
- `send_pi_command` stops waiting after at most `limits.maxWaitMs`.
- A `waitMs` above 50 000 is refused instead of clamped.
- The pi-named tools and the `sessions/…` resource URIs are deprecated and
  go in 0.6.0.

### Validation and limits

- Every tool validates its input with a strict zod schema: unknown arguments
  are rejected, and the bounds are enforced (`prompt` and `command` 200 000
  characters, `systemPrompt` 20 000, `intent` and a rejection `reason` 500,
  50 policy overrides, `waitMs` 0 to 50 000, `get_auto_approved_log` `limit`
  200). Invalid input returns `INVALID_ARGUMENT`.
- Errors are `isError` results whose text starts with a stable code
  (`WORKER_NOT_FOUND`, `WORKER_BUSY`, `RUN_NOT_FOUND`, `APPROVAL_NOT_FOUND`,
  `LIMIT_REACHED`, `INVALID_ARGUMENT`, `PROVIDER_UNAVAILABLE`,
  `GATE_UNAVAILABLE`, `CWD_NOT_ALLOWED`) followed by what to do next. No stack
  traces.
- Workers get a server-generated id (`w_` and 8 lowercase letters or digits);
  approvals get `a_…` ids. `spawn_pi_session` takes an optional `name`
  (`A-Za-z0-9_-`, up to 64, unique among live workers), and every tool taking
  a worker accepts its id or its name. Ids and names are never used in file
  paths.
- `cwd` must be an absolute path to an existing directory and is resolved to
  its real path. New setting `limits.allowedRoots`
  (`WORKER_MCP_ALLOWED_ROOTS`, comma-separated, `--allowed-roots`): when set,
  the real `cwd` must lie inside one of the (real) roots, else
  `CWD_NOT_ALLOWED`.
- New limits `limits.maxWorkers` (default 4; a spawn past it is
  `LIMIT_REACHED`) and `limits.idleTimeoutMs` (default 30 minutes: a worker
  with no run for that long is closed; its runs stay readable). Both are
  shown by `--print-config`.
- Everything a worker wrote that reaches the coordinator (final text,
  activity lines, tool commands and paths, progress messages) is wrapped as
  `<worker_output run="r_…" trust="untrusted">…</worker_output>`, and any
  `</worker_output` inside is escaped. A pending approval is shown as fields
  (tool, kind, command, paths, risk, reason) instead of a free-text message.

### Changed (breaking)

- `spawn_pi_session`: `sessionId` is now an optional, deprecated spelling of
  `name`. The worker's id is generated and returned in the result; the id (or
  the name) is what the other tools take in `sessionId` / `workerId`.
- `get_pending_actions` returns a JSON array of the approvals waiting (empty
  when there are none, never `null`), and takes an optional `sessionId` and an
  optional `runId`. Each entry has `approvalId`; `actionId` is kept as an
  alias.
- `approve_action` and `reject_action` take the server-generated `approvalId`
  (`actionId` is still accepted); `sessionId` is optional. The provider's own
  call id is no longer an approval id.
- `list_pi_sessions` entries carry `workerId`, `name` and `pendingActions`
  (a count) instead of `pendingAction`.
- Results of `send_pi_command`, `start_run`, `wait_run` and `get_run` wrap
  worker text as described above, so exact-match parsing of the output text
  needs to strip the wrapper.
- A worker whose process died is removed at once (it used to stay listed as
  `CRASHED`); its runs stay readable and its name and slot are free again.
- A `waitMs` above 50 000 is refused instead of clamped.

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
- Server setting `gate.maxAutoApprove` (`WORKER_MCP_MAX_AUTO_APPROVE`,
  `--max-auto-approve`; `LOW`, `MEDIUM` or `HIGH`, default `MEDIUM`): the
  highest level a coordinator's policy may auto-approve. Policies given to
  `spawn_pi_session` and `set_risk_policy` are lowered to it, and the result
  lists what was lowered. `gate.protectedPaths` adds paths workers may never
  write without approval.
- Risk policy v2: `overrides[].match` (`kind`, `tool`, `command`, `path`) with
  `action: allow | escalate | deny`. The earlier shape is converted on input.
  The spawn and `set_risk_policy` results report the policy in force.
- A pending approval reports `reason` and `hardLimit`, and a call refused by a
  `deny` override is reported in the next result.
- Each worker keeps a bounded in-memory log of every gate decision.

- **Asynchronous runs.** New tools `start_run`, `wait_run`, `get_run` and
  `cancel_run`. `start_run` returns a run id at once (or after `waitMs`);
  `wait_run` blocks for at most `limits.maxWaitMs` (50 s, under the 60 s
  default request timeout of the TypeScript MCP client) and returns early only
  when the run ends or a tool call needs an approval; `get_run` pages the
  result; `cancel_run` aborts. A run's result is kept after the worker is
  terminated or has crashed, for `limits.resultRetentionMs` (1 hour), and the
  newest `limits.maxRetainedRuns` (100) are kept. If the client cancels a wait
  the run carries on. When a request carries a `progressToken`, waiting calls
  send progress notifications. See the README, "Running tasks".
- Run limits: `limits.maxRunMs` (`WORKER_MCP_RUN_TIMEOUT_MS`, default 30
  minutes; the run is aborted and ends `timed_out`), `limits.maxWaitMs`
  (`WORKER_MCP_MAX_WAIT_MS`), `limits.runStartTimeoutMs`
  (`WORKER_MCP_RUN_START_TIMEOUT_MS`, default 15 s: a worker that does not
  acknowledge a prompt fails the run and is closed), `gate.approvalTimeoutMs`
  (`WORKER_MCP_APPROVAL_TIMEOUT_MS`, default 10 minutes), and in the file only
  `defaultWaitMs`, `resultRetentionMs`, `maxRetainedRuns`, `outputBufferChars`
  and `pageChars`.
- An approval nobody answers within `gate.approvalTimeoutMs` is denied with
  the reason "approval timed out", which reaches the worker.

### Security

- Stopping a worker now reaches everything it started. pi runs each bash
  command in a process group of its own, which a single group kill missed, and
  a SIGKILL of pi left them running. The server sends SIGTERM first, then after
  a grace period SIGKILL to the worker's group and to every descendant found by
  walking the process tree (`/proc` on Linux, `ps` elsewhere), on terminate and
  on server shutdown. A second shutdown signal kills at once.
- The risk classifier works on pi's real tool names (`bash`, `read`, `edit`,
  `write`, `grep`, `find`, `ls`). Before, it matched names pi does not use, so
  every file tool was treated as an unknown tool. Unknown tools are HIGH.
  Paths are resolved with symlinks followed and checked with `path.relative`,
  so `/work-evil`, `src/../../x` and a symlink out of the workspace are
  outside it.
- Protected paths are hard limits: writes or edits to `.mcp.json`, `.claude/`,
  `.git/hooks/`, `.git/config`, `.envrc`, `.husky/`, shell startup files, pi
  and worker-mcp's own configuration, and credentials, and shell commands that
  name them, can never be auto-approved by any policy or override, inside the
  workspace too. They always go to the coordinator. See `docs/security.md`.
- The shell classifier now has a quote-aware lexer. It rates each command in a
  pipeline or list and takes the highest, sees through quoting and escapes,
  rates the body of `$(...)` and backticks, and treats anything it cannot parse
  as HIGH at least.
- Policy overrides use a glob matcher with no backtracking, so a pattern cannot
  stall the server.

### Changed

- **`approve_action` and `reject_action` return at once** with a short
  acknowledgement naming the run, instead of waiting for the worker's next
  stop. Follow the run with `wait_run`. A call that waits at an approval can be
  answered in any order when several are pending.
- `send_pi_command` is now a legacy wrapper over a run: it starts a run and
  waits, with the same blocking behaviour and output. When it stops at an
  approval, its text ends with the run id. If its `timeout` passes it names the
  run, which can be followed with `wait_run`. `cancel_pi_command` also works
  while a run waits at an approval.
- **The loop detector is replaced.** A run now fails ("repeated output") when a
  worker writes the same non-blank line more than 200 times in a row (or more
  than 64 KiB of one repeated line); Markdown rules, table separators and
  other short repeated patterns no longer abort a run. `limits.maxOutputChars`
  now caps one streamed assistant message, and a run past it fails with
  "output limit exceeded" (it used to end quietly with the partial text). Run
  output is kept up to `limits.outputBufferChars` (1 MiB).
- A command that fails, times out or is aborted for a reason now ends the run
  as `failed` or `timed_out` and the blocking `send_pi_command` returns an
  error for them; a plain cancel still returns the output so far.
- A send to a worker that stopped reading its input, or that never
  acknowledges a prompt, now fails within `limits.runStartTimeoutMs` and the
  wedged worker is closed.
- `list_pi_sessions` also reports `currentRunId`.
- **A rejection's reason now reaches the worker.** The approval gate is
  rewritten (v3): it asks over pi's `input` dialog with a JSON decision instead
  of a yes/no `confirm`, so `reject_action`'s `reason` is what the model sees
  (without a reason: "Tool execution blocked by the coordinator agent."). The
  gate also reports `ready:<nonce>` when pi has loaded it, and a spawn fails
  (and pi is killed) unless that arrives, so a gate that did not load can no
  longer go unnoticed. Any reply that is not a valid decision with the right
  nonce blocks the call.
- Two tool calls waiting at once no longer overwrite each other: each is
  decided on its own. `get_pending_actions` shows the oldest; answering it
  reveals the next.
- A dialog from pi that is not the gate's (`select`, `confirm`, `input`,
  `editor`) is answered with cancel instead of being left waiting.
- **A worker that exits by itself now fails the command.** `send_pi_command`
  returns an error naming the exit code ("worker exited unexpectedly") instead
  of the text "Process terminated", and the session is `CRASHED`.
- A run now ends when pi reports `agent_settled`, not at the first `agent_end`.
- The history resource lists the prompts and the assistant's replies; tool
  results are no longer included.
- Internal: pi lives in `src/providers/pi/` behind the provider interface and
  `PiSession` is replaced by `Session` (`src/session/session.ts`), which opens
  its worker through the provider. The pi provider and gate are described in
  `docs/providers/pi.md`.
- Worker processes are started in one place (`src/core/child.ts`), which
  builds the environment, puts each worker in its own process group, frames its
  JSON lines with a line-length cap (8 MiB, longer lines are dropped and
  reported), truncates stderr lines, and never throws on a write to a closed
  pipe. `terminate_pi_session` now returns once the worker is gone.
- Internal: a provider interface (`src/providers/`) with a static registry and
  an in-process fake provider for tests.
- **Auto-approval is bounded by the server.** With the default
  `gate.maxAutoApprove` a policy cannot auto-approve HIGH or CRITICAL calls,
  whatever `autoApproveUpTo` or `maxRiskLevel` it carries.
- An `allow` override with no `maxRiskLevel` now covers up to MEDIUM (it
  covered everything but CRITICAL), never covers a path outside the workspace
  unless its `path` pattern names it, and never covers a protected path.
- `notifyUpTo` no longer has a separate meaning: it is merged into
  `autoApproveUpTo` and every auto-approved call is reported in the next result.
- Reads outside the workspace are MEDIUM (they were LOW); reading a credential
  file is a hard limit. Edits and writes inside the workspace that are not
  configuration files are MEDIUM (some were HIGH).
- Simple LOW pipelines and lists such as `cat f | grep x` or `ls && pwd` are LOW
  again; quoted metacharacters no longer count. `find ... -name x -delete` and
  `chmod u+w ./dist` inside the workspace are MEDIUM instead of HIGH and
  CRITICAL. Redirection to a file, here-documents, subshells, background jobs
  and variable expansion in a command stay at least HIGH.
- The old tool names `read_file`, `write_file`, `edit_file`, `run_command` and
  the like are no longer recognised as tools (pi never used them); in a policy
  override they are converted to pi's names.
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
  directory others can write to. Files inside the Nix store (symlinks from
  home-manager, for example) are exempt from the owner and directory checks.
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

### Removed

- **MCP tasks.** The task store, the `updateTaskStatus` patch, the `tasks`
  capability, `execution.taskSupport` and the handling of `params.task` are
  gone, along with their tests. The goal clients are not known to request
  tasks, the SDK marks the API experimental, and the task path was where the
  earlier crashes lived; runs replace it. A task-augmented call now gets a
  plain result. A thin adapter over the run store can come back if a client
  needs it.
- The loop detector (`detectLoop`), replaced by the repeat check above.

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
