# DeepSeek Harness Retry

Configurable automatic retries and interrupted-session recovery for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The plugin handles model failures that are often successful when the same request is tried again. It joins the Host `agent/request-error` waterfall, lets DSH's built-in recovery policies decide first, and then applies a bounded exponential-backoff fallback for configured provider-neutral error codes.

## Features

- Handles generic `PI_AI_ERROR`, `UNKNOWN`, and other configured transient model failures.
- Retries up to **2 times** after the original request by default.
- Retries explicit Codex `servers are currently overloaded` failures up to **5 times** with a longer delay.
- Exponential backoff with jitter and provider `Retry-After` support.
- Exact provider-route allowlists and denylists.
- Abort-aware waits that stop on user cancellation or plugin disposal.
- Defers to adapter-owned and built-in DSH recovery before applying its fallback budget.
- Emits standard non-surface `llm/retry` and `llm/retry-started` session events.
- Can safely continue only provably unfinished work after a DSH crash or restart.
- Never removes, reorders, or replaces an existing durable inbox item.

Retry errors and delays are not added to model-visible history. Every retry is a new provider request and may incur additional usage charges.

## Requirements

- Node.js 20 or newer.
- DeepSeek Harness `0.1.0-rc.7+` or `0.1.1-rc.2+`.
- The built-in `@deepseek-ai/dsh-llm-retry` plugin. Do not remove it; this plugin extends rather than replaces its policies.
- pnpm/Corepack only when developing from source.

This is a Host plugin. It has no browser connection step and requires no plugin-specific environment variables.

## Install

Install the published package into a profile:

```bash
dsh plugin --profile web add @syncended/dsh-retry
```

Some pnpm-backed profiles require the workspace-root flag:

```bash
dsh plugin --profile web add -w @syncended/dsh-retry
```

Install the current `trunk` branch from GitHub only for development or testing:

```bash
dsh plugin --profile web add github:syncended/deepseek-harness-retry
```

The package declares a DSH bundle, so the CLI inserts the Host plugin as `model-error-retry`; no manual plugin entry is required. Restart the selected DSH profile after installing or upgrading.

To remove it:

```bash
dsh plugin --profile web remove @syncended/dsh-retry
```

> Current DSH releases already retry `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, and `TRANSPORT` through `@deepseek-ai/dsh-llm-retry`. That adapter-owned normal/always policy always runs first. The fallback defaults here primarily cover generic model failures such as `PI_AI_ERROR` and do not widen a built-in policy's retry budget.

## Configuration

The defaults apply immediately after installation. To customize them, edit the existing `model-error-retry` row in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`; do not add a duplicate row with the same id.

```yaml
- id: model-error-retry
  config:
    maxRetries: 3
    overloadMaxRetries: 5
    retryableCodes:
      - PI_AI_ERROR
      - UNKNOWN
      - STREAM_CLOSED
      - EMPTY_RESPONSE
      - RATE_LIMIT
      - SERVER
      - TIMEOUT
      - TRANSPORT
    initialDelayMs: 750
    overloadInitialDelayMs: 2000
    maxDelayMs: 15000
    jitterRatio: 0.15
    respectRetryAfter: true
    resumeInterrupted: true
    resumeDisposed: false
    resumeMaxAgeMs: 86400000
    resumePrompt: >-
      DeepSeek Harness stopped before the previous task produced a complete final
      assistant response, or before a scheduled retry started. Continue the unfinished
      work from the durable session history. Re-check the current workspace and
      external state before acting. Do not blindly repeat tool calls that may have side
      effects; verify their outcome first.
    providers:
      - openai
      - openrouter
    excludeProviders: []
```

Restart the Host after changing this file.

| Option | Default | Description |
| --- | ---: | --- |
| `maxRetries` | `2` | Retries after an ordinary original failure. `0` disables request-error retries but not `resumeInterrupted`. |
| `overloadMaxRetries` | `5` | Retries for `PI_AI_ERROR` with an explicit overload message. |
| `retryableCodes` | see below | Exact provider-neutral codes. `*` matches any request error. |
| `initialDelayMs` | `500` | Initial ordinary exponential-backoff delay. |
| `overloadInitialDelayMs` | `2000` | Initial explicit-overload delay. |
| `maxDelayMs` | `10000` | Maximum local delay. A larger `Retry-After` leaves the failure terminal. |
| `jitterRatio` | `0.1` | Symmetric jitter ratio from `0` to `1`. |
| `providers` | `[]` | Exact provider-route allowlist; empty allows all routes. |
| `excludeProviders` | `[]` | Exact provider-route denylist; takes precedence over the allowlist. |
| `respectRetryAfter` | `true` | Honor provider `Retry-After` when it does not exceed `maxDelayMs`. |
| `resumeInterrupted` | `true` | On cold resume, continue an unmatched plugin retry, a model step with no assistant message, or a durably closed tool boundary before its next model step. |
| `resumeDisposed` | `false` | Also accept `aborted/disposed` as an unfinished retry. Disabled because HMR and intentional teardown can produce this reason. |
| `resumeMaxAgeMs` | `86400000` | Oldest pending retry eligible for automatic continuation; 24 hours by default. |
| `resumePrompt` | built in | Model-visible safety instruction for a confirmed interrupted continuation. |

