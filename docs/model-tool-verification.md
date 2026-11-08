# Qoder model tool verification — 2026-11-07

This is a dated acceptance snapshot, not a runtime model allowlist. Model names came from the live account catalog intersected with the pinned CLI listing. The proxy continues to discover models dynamically.

The Mini kept OpenAI Codex (`gpt-6.1-sol-900k`) as the main Hermes provider. Every test selected the named `qoder` provider only for its disposable task. The CLI remained **1.1.84**; the existing pnpm pin and dependencies were unchanged. Sonus (`smodel`) was explicitly excluded. Testing Auto/Ultimate/Fast/Efficient pools was separately approved; their underlying routing is not disclosed by this catalog.

## Availability changed during verification

Twelve additional entries completed the checks below before Qoder changed the account catalog. At the end, an independent direct account API request marked every non-Sonus entry `is_enabled: false`, and the pinned CLI listed only Sonus. A fresh proxy catalog reflected that same list. Consequently, post-deployment requests for the earlier Cantus/Qwen display names were rejected at catalog validation; the working-model control could not run. The successful rows below are earlier test results, not a claim those models remain usable now. The user subsequently confirmed that the Qoder account had run out of credits. The API itself did not identify that cause. Sonus inference was never tested, and disabled models were not forced back into the catalog.

## Live Hermes checks

Each fresh task used the real main-profile Hermes tools to read a random fixture; discover and describe Socket's live schema; invoke its configured `depscore` tool; write the fixture with quotes, Unicode and embedded newlines; execute a Python equality/nonce check in the terminal; send a midpoint notice; and invoke `kanban_complete`. Completion messages alone did not count: native task status, stored tool results, the parsed output data and the terminal's exit code/nonce were independently checked.

| Model or pool      | Result                 |
| ------------------ | ---------------------- |
| Auto               | Passed                 |
| Ultimate           | Passed                 |
| Fast               | Passed                 |
| Efficient          | Passed                 |
| Cantus             | Incomplete — see notes |
| Qwen3.8-Max        | Passed                 |
| Kimi-K3.1-Pro      | Passed                 |
| Kimi-K2.8-Preview  | Passed                 |
| GLM-5.3            | Passed                 |
| GLM-5.3-Flash      | Passed                 |
| DeepSeek-V4-Pro    | Passed                 |
| DeepSeek-Flash     | Passed                 |
| MiniMax-M3.1-Flash | Passed                 |

Qwen3.8-Flash had already passed the same real main-profile file/Socket/terminal/completion path in the preceding native-bridge verification. The table records the other available entries. These are bounded text/tool checks, not certification of every thinking level, tool, concurrent workload or future model revision. The Air's Desktop UI was not operated for this run.

## Fix and observed limits

- `f1a123b` fixes a native capture shutdown race: an overlapping polling tick could replace the pending file-read promise with a completed no-op. A fast CLI exit could then return before the tool request was captured and delete its request directory. The regression held the read pending, observed the incorrect early settlement before the fix, then passed after preserving the active read promise. The supervisor now waits before cleanup.
- Cantus' initial six-minute task was stopped by its task runtime cap after the data and Socket checks succeeded. Its fresh twelve-minute follow-up failed with Qoder's unsuccessful-result error. Independent minimal requests without tools or history failed too. The pinned CLI reported `Model "cmodel" is not available.` This is an upstream model-availability failure; the user subsequently confirmed credit exhaustion, which explains the end-of-run availability change. Production request timeouts and global model settings were not relaxed.
- `e851893` classifies the CLI's exact unavailable-model result as `503 model_unavailable`, with a safe message suggesting another model or a later retry. Matching is tied to the requested model; arbitrary upstream diagnostics remain private. There is no hardcoded unavailable-model list or silent fallback.
- Kimi-K2.8-Preview recovered from one Python command syntax error using the real terminal error and then passed the same fixture check. The proxy did not rewrite command strings. Native recorder tests independently preserve quotes, backslashes, Unicode and newlines exactly.
- GLM-5.3-Flash needed shorter queries for Hermes' lexical tool search. A no-match result still listed Socket as connected; this did not indicate expired credentials or require changing connection settings.

## Deterministic and deployment checks

The capture-race regression was written and observed failing before its implementation. The isolated suite passed **117 Vitest tests**, with three opt-in Docker credential-delivery tests skipped in that runner. Source/browser builds and strict test TypeScript checking passed. The fixed Docker image was built and deployed between live tasks, verified by matching the running container's image ID, and reported CLI 1.1.84. The live tasks separately exercised authenticated production inference and external tool-result consumption.

No new packages were added. Secrets remained in the existing private Keychain/1Password injection path; neither secret values nor raw authentication diagnostics were displayed. Temporary test workspaces, board and routing are removed after verification; only the dated evidence is retained.
