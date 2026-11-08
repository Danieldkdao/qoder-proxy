# Qoder OpenAI Proxy

A TypeScript OpenAI Chat Completions adapter for Qoder CLI, intended for a private Hermes Agent deployment. Hermes executes tools; the CLI runs with built-in tools disabled, no user/project settings, isolated temporary HOME/cwd, and no saved sessions.

The Mac Mini checkout is at `~/HermesSetup/qoder-proxy`. The installed automatic
startup bundle remains in Application Support, so moving this checkout does not
require restarting or rebuilding the running proxy. The old Desktop location
has been removed.

## Requirements and quick start

- Node.js 22.18+ (Node 24 recommended), pnpm **12.18.0**, and Qoder CLI **1.1.84**.
- A Qoder personal access token and sufficient account credits.

```sh
pnpm install --frozen-lockfile
# Authorize 1Password CLI access; this checkout already has your Environment ID.
pnpm test
pnpm run docker:build
pnpm run docker:start
pnpm run proxy:check
pnpm run hermes:test
```

Follow [the complete 1Password setup and environment-variable guide](docs/1password-setup.md). No application `.env` file is read. Every public package script uses `op run --environment umcywiy3b7hzpi2ln4zqrcywi4`; build/test/format subprocesses receive a minimal, non-secret environment. CI invokes the internal task runner directly and does not require 1Password credentials.

`pnpm test` (after authorizing 1Password CLI) builds the server and browser TypeScript before running Vitest. `pnpm run typecheck` checks types without emitting. `pnpm run format:check` checks formatting. `pnpm run dev` rebuilds the server/browser on changes and restarts the server. Generated JavaScript lives in ignored `dist/`; edit the `.ts` source.

## Docker

```sh
pnpm run docker:build
pnpm run docker:start
pnpm run docker:status
# Recreate with fresh secrets after a rotation or Docker/Mac restart:
pnpm run docker:restart
```

The secure launcher transmits an allowlisted payload over stdin. Secret values are not saved in Docker `Config.Env`, image layers, argv, or env files. The running process and Docker/host administrators still have access to runtime secrets. Automatic Docker restart is disabled because it cannot restore the in-memory payload without reauthorizing 1Password. See the setup guide for lifecycle and SSH details.

The image uses Node 24, installs CA certificates and the pinned CLI, and runs as the non-root `node` user. Supply secrets at runtime. Do not mount your home directory, Docker socket, or source tree into the proxy. The default Docker build does not copy `.env`, Git metadata, tests, or development output.

When Hermes runs on the same Mac as Docker, use `http://127.0.0.1:17843/v1`. From another container, use the proxy's service name on a private Docker network. For laptop access, SSH-forward the port rather than exposing it publicly.

## Hermes

Run `hermes model`, select a custom OpenAI-compatible Chat Completions endpoint, and enter:

```text
URL:   http://127.0.0.1:17843/v1
Key:   your PROXY_API_KEY
Model: auto
```

Use exact IDs from `/v1/models`. The proxy discovers your account catalog from Qoder and intersects it with the installed CLI's `--list-models` output. It caches results, refreshes expired catalogs in the background for model pickers, and validates chat requests against the same catalog. Historical aliases and retired IDs are not guessed or advertised. See [live discovery and Hermes Desktop](docs/model-discovery.md).

## API behavior and limits

- `POST /v1/chat/completions`: streaming/non-streaming text and validated function calls.
- `POST /v1/completions`: legacy text completions through the same inference path.
- `GET /v1/models`: live account/CLI-compatible OpenAI-format catalog; `X-Qoder-Model-Cache` reports `fresh` or `stale`.
- `GET /live`: HTTP process liveness.
- `GET /health`: CLI executable readiness and credential presence. This does **not** validate token freshness, model access, credits, or upstream availability.
- `POST /v1/embeddings`: explicitly unsupported (501).

Full supplied history is preserved, including system/developer messages and tool-call/result IDs. Inputs beyond the configured byte cap return 413; nothing is silently dropped. Non-text inputs, including images, return 400. Route vision and embeddings to another provider.

Tool-enabled requests expose the client’s JSON Schemas through a request-private native Qoder MCP bridge. The bridge records validated calls and ends the CLI turn; it never executes client functions or invents their results. Hermes executes the returned OpenAI-compatible `tool_calls` and supplies the actual results on the next request. Qoder’s built-in tools remain hidden. Schemas returned by a matching `tool_describe` result can be exposed on later turns, with calls forwarded through the client’s declared `tool_call` dispatcher.

Calls are checked against declared names and JSON Schemas. `tool_choice` (auto/none/required/named), streaming, and `parallel_tool_calls: false` remain supported. A complete raw or single JSON-fenced envelope is accepted as a compatibility fallback; prose examples and multiple fences are never executed. Model noncompliance returns a recognizable error. The CLI pin remains unchanged; compatibility depends on the selected model and should be verified with a real agent task. `/health` exposes a cumulative `nativeToolCalls` count for verification, without tool arguments.

The CLI only provides coarse output budgets through this adapter: `max_tokens`/`max_completion_tokens` may be 16000 or 32000 (mapped to CLI 16k/32k presets). Other limits, temperature, response-format constraints, and unknown options return 400 rather than being ignored. Token usage is unavailable and is never fabricated. A stream requesting `include_usage: true` receives an explicit final `usage: null` frame. Confirm your Hermes configuration's outgoing request options; auxiliary tasks needing unsupported options should use another provider.

