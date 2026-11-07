# Verification record

Reviewed and updated on 2026-11-06. Original source: `b6facd03`.

## Test-first evidence

- `c49b2ce`: regression contracts committed before implementation. Running them against the original JavaScript produced **30 failures and 3 passes**.
- `d05220e`: strict TypeScript migration and first passing 33-test baseline.
- `8c8f358`: runtime-isolation and container prerequisite tests added before their fixes; two tests failed initially.
- `767c43b`: shutdown escalation regression committed while failing, before its implementation.

Streaming usage negotiation was also tested while failing before its fix at `37f3163`. Additional tests cover a complete HTTP tool-call/result/final-answer exchange and runtime edge cases. The fake CLI is a deterministic subprocess fixture; tests do not substitute mocked Express responses for the HTTP integration coverage.

## Final local checks

- **43 Vitest tests pass** on macOS with Node 26.
- **43 Vitest tests pass** inside the Linux Node 24 Docker build stage.
- Strict type checks pass for server, browser, build scripts and tests.
- Prettier checks and `git diff --check` pass.
- `npm audit` reports **zero vulnerabilities** in the installed lockfile.
- The production Docker image builds, runs as `node`, and contains Qoder CLI **1.1.84**.
- Production-image smoke checks pass for readiness, final-answer streaming with tools enabled, validated tool calls, unauthorized access rejection, and browser bundle delivery. These use an injected fake CLI, not a paid upstream call.
- The actual pinned CLI's help/version commands run successfully; its output format, tool restriction, settings-source and session-persistence options were inspected.

The test build stage retains development dependencies; the production-dependencies stage prunes them before the runtime image is assembled. Test fixtures were copied into disposable containers to avoid host bind-mount restrictions. Temporary verification containers were removed.

## Remaining external verification

No Qoder PAT was configured in the checkout/environment. Consequently, authenticated Qoder inference, account/model availability, credit usage, and a live Hermes session were **not** verified. Configure the PAT locally and follow README.md to perform that acceptance test. Do not commit credentials.

Tool calling remains model-dependent prompt emulation. Unsupported parameters and non-text inputs now fail explicitly; consult README.md before routing Hermes auxiliary/vision workloads through this provider. Passing deterministic tests is not a guarantee that every upstream model will follow the tool protocol.

## 1Password deployment workflow

The 1Password-only deployment was developed from failing tests in `c9229dc`. Physical dotenv loading was removed. Every public npm command uses the supplied Environment ID; CI uses secret-free internal tasks.

- 51 standard Vitest tests pass; three additional Docker integration tests pass when explicitly enabled.
- The read-only, non-root Docker container authenticates with stdin-injected credentials. Synthetic secrets are absent from saved Docker metadata, container logs and new exec environments.
- The actual installed Hermes CLI completed a tool-call/result/final-answer exchange against a fixture-backed Docker proxy. A temporary proof file confirmed actual Hermes terminal execution. Profile cleanup was also verified.
- The production target was confirmed to be the Mac Mini.

Fixture-backed checks do not authenticate to Qoder or spend credits. Live-account acceptance is recorded separately once 1Password authorization and the real PAT have been verified.

### Live acceptance on the Mac Mini

The supplied 1Password Environment authorized successfully. The production container started through the stdin bootstrap. An authenticated real-Qoder function-call/result/final-answer test passed, followed by a real Hermes terminal-tool acceptance test with a verified temporary proof file. No raw credential values were displayed. Production inspection confirmed a non-root user, read-only filesystem, loopback-only publication, restart policy `no`, and no saved credential keys in Docker Config.Env. An initial Hermes acceptance attempt did not pass; a later attempt completed successfully. Tool adherence remains model-dependent, and redacted diagnostics now identify known failure categories without printing raw subprocess output.
