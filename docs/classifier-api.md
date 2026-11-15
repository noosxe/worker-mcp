# Classifier API (provisional)

> **Provisional.** This is version `1-provisional` of the HTTP protocol between
> worker-mcp and an external classifier. It may change in incompatible ways
> until a real classifier has been checked against it; the version string and
> the `X-Worker-MCP-Classifier-API` header will change with it. Select it with
> `dialect: "worker-mcp-v1"` (the only dialect today).

An HTTP classifier is a service worker-mcp asks about a worker's tool call
**after** the built-in rules have decided to escalate it. It is how
`gate.mode: auto` works: the classifier allows or denies on its own when it is
sure, and anything else goes to the coordinator.

**A classifier is not a security boundary.** It decides which calls need the
coordinator, to keep that loop affordable. Hard limits (protected paths,
CRITICAL calls) are never sent to it and can never be allowed by it. See
[security.md](security.md).

## Privacy

Each request leaves the process: the tool name, the command, resolved paths and
up to 8 KiB of arguments (`maxArgumentBytes`), the working directory, summaries
of the last few decisions (`recentActions`) and, unless `sendIntent` is false,
the coordinator's one-line intent. Point it at a local or self-hosted service.
No classifier is configured by default.

## Request

`POST <url>` with:

- `Content-Type: application/json`, `Accept: application/json`
- `User-Agent: worker-mcp/<version>`
- `X-Worker-MCP-Classifier-API: 1-provisional`
- `Authorization: Bearer <token>`, only when the classifier has a `tokenFile`

```json
{
	"version": "1-provisional",
	"requestId": "g_1a2b3c4d5e6f",
	"action": {
		"kind": "shell",
		"tool": "bash",
		"provider": "pi",
		"arguments": { "command": "npm test" },
		"argumentsTruncated": false,
		"command": "npm test",
		"paths": [{ "path": "/abs/ws/src/x.ts", "inWorkspace": true }],
		"depth": 0
	},
	"context": {
		"cwd": "/abs/ws",
		"workerId": "w_k3j9a0b2",
		"runId": "r_01JD3W",
		"provider": "pi",
		"model": "provider/model",
		"intent": "Fix the failing date parser test in src/date.ts",
		"intentProvided": true,
		"recentActions": [
			{
				"kind": "read",
				"tool": "read",
				"summary": "src/date.ts",
				"verdict": "allow",
				"by": "rules"
			}
		],
		"ruleAssessment": {
			"riskLevel": "HIGH",
			"ruleId": "shell.installer",
			"reason": "runs project code"
		}
	}
}
```

- `kind` is `shell`, `read`, `list`, `search`, `write`, `edit`, `fetch`, `mcp`,
  `agent`, `task` or `other`.
- `arguments` is the tool's input. When it would exceed `maxArgumentBytes`
  (default 8192) long strings are cut and `argumentsTruncated` is `true`; the
  `command` is cut the same way.
- `recentActions` holds up to 10 summaries (120 characters each), oldest first.
  `by` is `rules`, `cache`, `http:<name>`, `coordinator`, `timeout` or `cancel`.
- `intent` is written by the coordinator, never by the worker, and is absent
  when `sendIntent` is false. `intentProvided` says whether one was given.
- Everything under `action` that came from the worker (commands, paths,
  arguments) is untrusted text: a prompt-injected worker can write it.
  Treat it as data.

## Response

`200` with JSON:

```json
{
	"requestId": "g_1a2b3c4d5e6f",
	"verdict": "allow",
	"confidence": 0.93,
	"reason": "Running the project's tests matches the task.",
	"riskLevel": "MEDIUM",
	"cacheTtlMs": 600000
}
```

| Field        | Rules                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------- |
| `requestId`  | Required. Must equal the request's.                                                       |
| `verdict`    | Required: `allow`, `deny` or `escalate`.                                                  |
| `confidence` | A number from 0 to 1. **Required for `allow` and `deny`.**                                |
| `reason`     | Required string, at most 1000 characters. Shown to the coordinator.                       |
| `riskLevel`  | Optional: `LOW`, `MEDIUM`, `HIGH` or `CRITICAL`. Informational.                           |
| `cacheTtlMs` | Optional positive integer: how long worker-mcp may reuse an `allow` or `deny`. See below. |

Unknown extra fields are ignored, so the API can grow additively. There is no
`mutate` verdict in this version.

### How worker-mcp uses it

- An `allow` needs `confidence >= minAllowConfidence` (default 0.85) and the
  rules' risk level must not exceed `gate.httpAllowCeiling` (default `HIGH`).
  A `deny` needs `confidence >= minDenyConfidence` (default 0.6). Otherwise the
  answer counts as `escalate`: the next classifier is asked, then the
  coordinator.
- `escalate` means "I am not sure": the coordinator decides.
- A decisive answer with a `cacheTtlMs` is cached for `min(cacheTtlMs,
  cache.maxTtlMs)` (10 minutes at most), per worker, for an identical call. An
  answer without it is not cached. A change of the worker's policy, or closing
  the worker, clears its entries.

### Failures

Anything other than a valid answer is a failure, and a failure never allows:

- a non-2xx status (a redirect is not followed), a connection error, no answer
  within `timeoutMs` (default 3 s), a body over 16 KiB, invalid JSON, a schema
  mismatch, a `requestId` that does not match, or a missing or out-of-range
  `confidence`.

The call then goes to the coordinator (`gate.onClassifierFailure: escalate`,
the default) or is denied (`deny`, for unattended runs). After 5 failures in a
row the classifier is skipped for 60 s, then one request is let through to see
whether it has recovered.

## Transport

- `https:`, or `http:` only for `localhost`, `127.0.0.1` and `[::1]`. Other
  schemes and URLs with credentials are refused when the configuration loads.
- No redirects are followed. No proxy environment variable is used.
- The token is read from a file (`tokenFile`), never from the environment or a
  tool argument, and never logged or written to the audit log. The file must be
  mode 0600 or stricter and owned by the user running the server; a symlink is
  judged by its target (so a sops-nix secret works). It is read at startup (a
  missing or insecure file stops the server with a clear message) and again on
  `SIGHUP`. A file that has become unusable at `SIGHUP` keeps the old token.

## Configuration

```json
{
	"gate": {
		"mode": "auto",
		"httpAllowCeiling": "HIGH",
		"onClassifierFailure": "escalate",
		"classifiers": [
			{
				"name": "local",
				"url": "http://127.0.0.1:8787/classify",
				"tokenFile": "/run/secrets/classifier_key",
				"dialect": "worker-mcp-v1",
				"timeoutMs": 3000,
				"minAllowConfidence": 0.85,
				"minDenyConfidence": 0.6,
				"maxArgumentBytes": 8192,
				"sendIntent": true,
				"breaker": { "failures": 5, "coolDownMs": 60000 }
			}
		]
	}
}
```

Only `name` and `url` are required for a classifier. Several classifiers are
asked in order; the first decisive answer wins. A worker's coordinator can turn
classifiers off for that worker with `policy.classifiers: "off"`.

A minimal conforming server (Node):

```js
import http from "node:http";
http
	.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const r = JSON.parse(body);
			res.setHeader("Content-Type", "application/json");
			res.end(
				JSON.stringify({
					requestId: r.requestId,
					verdict: "escalate",
					confidence: 0.5,
					reason: "no opinion",
				}),
			);
		});
	})
	.listen(8787, "127.0.0.1");
```
