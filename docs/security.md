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
  MEDIUM, at most HIGH) bounds what `spawn_worker` and `set_risk_policy`
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
- pi is started with `--no-extensions --no-mcp --no-approve --no-session`: no discovered
  extensions, no MCP servers and no project-local files are loaded, so a
  repository cannot give the worker extra tools or code. The explicit `-e` gate
  still loads. `--no-session` keeps pi from saving the worker's conversation
  under its own session directory.
- The server does not read or write anything under `~/.pi`.

## The workspace sandbox

The gate reduces what a worker does without being asked. Only a sandbox
reduces what it _can_ do. `sandbox: "workspace"` runs the worker process
(`pi` and every tool it starts) inside [bubblewrap](https://github.com/containers/bubblewrap)
on Linux:

| Inside the sandbox                                                       |                                                                                                                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The whole filesystem                                                     | read-only                                                                                                                                                    |
| The workspace (`cwd`, by its real path)                                  | read-write                                                                                                                                                   |
| `/tmp`                                                                   | an empty private tmpfs                                                                                                                                       |
| `$HOME` and other paths to the same data                                 | an empty tmpfs: `~/.ssh`, `~/.gnupg`, `~/.aws`, browser profiles and other repositories are not there (see below)                                            |
| `$XDG_RUNTIME_DIR`                                                       | an empty tmpfs: the user's agent sockets (ssh, gpg) are not reachable                                                                                        |
| The agent's own config (pi: `~/.pi`) and Nix profiles (`~/.nix-profile`) | read-only, put back over the empty home                                                                                                                      |
| pi's `~/.pi/agent`                                                       | a throwaway writable layer over the read-only files (pi takes a lock file there even to read its settings); nothing written there reaches the real directory |
| The worker's private directory (holds the gate)                          | read-only                                                                                                                                                    |
| `sandbox.extraRo`, `sandbox.extraRw`                                     | read-only, read-write                                                                                                                                        |
| Process, IPC and hostname namespaces                                     | new: the worker sees only its own processes                                                                                                                  |

- **Cleanup is airtight.** The sandbox dies with the server (`--die-with-parent`
  and a PID namespace): even if the server is killed with SIGKILL, the worker
  and every process it started, in any process group, are killed. `--new-session`
  stops a worker from injecting keystrokes into the server's terminal.
- **Protected paths are read-only inside the workspace too**, as a second line
  behind the gate's hard limits: `.git/hooks`, `.git/config`, `.claude`,
  `.mcp.json`, `.envrc`, `.husky`, `.pi` and the `.env*` files in the
  workspace root, when they exist. A protected path that does not exist yet is
  left to the gate (the sandbox would have to create it), and so is a `.env`
  below the root. The list is the one the gate uses.
- **Git worktrees.** When `cwd` is a linked worktree (its `.git` is a file),
  the repository's git directory is outside the workspace; the sandbox mounts
  it read-write so `git commit` works, with its `hooks` and `config` read-only.
  The `.git` file is writable by a worker, so it is not trusted: the directory
  must look like a git directory and point back at this workspace, otherwise
  the worker gets nothing. A subdirectory of a repository, and a submodule, get
  a read-only `.git`; the main checkout's files are never mounted.
- **Symlinked workspaces** are mounted by their real path.
- **Other paths to the home directory are hidden as well.** With the whole
  filesystem mounted, hiding `$HOME` alone would leave its data reachable
  wherever else it is mounted: `/persistent/home/<user>` behind a `/home` bind
  on a system with impermanence, a bind of single directories such as `~/.ssh`,
  a device mounted twice. The server reads `/proc/self/mountinfo`, finds every
  other mount point that leads to the home directory's data, keeps those that
  are really the same directory (device and inode) and puts an empty tmpfs on
  them, before the workspace and the other mounts, so a workspace below one is
  still mounted. If the mounts cannot be read, the sandbox counts as
  unavailable rather than risk leaving the home exposed. Anything the
  detection misses can be listed in `sandbox.hide`.

### What it does not do

- **The network is not restricted.** A worker needs it to reach its model API,
  and a namespace around `pi` cannot tell `pi`'s own calls from its tools'.
  Whatever the worker can read, it can send out.
- **The worker can still read its own API key**: `pi` needs its auth file, which
  stays visible (read-only), and the key may be in its environment.
- **The workspace is writable**, and so is everything in it that is not
  protected: build scripts, `package.json` scripts and git history can be
  changed. Review what a worker leaves behind before running it.
- **Everything outside `$HOME` and the runtime directory stays readable**
  (read-only) through the root mount: other directories on persistent storage
  (`/persistent` beyond the home), `/etc`, `/var`, other users' files the
  server user can read. Only the home directory, its other paths and
  `sandbox.hide` are hidden. Put data that must stay out of reach under
  `$HOME` or list it in `sandbox.hide`.
- System sockets that are not in the user's runtime directory (a container
  runtime's socket, the system D-Bus) are reachable, because the root is
  mounted read-only, not hidden. A read-only bind does not stop a worker from
  using a socket.
- It is not a defence against a kernel or bubblewrap bug, nor against a
  malicious `pi` binary.
- **Linux only.** macOS has no sandbox: `sandbox.minimum` must stay `none`
  there (a `workspace` minimum would make every spawn fail), and workers run
  with the gate and the environment allowlist alone.

### Settings

- `sandbox.minimum` (`none` or `workspace`, default `none`): `spawn_worker`
  cannot ask for less; a lower request is raised and reported in `clamped`.
- `sandbox.default`: what a spawn gets when it asks for nothing. Default:
  `workspace` when the sandbox works, otherwise `none`.
- When the sandbox does not work: with minimum `workspace` the spawn fails with
  `SANDBOX_UNAVAILABLE`; with minimum `none` the worker runs unsandboxed and the
  spawn result says so in `notes`. `list_providers` shows `sandbox: {available,
  reason, minimum, default}`.
- `sandbox.extraRo`, `sandbox.extraRw`: absolute paths to mount, for tools or
  caches the worker needs. Paths that do not exist are skipped.
- `sandbox.hide`: absolute paths always hidden behind an empty tmpfs, for
  other ways to the home directory's data that detection misses (skipped when
  they do not exist).
