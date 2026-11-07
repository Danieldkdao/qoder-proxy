# Automatic startup on macOS

The user LaunchAgent `com.qoder-proxy.autostart` starts after you log in and checks the proxy every 60 seconds. It opens Docker Desktop if needed. It leaves a healthy proxy alone, recreates a stopped/missing managed container, and tolerates transient failed health checks before recreating an unhealthy container. Launchd prevents overlapping executions of this job.

This is **after login**, not before login. FileVault, automatic login and system security settings are unchanged. The login Keychain must be unlocked. Startup can wait for Docker or Keychain and retry on the next interval. An SSH-only session after a reboot does not replace a graphical login for Docker Desktop.

## Credentials

Create a [1Password service account](https://www.1password.dev/service-accounts/get-started) with read access only to the Qoder Proxy Environment `umcywiy3b7hzpi2ln4zqrcywi4`. Keep the Qoder PAT and proxy API key in that Environment. The separate service-account bootstrap token belongs in your login Keychain, **not inside the Environment it unlocks**.

Create/update a generic password in Keychain Access:

- Service/name: `com.qoder-proxy.1password.service-account`
- Account: your macOS username (`danieldao` on this Mini)
- Password: the complete 1Password service-account token

For an initial command-line entry, `security add-generic-password -U -a "$USER" -s com.qoder-proxy.1password.service-account -T /usr/bin/security -w` prompts for the password because `-w` is last. Never put the token in a command argument. If the saved token cannot be decoded, use Keychain Access's password field to save the complete token. Allow `/usr/bin/security` access to this particular item when macOS asks; do not grant all applications access. The token is accessible to this logged-in user through that trusted accessor. A locked Keychain or revoked/expired token prevents recovery until corrected.

At recovery, the agent captures the token in host process memory and supplies `OP_SERVICE_ACCOUNT_TOKEN` only to `op run`. The existing secure Docker launcher allowlists proxy variables and delivers them over stdin to the container. The service-account token is not forwarded to Docker. No credential is saved in the plist, settings, status, Docker configuration or repository. Processes running as your user and administrators remain part of the trust boundary. Runtime secrets are necessarily present in the authorized proxy process memory.

## Install, inspect and remove

Run from the repository after building the image and TypeScript application. These internal commands intentionally avoid the public npm wrappers, so agent installation/status do not themselves request desktop 1Password authorization:

```sh
node scripts/tasks.mts build
node scripts/tasks.mts autostart:install
node scripts/tasks.mts autostart:status
```

Public `npm run autostart:install`, `autostart:status`, and `autostart:uninstall` also exist and include the configured Environment ID, consistently with all other package commands. Those wrappers authenticate with 1Password first.

The installer copies the small runtime launcher and environment validator into `~/Library/Application Support/Qoder Proxy/autostart`, with private permissions. It does not run code from Desktop at login. The image remains in Docker's local image store. Reinstall the agent after changing launcher/validator code or the Environment ID. Rebuild `qoder-proxy:local` and recreate the container when changing application code. Node, Docker Desktop and the 1Password CLI must remain installed at the executable locations recorded in `settings.json`; reinstall the agent after moving them.

```sh
launchctl print gui/$(id -u)/com.qoder-proxy.autostart
cat "$HOME/Library/Application Support/Qoder Proxy/autostart/status.json"
```

Status contains only a timestamp, a safe state name and an unhealthy counter. Stdout/stderr go to `/dev/null`; raw Keychain, CLI and upstream diagnostics are never logged. `running` means a preexisting container was healthy; `started` means secure bootstrap completed, with health checked on the next tick. `keychain-unavailable` needs the saved credential/unlocked Keychain; `authorization-or-startup-failed` needs valid service-account permissions, valid Environment variables, the built image and available port. `unmanaged-container` refuses to overwrite a same-named container without the proxy management label.

To remove automatic recovery before deliberately stopping the proxy:

```sh
node scripts/tasks.mts autostart:uninstall
```

Uninstall retains the running container, image, and Keychain credential. Remove that credential manually in Keychain Access if no longer needed. Do not use Docker's `unless-stopped` restart policy: this proxy must receive fresh secrets through the agent when recreated.

## Verification

Vitest covers healthy no-op behavior, missing-container recovery, Docker startup, unmanaged-container refusal, health grace periods, secret routing, sanitized failures and the generated login-agent plist. A real recovery test stops the managed proxy, triggers the installed LaunchAgent and verifies the replacement container reaches healthy status. This briefly interrupts the endpoint. A reboot test requires an actual reboot and graphical login; do not equate a recovery test with having tested a reboot.

### Verified on this Mac Mini, November 6, 2026

- 58 Vitest tests and three Docker isolation integration tests passed, with strict TypeScript and formatting checks.
- Installed plist passed `plutil -lint`; runtime directory mode is 0700 and settings/plist mode is 0600.
- Repeated Keychain reads and headless service-account Environment validation succeeded without further prompts after granting access.
- Stopped the production managed container and triggered the installed LaunchAgent. It recreated a different container ID and reached healthy status using fresh stdin-delivered secrets.
- The recovered endpoint passed a live authenticated Qoder tool-call/result/final-answer roundtrip.
- GitHub tests and AMD64/ARM64 image publishing passed for implementation commit `e660898`: [verification run](https://github.com/Danieldkdao/qoder-proxy/actions/runs/42323032189).

An actual reboot was not performed. Startup still requires graphical login and an unlocked login Keychain. Token expiration/revocation or removed Environment access requires updating the Keychain credential/permissions.

## Host port

Docker, the startup installer and Hermes commands share the host default **17843**. The container continues to listen internally on port 3000. Hermes connects to `http://127.0.0.1:17843/v1`. `QODER_HOST_PORT` overrides the host default when explicitly set. The installer records it in its private, non-secret `settings.json`; reinstall the agent after changing this setting. Existing Hermes profiles are deliberately preserved by `hermes:configure`, so update their `model.base_url` explicitly when migrating an existing profile.
