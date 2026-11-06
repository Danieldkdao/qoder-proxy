# Qoder OpenAI Proxy

A TypeScript OpenAI Chat Completions adapter for Qoder CLI, intended for a private Hermes Agent deployment. Hermes executes tools; the CLI runs with built-in tools disabled, no user/project settings, isolated temporary HOME/cwd, and no saved sessions.

## Requirements and quick start

- Node.js 22.18+ (Node 24 recommended), npm, and Qoder CLI **1.1.84**.
- A Qoder personal access token and sufficient account credits.

```sh
npm ci
npm test
cp .env.example .env
# Edit .env: set QODER_PERSONAL_ACCESS_TOKEN and a strong PROXY_API_KEY.
npm start
```

`npm test` builds the server and browser TypeScript before running Vitest. `npm run typecheck` checks types without emitting. `npm run format:check` checks formatting. `npm run dev` rebuilds the server/browser on changes and restarts the server. Generated JavaScript lives in ignored `dist/`; edit the `.ts` source.

## Docker

```sh
docker build -t qoder-proxy:local .
docker run -d --name qoder-proxy --restart unless-stopped \
  -p 127.0.0.1:3000:3000 --env-file .env qoder-proxy:local
```

The image uses Node 24, installs CA certificates and the pinned CLI, and runs as the non-root `node` user. Supply secrets at runtime. Do not mount your home directory, Docker socket, or source tree into the proxy. The default Docker build does not copy `.env`, Git metadata, tests, or development output.

When Hermes runs on the same Mac as Docker, use `http://127.0.0.1:3000/v1`. From another container, use the proxy's service name on a private Docker network. For laptop access, SSH-forward the port rather than exposing it publicly.

## Hermes

Run `hermes model`, select a custom OpenAI-compatible Chat Completions endpoint, and enter:

```text
URL:   http://127.0.0.1:3000/v1
Key:   your PROXY_API_KEY
Model: auto
```

Use actual Qoder identifiers. `/v1/models` is a static convenience catalog, not account-scoped discovery. Availability depends on your CLI/account. Native IDs include `auto`, `ultimate`, `performance`, `qmodel`, `kmodel`, `mmodel`, `dmodel`, `dfmodel`, `gm51model`. Friendly aliases such as `qwen` and `deepseek` resolve explicitly. Unknown IDs are rejected; GPT/Claude names are not advertised as models.

## API behavior and limits

- `POST /v1/chat/completions`: streaming/non-streaming text and validated function calls.
- `POST /v1/completions`: legacy text completions through the same inference path.
- `GET /v1/models`: supported static identifiers.
- `GET /live`: HTTP process liveness.
- `GET /health`: CLI executable readiness and credential presence. This does **not** validate token freshness, model access, credits, or upstream availability.
- `POST /v1/embeddings`: explicitly unsupported (501).

Full supplied history is preserved, including system/developer messages and tool-call/result IDs. Inputs beyond the configured byte cap return 413; nothing is silently dropped. Non-text inputs, including images, return 400. Route vision and embeddings to another provider.

Tool calling is **prompt emulation**, not native inference tool calling. The model must return a complete JSON tool envelope, not prose containing a JSON example. Calls are checked against declared names and JSON Schemas. Multiple calls, `tool_choice` (auto/none/required/named), and `parallel_tool_calls: false` are supported. Model noncompliance returns a recognizable error rather than executing an invented function.

The CLI only provides coarse output budgets through this adapter: `max_tokens`/`max_completion_tokens` may be 16000 or 32000 (mapped to CLI 16k/32k presets). Other limits, temperature, response-format constraints, and unknown options return 400 rather than being ignored. Token usage is unavailable and is never fabricated. Confirm your Hermes configuration's outgoing request options; auxiliary tasks needing unsupported options should use another provider.

Streaming emits normal text or indexed tool calls, normalized finish reasons, keepalives, and `[DONE]`. A failure after the stream opens arrives as an SSE `error` object; HTTP status cannot change after headers. CLI work is cancelled when the caller disconnects. Timeouts escalate SIGTERM to SIGKILL on Unix process groups. Windows process-tree termination is not validated; the supported deployment target is Linux Docker/macOS.

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
3. `src/helpers/format.ts`: lossless history, model IDs, normalized responses.
4. `src/helpers/toolPrompt.ts`: tool instructions, JSON parsing, schema validation.
5. `src/helpers/spawn.ts`: admission queue, stdin, isolated subprocesses, output events and cancellation.
6. `src/middleware/`: Bearer auth, dashboard sessions and telemetry.
7. `src/store/logStore.ts`: bounded log buffers.
8. `src/dashboard/public/app.ts`: browser UI; static HTML/CSS accompany it.

## Verification

Tests were committed before implementation. The original 33-test contract baseline had **30 failures and 3 passes** at commit `c49b2ce`. The suite exercises real HTTP servers and subprocesses with a deterministic fake CLI, plus pure validation and lifecycle tests. Later runtime prerequisites were also recorded as failing tests before their fixes.

These tests do not call paid models or prove production quality for every Qoder model. Live Hermes acceptance requires your PAT and installed Hermes configuration. CLI and upstream behavior can change; test upgrades before updating the pinned version.

CI runs tests before publishing AMD64/ARM64 images into the fork's own GHCR namespace. MIT license; retain the existing notice.