Streaming emits normal text or indexed tool calls, normalized finish reasons, keepalives, and `[DONE]`. A failure after the stream opens arrives as an SSE `error` object; HTTP status cannot change after headers. CLI work is cancelled when the caller disconnects. On CLI exit, the supervisor waits for any in-flight native tool capture before cleaning up request files. Timeouts escalate SIGTERM to SIGKILL on Unix process groups. Windows process-tree termination is not validated; the supported deployment target is Linux Docker/macOS.

## Configuration

| Variable                      | Default        | Purpose                                                     |
| ----------------------------- | -------------- | ----------------------------------------------------------- |
| `PROXY_API_KEY`               | required       | Client Bearer secret; startup fails closed without it       |
| `QODER_PERSONAL_ACCESS_TOKEN` | none           | Qoder PAT (legacy alias `QODER_API_KEY`)                    |
| `HOST`                        | `127.0.0.1`    | Native bind address; image sets `0.0.0.0`                   |
| `PORT`                        | `3000`         | Listening port                                              |
| `QODERCLI_BIN`                | `qodercli`     | CLI executable path                                         |
| `QODER_TIMEOUT_MS`            | `120000`       | Active inference deadline                                   |
| `QODER_MAX_CONCURRENCY`       | `1`            | Concurrent CLI processes                                    |
| `QODER_MAX_QUEUE`             | `8`            | Queued requests (0 disables queuing)                        |
| `QODER_QUEUE_TIMEOUT_MS`      | `30000`        | Queue wait deadline                                         |
| `QODER_MAX_OUTPUT_TOKENS`     | `16k`          | Default CLI output budget (`16k` or `32k`)                  |
| `MAX_PROMPT_BYTES`            | `2097152`      | Serialized prompt cap                                       |
| `MAX_OUTPUT_BYTES`            | `4194304`      | Combined stdout/stderr cap                                  |
| `DASHBOARD_ENABLED`           | `true`         | Enable admin routes                                         |
| `DASHBOARD_PASSWORD`          | none           | Required for dashboard login                                |
| `SECURE_COOKIES`              | `false`        | Enable when serving dashboard over HTTPS                    |
| `DASHBOARD_SECRET`            | generated      | Session signing key; sessions are revoked at restart        |
| `PUBLIC_BASE_URL`             | browser origin | Optional canonical endpoint shown by dashboard              |
| `CORS_ORIGIN`                 | disabled       | Explicit permitted browser origin, if needed                |
| `LOG_PAYLOADS`                | `false`        | Opt-in request payload capture (may contain sensitive code) |
| `LOG_MAX_ENTRIES`             | `500`          | Maximum entries per log buffer                              |
| `LOG_BODY_MAX_BYTES`          | `8192`         | Per-payload UTF-8 byte cap                                  |

`ALLOW_UNAUTHENTICATED=true` explicitly permits a private, unauthenticated deployment. Do not enable it on an exposed listener. Numeric settings are validated at startup; negative values cannot disable resource limits.

## Dashboard

Visit `/dashboard/`, sign in, and use the endpoint reference, playground, request logs, and system logs. Dashboard chat uses session authentication; the browser never receives the API key. Sessions expire server-side, are revoked on logout/restart, and use HttpOnly/SameSite cookies. Login attempts are rate-limited. Content is escaped/rendered using DOM text APIs, with a restrictive CSP.

Logs are bounded and RAM-only. Payload capture is disabled by default. Memory statistics refer to the Node proxy, not its CLI child processes. Use Docker stats for total resource usage.

## Reading the code

1. `src/server.ts`: Express setup, auth boundaries, startup/shutdown.
2. `src/routes/chat.ts`: shared request validation and JSON/SSE protocol.
3. `src/helpers/format.ts`: lossless history and normalized responses. `src/helpers/modelCatalog.ts`: account discovery, CLI compatibility, cache and model validation.
4. `src/helpers/toolPrompt.ts`: tool instructions, JSON parsing, schema validation.
5. `src/helpers/spawn.ts`: admission queue, stdin, isolated subprocesses, output events and cancellation.
6. `src/middleware/`: Bearer auth, dashboard sessions and telemetry.
7. `src/store/logStore.ts`: bounded log buffers.
8. `src/dashboard/public/app.ts`: browser UI; static HTML/CSS accompany it.

## Verification

Tests were committed before implementation. The original 33-test contract baseline had **30 failures and 3 passes** at commit `c49b2ce`. The suite exercises real HTTP servers and subprocesses with a deterministic fake CLI, plus pure validation and lifecycle tests. Later runtime prerequisites were also recorded as failing tests before their fixes.

These tests do not call paid models or prove production quality for every Qoder model. Live Hermes acceptance requires your PAT and installed Hermes configuration. CLI and upstream behavior can change; test upgrades before updating the pinned version. See the dated [live model tool verification](docs/model-tool-verification.md) for per-model Hermes checks and observed limits.

CI runs tests before publishing AMD64/ARM64 images into the fork's own GHCR namespace. MIT license; retain the existing notice.

For automatic recovery after macOS login using a scoped 1Password service account and Keychain, see [automatic startup](docs/autostart.md).

Use `pnpm run qoder:check` for a read-only CLI release and QoDuck discovery check. See [availability checks and thinking efforts](docs/availability-and-reasoning.md) for per-model reasoning controls.

## Package manager

Use **pnpm 12.18.0**, pinned in `package.json`. Install with
`pnpm install --frozen-lockfile`; commit `pnpm-lock.yaml` when dependencies change.
Do not generate `package-lock.json` or use npm/yarn to install this project.
`pnpm-workspace.yaml` explicitly approves the required dependency build scripts;
review any new approvals instead of enabling all dependency scripts.
