# Contributor instructions

Read README.md for the architecture, API restrictions and runtime requirements.

- Write Vitest regression tests first, run them to record failure, then implement fixes.
- All application and browser source is strict TypeScript. Edit src/, never generated dist/.
- Run node scripts/tasks.mts test, node scripts/tasks.mts typecheck and node scripts/tasks.mts format:check before committing (CI is secret-free). Public npm scripts load the designated 1Password Environment.
- Hermes owns tool execution. Keep Qoder built-ins, external settings and session persistence disabled.
- Preserve complete history and tool/result IDs. Reject unsupported input explicitly.
- Stream failures as errors, never success text. Keep JSON/SSE generation on the shared path.
- Never expose credentials in the browser or capture prompts by default.
- Keep subprocess output, queues, timeouts, sessions and logs bounded.
- Pin and verify the CLI when upgrading. Tests use a fake CLI; do not claim live inference without a live test.

- Never reintroduce dotenv loading or put secrets in Docker args, Config.Env, image layers, files or logs. Use the stdin bootstrap and environment allowlist.
