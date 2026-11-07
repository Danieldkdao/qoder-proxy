# Read-only updates and per-model thinking

## Check CLI updates and QoDuck

From the repository on the Mini:

```sh
npm run qoder:check
```

The package command includes your configured 1Password Environment ID. It reads the Dockerfile pin, npm's published stable dist-tag, the official standalone installer channel manifest, the live account model API, and `--list-models` from the CLI in the existing `qoder-proxy` container. `QODER_CONTAINER_NAME` selects another existing container if needed. It never installs or executes a newer CLI, edits the pin, builds an image, starts/recreates a container, restarts the proxy or sends paid inference requests. The CLI listing uses an isolated temporary HOME/cwd inside the container and removes that state afterwards.

The result is JSON. Each release channel reports its version and `newerThanPinned`. QoDuck is `present`, `absent` or `unknown` independently for API and installed CLI. `discoverableInBoth` does not mean inference has been verified; `inferenceVerified` is deliberately false. A version mismatch is a prompt for a separate isolated compatibility test, not an upgrade action. No guessed QoDuck ID is sent to Qoder. Availability checks use metadata from the two catalogs, not a hardcoded model entry. A failed source is reported as unavailable/unknown while other checks still complete; partial failures exit nonzero. Raw upstream/CLI diagnostics and credential values are not printed.

The CLI in this command is the already installed, pinned version. The command does **not** establish whether an uninstalled newer version exposes QoDuck. That requires a separate disposable candidate test. If the production container is stopped or Docker unavailable, the CLI result is unknown; the command does not start anything to fix it.

## Thinking effort over OpenAI Chat Completions

Both `/v1/models` and `/hermes/v1/models` expose each compatible model's live Qoder metadata:

- `supports_reasoning`: whether Qoder lists selectable effort levels.
- `supported_efforts`: ordered levels currently listed for that model.
- `default_effort`: Qoder's reported default, if supplied.
- `can_disable_reasoning`: whether Qoder advertises a thinking-off toggle.
- `supported_parameters`: includes `reasoning_effort` when applicable.

Send standard top-level `reasoning_effort` in a Chat Completions request. The ID/name still comes from the relevant live catalog:

```json
{
  "model": "Qwen3.8-Max",
  "messages": [{ "role": "user", "content": "Solve this problem." }],
  "reasoning_effort": "low"
}
```

The example uses the friendly `/hermes/v1` endpoint; use the canonical discovered ID with `/v1`. A supported effort is forwarded as `--reasoning-effort LEVEL` to the pinned CLI. `reasoning_effort: "none"` maps to `--thinking disabled` only for models explicitly advertising that capability. Omit the field to keep the CLI/model's default. Unsupported levels, thinking-off requests for mandatory-thinking models, non-string values and invented controls return a clear 400 before inference. Nothing is silently clamped to a different level.

These are **thinking budget controls**, not a promise of returning reasoning text. The proxy continues returning the final assistant text and validated tool calls; it does not expose private reasoning traces. Vision remains unsupported even if Qoder's model is multimodal.

## Hermes Desktop

Hermes's gateway needs its Qoder provider-specific `model_overrides` updated from the new live capabilities; old `supports_reasoning: false` overrides intentionally hide the controls. For models with supported efforts, set `supports_reasoning: true`; for those without selectable efforts keep it false. Set per-model `agent.reasoning_overrides` to each model's live default to avoid sending a global default unsupported by that model. Keep the friendly-name endpoint and the Keychain-backed `key_cmd`.

This Hermes Desktop version uses a generic effort menu for custom endpoints: it does not consume every model's `supported_efforts` list to hide individual unsupported levels or its `can_disable_reasoning` field to constrain the custom-provider toggle. The proxy validates the actual per-model allowed values and returns 400 for invalid choices. Choose a level listed by `/hermes/v1/models`; enabling a thinking dial alone does not make every level valid. Updating those UI-specific menus would require a separate Hermes Desktop client change, including deploying that client on the Air.

The Mini's default, coder, researcher, reviewer and troubleshooter profiles have been updated from the live catalog: 12 models expose effort controls, while Auto, Fast and Efficient have no advertised effort list. Refresh the model picker on the Mini remote connection in Desktop. The provider's existing name, endpoint and Keychain credential command are unchanged.

### Current effort examples

These are observed account metadata, not runtime hardcoded allowlists:

| Models                                                    | Advertised efforts                   |
| --------------------------------------------------------- | ------------------------------------ |
| Ultimate, Sonus, Cantus, MiniMax-M3.1-Flash               | low, medium, high, xhigh, max        |
| Qwen3.8-Max, Qwen3.8-Flash                                | low, medium, xhigh                   |
| Kimi-K3.1-Pro, Kimi-K2.8-Preview, GLM-5.3, DeepSeek-Flash | low, high, max                       |
| GLM-5.3-Flash, DeepSeek-V4-Pro                            | high, max                            |
| Auto, Fast, Efficient                                     | No selectable effort list advertised |

Live preview requests verified low effort on Qwen3.8-Max and DeepSeek-Flash, and thinking-off on DeepSeek-Flash. Thinking-off on Qwen3.8-Max produced an upstream output-budget error despite the advertised toggle; no silent fallback was applied. Supported metadata does not guarantee every thinking/output-budget combination works upstream. The pinned CLI remains 1.1.84.