- `sandbox.bwrapPath`, else `WORKER_MCP_BWRAP`, else `bwrap` on `PATH`. The Nix
  package sets `WORKER_MCP_BWRAP` to its own bubblewrap.
- At startup the server runs bubblewrap once with a trivial command to check that
  unprivileged user namespaces work (some systems turn them off, for example
  through an AppArmor profile or a sysctl) and remembers the result.

A `pi` binary, its configuration and the workspace are the only places a worker
sees under `$HOME`. If `pi` is installed under `$HOME` (for example
`~/.local/bin/pi`), add that directory to `sandbox.extraRo`.

## Auto mode and classifiers

`gate.mode: auto` sends calls the rules escalate to an external HTTP classifier
before the coordinator (see [classifier-api.md](classifier-api.md), provisional).
It does not change what is protected:

- Hard limits and CRITICAL calls are never sent to a classifier and can never
  be allowed by it. A classifier's `allow` needs confidence of at least 0.85
  and a risk level up to `gate.httpAllowCeiling` (default HIGH, never CRITICAL).
  Failure means escalate (or deny with `gate.onClassifierFailure: deny`), never
  allow. A classifier that is down, slow or answers wrongly is skipped by a
  circuit breaker.
- Transport: https, or http on loopback only; no redirects; no proxy variable;
  3 s timeout; responses over 16 KiB refused. The bearer token comes from a
  file that must be mode 0600 or stricter and owned by the server's user, and
  never from the environment, tool arguments, logs or the audit file. The token
  file is a protected path workers cannot read without approval.
- Commands, paths and up to 8 KiB of arguments leave the process. Use a local
  or self-hosted classifier.
- `approve_action` with `remember: "worker"` allows identical later calls from
  one worker. It is refused for hard limits, protected paths and CRITICAL calls.
- Every decision is appended to an audit file (mode 0600, in the protected
  state directory, rotated): digests and short previews, no full arguments.

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
- Without the sandbox (`sandbox: "none"`, or on macOS) a worker can read and
  write whatever the server's user can, subject to the gate. See
  [The workspace sandbox](#the-workspace-sandbox) for what `workspace` changes
  and what it leaves open.
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
