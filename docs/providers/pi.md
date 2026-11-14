# The pi provider

`src/providers/pi/` runs `pi --mode rpc` behind the [provider interface](../providers.md).
Behaviour checked against pi 1.4.0.

| File                | Role                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------ |
| `provider.ts`       | `createPiProvider(config)`: `open()`, `check()`, and the worker handle.              |
| `argv.ts`           | The command line: `--mode rpc`, the hardening flags, `-e <gate>`, `--system-prompt`. |
| `gate-extension.ts` | The gate's source (a string constant), its file writer, and the wire helpers.        |
| `rpc.ts`            | Guards for the pi messages the provider reads.                                       |
| `tool-map.ts`       | pi's tool names and their argument keys, for the classifier.                         |

## Capabilities

Per-tool-call approvals, `mutate`, a persistent process, in-band abort, parallel
tool calls, usage, `provider/id` models. No resume.

## Starting a worker

1. The workspace must exist.
2. The gate is written to the worker's private directory (mode 0700, file 0600,
   never overwritten) from the constant compiled into the server, and read back.
   Nothing on disk is trusted as code. If it cannot be written, pi is not started.
3. A 128-bit nonce is generated and passed to pi in
   `WORKER_MCP_GATE_NONCE`, the one variable added over the allowlisted
   environment.
4. pi is started through the core with `--mode rpc --no-extensions --no-mcp
   --no-approve -e <gate>` (plus `--system-prompt` when given). The first removes
   discovered extensions, the second built-in MCP servers, the third
   trust-gated project files.
5. `open()` waits (20 s) for `extension_ui_request {method: "setStatus",
   statusKey: "worker-mcp-gate", statusText: "ready:<nonce>"}`. It rejects, and
   the core kills the process, when pi exits first (a missing or throwing `-e`
   file makes pi exit 1 before any output), when an `extension_error` names the
   gate, or on timeout. There is no way to get a running worker whose gate was not
   confirmed.
6. A model is set with the `set_model` command (`provider/id`; without a slash the
   provider is `ollama`).

## The gate (v3)

pi's `confirm` dialog answers only yes or no, so the reason of a rejection could
not reach the model. The gate uses `ctx.ui.input`, whose reply is a string:

- request (the dialog's `placeholder`): `{"v":3,"nonce":…,"toolName":…,"input":{…}}`
  under the title `worker-mcp-gate/v3`;
- reply (`value`): `{"v":3,"nonce":…,"decision":"allow"}`,
  `{…,"decision":"deny","reason":"…"}` or `{…,"decision":"mutate","input":{…}}`.

The gate blocks the call, with a fixed reason, on a cancelled dialog, a reply that
is not JSON, a wrong version or nonce, an unknown decision, a mutate without an
input, or any error. It allows only an explicit `allow`, and rewrites the input in
place only for a `mutate` with an object. The server in turn answers a request
with a wrong or missing nonce with a cancel (which blocks), and logs it.

Each dialog has its own id and is decided on its own, so two calls in flight do
not overwrite each other, and may be answered in any order.

The nonce is read once and removed from `process.env` inside pi, so processes pi
starts afterwards do not inherit it. It is not a secret from a worker that can
read `/proc/<pid>/environ`; see [security.md](../security.md).

## Other dialogs

A `select`, `confirm`, `editor` or `input` dialog that is not the gate's is
answered with cancel at once, and a warning is logged. Notifications become
notices; other fire-and-forget requests are ignored.

## Events and runs

| pi                              | Provider event                                                         |
| ------------------------------- | ---------------------------------------------------------------------- |
| `response` to `prompt`          | `startRun` resolves (or rejects with pi's error)                       |
| `agent_start`                   | `run_started`                                                          |
| `message_update` text delta     | `text_delta`                                                           |
| assistant `message_end`         | `assistant_message` with text and usage                                |
| `tool_execution_start` / `_end` | `tool_started` / `tool_finished` (preview capped at 2 KiB)             |
| `agent_settled`                 | `run_finished` (`aborted` if an abort was requested, else `completed`) |
| process exit                    | `exited`; an active run first ends with `run_finished` outcome `error` |

A run is over at `agent_settled`, not `agent_end`: pi can retry or run queued work
after `agent_end`. An unexpected exit is a run error, never a silent finish.

## Abort and close

`abortRun` is idempotent: while one is in flight a second call shares it. Pending
gate dialogs are denied first, then `{"type":"abort"}` is sent once. If the run
has not settled after 2 s the worker is stopped (SIGTERM, then SIGKILL of its
whole process tree) and the run ends as aborted. `close` aborts any run and stops
the process the same way.

## Not verified without a model

The `tool_call` hook itself against a real pi (mutation of `event.input`, a
throwing handler blocking the tool), and that the removed nonce variable is
invisible to the tools pi starts later. The gate fails closed on everything it
cannot parse, and `open()` fails without the ready status, so neither gap can
leave a call ungated by a malformed reply; they could only make the gate stricter
than intended.

## Not done yet

`--no-session` and a `--model` flag instead of `set_model` are in the design but
change what pi writes or how a bare model name is read, which cannot be checked
without a model call.
