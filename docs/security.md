# Security model

`worker-mcp` lets a coordinating agent run local `pi` coding-agent workers and
gate their tool calls. This page says what that protects and what it does not.

## Trust model

- **The server's configuration and environment** are trusted. The coordinator
  cannot change the server's environment or the path of the `pi` binary.
- **The coordinator** chooses tasks and working directories and approves or
  rejects gated actions. Worker output can steer it, so treat output as
  untrusted.
- **The worker and everything it reads are not trusted.** Its model can be
  prompt-injected by any file, web page or tool output in the workspace.
- **A worker's tools run with the worker process's privileges.** Anything that
  process can read, a prompt-injected worker can send out through any call that
  is allowed.

## What the gate does

For every tool call, a gate extension asks the server, which classifies the
action by risk and either auto-approves it under the session's policy or waits
for the coordinator.

- **Tool calls are mapped to canonical kinds** before they are rated. pi's
  tools map as `bash` to shell, `read` to read, `ls` to list, `grep` and `find`
  to search, `edit` to edit and `write` to write. Any other tool name is HIGH.
  Paths are resolved against the worker's working directory with every
  symlink followed (a dangling one too), and "inside the workspace" is decided
  by `path.relative`, not by a string prefix. A symlink inside the workspace
  that points out counts as outside.
- **Levels.** Reads, listings and searches in the workspace are LOW; outside it
  MEDIUM. Writes and edits in the workspace are MEDIUM, HIGH for build and
  configuration files (`package.json`, `flake.nix`, workflows and the like);
  outside the workspace CRITICAL. Shell commands are rated by a quote-aware
  lexer, below.
- **Protected paths are hard limits.** A write or edit of one, or a shell
  command that names one, is never auto-approved: no policy, override or
  classifier can allow it, inside the workspace or out. It always goes to the
  coordinator. The built-in list:

  | Rule                 | Paths                                                                                                                                                                                                                                                                                 | Gate                      |
  | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
  | `worker-mcp-state`   | the state and runtime directories, `~/.config/worker-mcp/`                                                                                                                                                                                                                            | write CRITICAL, read HIGH |
  | `coordinator-config` | `<workspace>/.mcp.json`, `<workspace>/.claude/`, `~/.claude/`, `~/.claude.json`, `~/.config/Claude/`                                                                                                                                                                                  | write HIGH                |
  | `runs-later`         | `.git/hooks/` and `.git/config` (also in submodules), `.envrc`, `.husky/`, `~/.bashrc`, `~/.bash_profile`, `~/.bash_login`, `~/.bash_logout`, `~/.profile`, `~/.zshrc`, `~/.zshenv`, `~/.zprofile`, `~/.zlogin`, `~/.config/fish/`, `~/.config/autostart/`, `~/.config/systemd/user/` | write HIGH                |
  | `agent-config`       | `~/.pi/`, `<workspace>/.pi/`                                                                                                                                                                                                                                                          | write HIGH                |
  | `secrets`            | `~/.ssh/`, `~/.gnupg/`, `~/.aws/`, `~/.config/gh/`, `~/.netrc`, `~/.docker/config.json`, `~/.pi/agent/auth.json`, `.env` and `.env.*` in the workspace                                                                                                                                | read HIGH, write CRITICAL |
  | `configured`         | `gate.protectedPaths` from the config file                                                                                                                                                                                                                                            | write HIGH                |

  Matching is case-insensitive and on real paths, so `./x/../.mcp.json` and a
  symlink to `.mcp.json` are caught. A rule that would cover the whole
  workspace is ignored. For shell, an argument that resolves to a protected
  path applies the same rule (a read-only command like `cat` is a read, anything
  else a write), as does `git config`, and a glob such as `.e*` that could
  expand to one. This is best effort: `cd .git/hooks && cp x pre-commit` is
  rated HIGH, not hard.

- **Shell lexer.** A command is split into simple commands the way a shell
  would (quotes, escapes, `$(...)`, backticks, `|`, `&&`, `||`, `;`, newlines)
  and the level is the highest over its parts. A pipeline or list of LOW
  commands (`cat f | grep x`, `ls | wc -l`, `ls && pwd`) is LOW; quoted
  metacharacters are not metacharacters. At least HIGH: command or process
  substitution (its body is rated too), redirection other than `2>&1` and
  `/dev/null`, here-documents, subshells and groups, background jobs,
  assignments before a command, a variable or other expansion whose value is
  unknown (`$X`, `${X}`, `$'...'`, `{a,b}`), wrappers (`env`, `xargs`, `sh`,
  `time`, ...), interpreters, package runners and anything unknown. Whatever
  the lexer cannot parse with confidence is HIGH too. A pipe into a shell and
  `eval`/`exec` are CRITICAL.