Default fallback retry codes:

```text
STREAM_CLOSED, MALFORMED_RESPONSE, PI_AI_ERROR, API_ERROR, MODEL_ERROR,
INTERNAL_ERROR, PROVIDER_ERROR, UNKNOWN
```

Permanent failures such as `AUTH`, `INVALID_REQUEST`, `MISSING_CREDENTIAL`, `UNKNOWN_MODEL`, and context overflow are not retried by default. Add an exact code or `*` only after considering cost and repeated side effects.

### Validation rules

- Retry counts must be non-negative safe integers.
- `initialDelayMs` and `overloadInitialDelayMs` must not exceed `maxDelayMs`.
- `jitterRatio` must be between `0` and `1`.
- `retryableCodes` cannot be empty while request-error retries are enabled.
- `resumePrompt` cannot be empty when interrupted-session recovery is enabled.
- Provider filters compare exact route strings; they are not regular expressions or prefixes.

## How request retries work

1. The agent loop receives a terminal model request failure.
2. The plugin calls the next handler in the `agent/request-error` waterfall.
3. If a built-in handler already returns `{ kind: "retry" }`, that decision is returned unchanged.
4. Otherwise, the plugin checks the provider route, failure code, and local budget.
5. It appends `llm/retry` to the session log and waits through abort-aware backoff.
6. It appends `llm/retry-started` and returns `{ kind: "retry" }`; DSH rebuilds the request from durable history.

Partially received chunks are excluded from the next model-visible request because retry happens at the closed request-error boundary.

## Recovery after a DSH restart

1. After `llm/retry`, the plugin requests a persistence checkpoint before backoff. If checkpoints are unavailable, the live retry proceeds but restart recovery for that attempt is best-effort.
2. After a crash, DSH persistence balances an open tail with synthetic tool errors, `step/end`, and `turn/end` events whose reason is `interrupted`.
3. When Web/API later resumes the cold session through `agents.resume`, the plugin accepts one of three durable proofs: its own `llm/retry` without `llm/retry-started`; the latest crash-interrupted model step containing durable user input but no `assistant/message`; or a tool-calling assistant message for which every call has a durable real or synthetic result and no next model step started.
4. A completed text-only assistant message, manual `aborted/user` interrupt, tool call missing any durable result, foreign policy key, already-started retry, subagent, or existing inbox item fails closed. `aborted/disposed` also fails closed by default.
5. Detection and enqueue run inside `agent.runMaintenance()` with the exact live Agent checked again.
6. Only an empty inbox receives one deterministic model-visible continuation notice, which opens a new turn over the persisted history.

A provider stream and old JavaScript promise cannot survive a process restart. Recovery is therefore a semantic continuation in a new turn, not a continuation of the same response bytes. The plugin does not scan and launch archived sessions at startup; it checks lazily when a session is reattached.

## Observability and troubleshooting

Retries appear as `llm/retry` and `llm/retry-started` entries in the durable session log and as Host warning logs. If a request is not retried:

1. Confirm the package is installed in the active profile and the Host was restarted.
2. Inspect the failure's provider-neutral code and provider route.
3. Check `retryableCodes`, `providers`, and `excludeProviders` for an exact match.
4. Check whether built-in recovery already consumed the decision or the local retry budget was exhausted.
5. Check whether `Retry-After` exceeded `maxDelayMs`.

There is no dedicated UI, so a screenshot would not add useful setup information; session events and Host logs are the authoritative diagnostics.

## Development

```bash
pnpm install
pnpm check
npm pack --dry-run
```

Tag-driven npm publication is documented in [`RELEASING.md`](./RELEASING.md).

## License

MIT — see [`LICENSE`](./LICENSE).
