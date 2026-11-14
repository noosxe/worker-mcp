# Providers

worker-mcp is a runner over local coding agents. pi is the only one today. The
core owns runs, gating, process control and limits; a provider only translates
one agent's protocol. The interface is internal (`src/providers/types.ts`): the
registry is static and never loads a path from configuration, because that
would be code execution from a setting.

pi still runs through `PiSession` on the core's child handling. Moving it
behind the interface (and a new approval gate for it) is the next step.

## The seam

| Piece              | Where                                    | Role                                                                                                                                                               |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WorkerProvider`   | `src/providers/types.ts`                 | Describes an agent: capabilities, tool map, option schema, `check()`, `open()`.                                                                                    |
| `ProviderHost`     | `src/providers/types.ts`, `core/host.ts` | What the core hands a provider: `spawn`, `emit`, `requestApproval`, a private dir, a logger.                                                                       |
| `ProviderRegistry` | `src/providers/registry.ts`              | Static, keyed by id, filtered by an enabled list, lazy load. Refuses a provider that cannot gate unless it runs in the sandbox and the server allows it.           |
| `ChildRegistry`    | `src/core/child.ts`                      | The only place that starts worker processes.                                                                                                                       |
| `openWorker`       | `src/core/host.ts`                       | Opens a worker through a provider; when `open()` fails it kills whatever the provider started. `close()` stops the provider, kills its processes, removes its dir. |
| `FakeProvider`     | `src/providers/fake/`                    | An in-process provider scripted by the prompt, for core tests.                                                                                                     |

A provider never spawns on its own: it gives `host.spawn` a `ChildSpec` and
gets a `ManagedChild`. So the environment allowlist, process group, framing
caps and kill escalation cannot be skipped. `open()` resolves only once the
provider has proof its gate is active; otherwise it rejects and the core kills
the child. `requestApproval` never rejects: any failure is a deny.

## Child processes

`ChildRegistry.spawn` builds the environment from the allowlist (provider
extras are merged over it), starts the worker with `detached: true` (its own
process group) and returns a `ManagedChild`.

- **Framing.** Lines split on `\n` only. A stdout line over 8 MiB is dropped and
  reported as a problem, and the framer resynchronises at the next newline, so
  the buffer never grows past the cap. Stderr lines are cut to 1 KiB.
- **Writes.** `send` returns `false` and never throws once stdin is gone or more
  than 8 MiB is waiting; the write callback carries a later EPIPE. Handlers for
  `error` on all three pipes are attached before the first read or write.
- **Termination.** `terminate(graceMs)` is idempotent and resolves on the real
  exit:
  1. record the descendants of the worker (pid plus start time, so a recycled
     pid is never signalled);
  2. SIGTERM to the worker, because pi kills its own tracked bash children on
     SIGTERM;
  3. while waiting up to `graceMs` (default 3 s), keep recording descendants;
  4. SIGKILL to the worker's group, then to every recorded descendant that is
     still the same process. This reaches children in other groups.
- **Orphans.** The tree is also recorded every second while a worker runs, and
  when a worker exits by itself everything it left behind is killed. A process
  started and orphaned within that second is the one gap on a worker that dies
  on its own; the sandbox's pid namespace closes it.
- **Shutdown.** `terminateAll` ends every child in parallel. A repeated
  SIGINT/SIGTERM kills at once (`killAllNow`).

Bun differs in one place: a write to a pipe the child has closed is accepted
silently instead of failing with EPIPE. Nothing crashes either way, and the
process-tree tests pass on both runtimes (`pnpm run test:bun`).

## Paper check

Before the interface is frozen it was checked against three agents. pi is
implemented; the other two are on paper only, to find what the interface cannot
express.

### pi (`pi --mode rpc`)

| pi trait                                                           | Interface                                                                          |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| One persistent process, JSONL over stdio, prompt sent as a message | `persistentProcess: true`; the prompt goes through `ManagedChild.send`.            |
| `abort` message                                                    | `abort: "in-band"`.                                                                |
| Gate is an extension asking over `extension_ui_request`            | `requestApproval`. Several dialogs can be open at once: `parallelToolCalls: true`. |
| The extension can change a call's input                            | `mutateInput: true`.                                                               |
| Usage on `message_end`                                             | `usage: true`.                                                                     |
| `provider/id` model flag                                           | `models: "provider/id"`.                                                           |
| No signal that the gate loaded                                     | Readiness is part of `open()`: it waits for a proof and rejects without one.       |
| Bash commands run in their own process groups                      | Handled by the core's tree kill, not by the provider.                              |

### A planned second provider (one process per run)

Its traits, in neutral terms: one process per run with the prompt on the command
line, a JSONL control channel on stdin (gate responses and an in-band abort), a
`hello` record carrying a protocol version as the first output, gate requests
that arrive one at a time and carry a subagent origin, and allow/deny/mutate
decisions.

| Trait                                              | Interface                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prompt on the command line, stdin is control only  | `ChildSpec` carries argv and keeps stdin for JSONL. Nothing in the core assumes the prompt goes over stdin. The prompt is visible in the process list: log argv never.                                                                                                                           |
| One process per run                                | `persistentProcess: false`; `startRun` calls `host.spawn`. `WorkerHost` forgets processes that ended, so a long-lived worker does not collect handles.                                                                                                                                           |
| `hello` with a protocol version                    | **Gap found.** The first record only exists once a run's process is up, so `open()` cannot verify it. Gate readiness is then proven in `startRun`: it resolves only after a `hello` the provider accepts, and rejects (and terminates the child) otherwise. Documented on `WorkerProvider.open`. |
| One gate request at a time                         | `parallelToolCalls: false`.                                                                                                                                                                                                                                                                      |
| Subagent calls on the same channel, with an origin | **Gap found.** `RawToolCall.origin` had a depth and a parent call but no id for the subagent; `agentId` was added so the audit log can tell nested agents apart.                                                                                                                                 |
| Abort by killing today, in-band later              | `abort: "kill"` now, `"in-band"` later; `abortRun` terminates the run's `ManagedChild` or sends the message.                                                                                                                                                                                     |
| Resume by session id                               | `resume: true`; the id from the first records is `resumeToken()`.                                                                                                                                                                                                                                |
| Allow / deny with reason / mutate                  | `ApprovalDecision`. A provider that records proposed instead of executed arguments sets `mutateInput: false`; the gate then fails a mutate closed.                                                                                                                                               |
| Tools it spawns outlive the turn, in own groups    | The same case as pi's bash children: the core's tree kill and, later, the sandbox.                                                                                                                                                                                                               |

### The Claude Agent SDK

From the SDK's documented behaviour, not run here. It drives a long-lived
Claude Code process and asks for permission through a callback.

| SDK trait                                      | Interface                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canUseTool(name, input, { signal })` callback | The callback is `requestApproval(call, signal)`; the abort signal maps one to one. Concurrent callbacks: `parallelToolCalls: true`.                                                                                                                                                                                                                                                                                                                                              |
| Allow with `updatedInput`, deny with a message | `mutate` and `deny`: `mutateInput: true`.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `interrupt()`                                  | `abort: "in-band"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Session id and `resume`                        | `resume: true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Cost and token counts on result messages       | `usage: true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| It spawns its own process, over raw streams    | **Known gap, not closed.** `host.spawn` returns a JSONL `ManagedChild`, not a `ChildProcess`. The SDK can be given a custom spawn function, but it expects raw streams. A provider like this needs a second `stdio` mode (`"raw"`) on `ChildSpec`; it is not added until such a provider is built, since nothing else needs it. Until then it cannot run under the core's process control, so it is refused by the same fail-closed rule as any provider the core cannot manage. |
| Its own permission modes and settings files    | The provider must pin a mode that always calls the callback and ignore project settings, the same hardening pi gets with `--no-extensions`.                                                                                                                                                                                                                                                                                                                                      |

### Result

Two interface changes came out of the check (`origin.agentId`, per-run readiness
documented on `open`), one process-handling fix (forgetting ended children), and
one gap left open on purpose (raw streams).
