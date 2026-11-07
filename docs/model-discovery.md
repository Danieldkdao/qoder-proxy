# Live Qoder discovery and Hermes Desktop

The proxy no longer maintains a hardcoded model allowlist. On startup and when its cache expires it fetches `https://api.qoder.com/api/v1/forward/models` with the account PAT and runs the pinned CLI with `--list-models`. Only enabled API IDs whose ID or display name appears in the CLI listing are advertised. The current CLI prints names under a `MODEL` heading; the parser also accepts structured lists. Catalog validation checks bounds, duplicate/unsafe IDs, required labels and nonempty compatible results.

The API is documented for Cloud Agents Forward mode, so its catalog alone does not establish CLI compatibility. Intersecting it with the installed CLI avoids blindly advertising Forward-only choices. CLI listing compatibility does not prove every inference will succeed: account credits, upstream availability and model adherence to the emulated tool protocol still apply. Live inference is verified separately. Use exact discovered IDs; old friendly aliases and retired model names are no longer silently mapped.

## Cache and failures

The process shares one in-flight API/CLI refresh. Fresh entries last five minutes by default. Model-list requests can return a previously validated catalog immediately while refreshing it, keeping Desktop's short picker deadline responsive. Chat validation waits for an expired catalog's refresh and can use bounded stale results on a transient failure. Stale entries are usable only while their total age is under 30 minutes. Failed discovery backs off for 30 seconds, including cold starts. A cold/too-old cache returns a sanitized OpenAI-shaped 503 instead of inventing a catalog. An observed API or CLI authentication rejection invalidates stale entries immediately. A PAT rotation requires container recreation, which also clears the cache.

`/v1/models` remains authenticated. Its response uses the standard `object: list` and `data` model entries, with exact IDs and display names. `Cache-Control: no-store` prevents external caches retaining an account catalog; `X-Qoder-Model-Cache` reports fresh/stale internal state. The dashboard reads the same catalog as the public API and chat validator. API/CLI timeouts, body/output size limits and isolated temporary CLI HOME/cwd bound discovery work. The temporary home is removed after listing. No PAT or raw upstream errors are returned to clients.

The optional Environment settings are `QODER_MODEL_CACHE_TTL_MS`, `QODER_MODEL_CACHE_STALE_MS` and `QODER_MODEL_DISCOVERY_TIMEOUT_MS`; see [all environment variables](1password-setup.md). Restarting the container warms the catalog in the background.

## Mini gateway to Air Desktop

Your Desktop connection reaches the Hermes gateway on the Mini. Configure the provider in that remote profile, using the Mini's loopback URL. The Qoder provider is named **Qoder Proxy**, with slug `qoder`, API mode `chat_completions`, default model `auto`, discovery enabled and a 64000-token client context limit. Existing default provider selections are preserved.

The Mini's installed default, coder, researcher, reviewer and troubleshooter profiles have this provider. In Desktop, select the **Mini remote gateway**, select the desired profile, open the chat's model picker, choose **Refresh models**, then choose **Qoder Proxy → auto** or another discovered ID. Old existing sessions may retain their previous provider until switched; start a new chat to test the selected model.

The gateway authenticates with a `key_cmd` pointing to the private installed helper, conceptually:

```yaml
providers:
  qoder:
    name: Qoder Proxy
    api: http://127.0.0.1:17843/v1
    transport: chat_completions
    default_model: auto
    discover_models: true
    context_length: 64000
    key_cmd: >-
      /opt/homebrew/bin/node '/Users/danieldao/Library/Application Support/Qoder Proxy/autostart/scripts/hermes-credential.mts'
model_overrides:
  qoder:
    _default:
      context_window: 64000
      supports_tools: true
      supports_vision: false
      supports_reasoning: false
```

The profile also declares the same defaults for the normalized `custom:qoder-proxy` alias. These overrides describe the proxy's wire capabilities. Qoder may reason internally; external reasoning controls and image input are not implemented by this proxy. The generic `/models` flags alone are insufficient for the current Hermes picker, which reads provider-scoped capability overrides. Other providers retain their own capability settings.

The helper reads the service-account bootstrap token from Keychain, authenticates `op run` and returns only `PROXY_API_KEY` to Hermes through a captured stdout pipe. **Do not execute the helper manually in Terminal**: stdout is deliberately a credential channel. Its internal `--no-masking` is required for the private pipe to carry an actual key; stdout/stderr are captured by Hermes, never emitted by tests or startup logs. Errors contain no raw command diagnostics. The service-account token and Qoder PAT are not passed to the Hermes inference client. They exist only in the short-lived credential-fetch process. No `.env` file or inline provider key is created.

Reinstall the startup runtime after changing the helper, using `node scripts/tasks.mts autostart:install`. Hermes caches command credentials; after rotating the proxy key, recreate the proxy and restart/reconnect the gateway sessions so cached credentials are replaced. The service account must retain read-only access to the configured Environment and the login Keychain must remain available.