- **The coordinator's policy has a ceiling.** `gate.maxAutoApprove` (default
  MEDIUM, at most HIGH) bounds what `spawn_pi_session` and `set_risk_policy`
  can auto-approve: `autoApproveUpTo` and every `allow` override are lowered to
  it, and the result says what was lowered. A prompt-injected coordinator
  therefore cannot talk the server into auto-approving HIGH or CRITICAL calls.
  Only the server's configuration can change the ceiling.
- **Overrides** apply to canonical calls. An `allow` never covers a hard limit,
  never covers a path outside the workspace unless its `path` pattern names it,
  and stops at its `maxRiskLevel` (default MEDIUM; CRITICAL only if given
  explicitly, which the ceiling then lowers). `deny` refuses a call without
  asking. Glob patterns are matched by an algorithm with no backtracking, so a
  pattern cannot be written to stall the server.
- Every decision, allowed or not, is kept in a bounded in-memory log for the
  worker, with a digest of the arguments and a preview of at most 200
  characters, not the arguments themselves.
- The gate is a constant compiled into the server. Before each worker starts,
  it is written to a new private directory (mode 0700, file 0600) under the
  runtime directory (`$XDG_RUNTIME_DIR/worker-mcp`, or
  `$XDG_STATE_HOME/worker-mcp/run`) and passed to pi with `-e`. No persistent,
  user-writable copy is trusted. The directory is removed when the worker exits
  or is terminated.
- If the gate cannot be written, or is missing right before the spawn, the
  spawn is refused. pi is never started without it.
- pi is started with `--no-extensions --no-mcp --no-approve`: no discovered
  extensions, no MCP servers and no project-local files are loaded, so a
  repository cannot give the worker extra tools or code. The explicit `-e` gate
  still loads.
- The server does not read or write anything under `~/.pi`.

## What it does not protect

- **The risk classifier is a convenience, not a sandbox.** It is a rule-based
  filter on tool arguments that reduces what a worker does without being asked
  and keeps the coordinator in the loop for risky actions. Shell is too
  expressive for rules to be complete; do not rely on it to contain a hostile
  worker. An approved or auto-approved action runs with the full privileges of
  the worker process. Use a tighter policy for sensitive work, and run the
  server as a user that has nothing to lose.
- **A worker can always read its own LLM credentials.** pi needs them to work:
  its auth file under `HOME`, or a key passed in the environment. No gate or
  sandbox around a single process can stop it from sending that key out through
  an allowed call. Use a key with a narrow scope and spend limit.
- There is no process sandbox yet. Workers can read and write whatever the
  server's user can, subject to the gate.
- The gate's nonce is not a secret from the worker. It keeps stray or forged
  messages out of the gate dialog, but a tool that can read the worker's
  `/proc/<pid>/environ` can read it. The boundary against a hostile worker is a
  sandbox, not the nonce.

## Worker environment

A worker's environment is built from empty, not copied from the server. These
names are passed through when set:

| Group        | Names                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| basics       | `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LANGUAGE`, `LC_*`, `TZ`, `TERM`, `COLORTERM`, `NO_COLOR`             |
| temp and XDG | `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`                       |
| TLS and Nix  | `SSL_CERT_FILE`, `NIX_SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `NIX_PATH`, `NIX_PROFILES`, `LOCALE_ARCHIVE` |
| pi           | `PI_*`                                                                                                                    |

Everything else is dropped, including `GITHUB_TOKEN`, cloud credentials and
LLM keys.

### Extending it

Set `WORKER_MCP_ENV_PASSTHROUGH` in the server's environment to a
comma-separated list of names, or `PREFIX_*` patterns:

```bash
claude mcp add -e WORKER_MCP_ENV_PASSTHROUGH=ANTHROPIC_API_KEY,HTTPS_PROXY worker-mcp -- worker-mcp
```

You can also list names under `env.allow` in the JSON config file. Listing a
name is a deliberate decision to give the worker, and anything it reads, that
value.

### Never passed

These are dropped even if listed in `WORKER_MCP_ENV_PASSTHROUGH`:
`SSH_AUTH_SOCK`, `GPG_AGENT_INFO`, `*_TOKEN`, `*_SECRET*`, `AWS_*`,
`GOOGLE_APPLICATION_CREDENTIALS`, `KUBECONFIG`, `DOCKER_HOST` and
`WORKER_MCP_*`. A variable named `*_KEY` is not on this list, so an LLM key
such as `ANTHROPIC_API_KEY` can be passed through by name.

The one exception: a name written exactly, with no `*`, in the config file's
`env.allow` list is passed even if it matches a pattern above (for example a
`*_TOKEN` variable a worker really needs). Names from the environment variable
or a flag, and patterns from any source, never override the list.

### LLM credentials

pi reads its credentials from its own auth file under `HOME`, which workers
keep, so the usual setup needs nothing here. **Prefer the auth file.** Keys that
pi would otherwise find in the server's environment (for example
`ANTHROPIC_API_KEY`) no longer reach the worker; to use them, name them in
`WORKER_MCP_ENV_PASSTHROUGH`. As described above, the worker can read either.
