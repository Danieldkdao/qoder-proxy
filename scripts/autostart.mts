import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  chmod,
  rm,
  access,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, userInfo } from "node:os";

import { containerOptions, createArguments } from "./docker.mts";

const execute = promisify(execFile);
const label = "com.qoder-proxy.autostart";
const service = "com.qoder-proxy.1password.service-account";
const marker = "qoder-proxy-managed-autostart-v1";
export interface Settings {
  environment: string;
  account: string;
  node: string;
  op: string;
  docker: string;
  home: string;
  bundle: string;
  image: string;
  name: string;
  port: number;
}
export interface Status {
  state?: string;
  unhealthy?: number;
  time?: string;
}
export type Runner = (
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<string>;
const run: Runner = async (file, args, env) => {
  const { stdout } = await execute(file, args, {
    env,
    timeout: 120000,
    maxBuffer: 65536,
  });
  return stdout.trim();
};
function environment(s: Settings): NodeJS.ProcessEnv {
  return {
    HOME: s.home,
    USER: s.account,
    PATH: [
      ...new Set([
        dirname(s.node),
        dirname(s.op),
        dirname(s.docker),
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ]),
    ].join(":"),
  };
}
export async function tick(
  s: Settings,
  previous: Status,
  execute: Runner = run,
): Promise<Status> {
  const env = environment(s);
  const result = (state: string, unhealthy = 0): Status => ({
    state,
    unhealthy,
    time: new Date().toISOString(),
  });
  try {
    await execute(s.docker, ["info", "--format", "{{.ServerVersion}}"], env);
  } catch {
    await execute(
      "/usr/bin/open",
      ["-gj", "-a", "/Applications/Docker.app"],
      env,
    ).catch(() => "");
    return result("waiting-for-docker");
  }
  try {
    const id = (
      await execute(
        s.docker,
        ["ps", "--all", "--filter", `name=^/${s.name}$`, "--format", "{{.ID}}"],
        env,
      )
    ).trim();
    if (id) {
      const current = JSON.parse(
        await execute(
          s.docker,
          [
            "inspect",
            "--format",
            '{"managed":{{json (index .Config.Labels "io.qoder-proxy.managed")}},"status":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}}}',
            id,
          ],
          env,
        ),
      ) as { managed: string; status: string; health: string };
      if (current.managed !== "true") return result("unmanaged-container");
      if (current.status === "running") {
        if (current.health === "healthy") return result("running");
        const failures = (previous.unhealthy || 0) + 1;
        // Give a newly started container five minutes; tolerate transient failed health checks.
        const limit = current.health === "starting" ? 5 : 3;
        if (failures < limit) return result("waiting-for-health", failures);
      }
      if (current.status === "paused" || current.status === "removing")
        return result("container-busy");
    }
  } catch {
    return result("docker-inspection-failed");
  }
  let token: string;
  try {
    token = (
      await execute(
        "/usr/bin/security",
        ["find-generic-password", "-s", service, "-a", s.account, "-w"],
        env,
      )
    ).trim();
    if (!token || token.includes("\n")) return result("keychain-unavailable");
  } catch {
    return result("keychain-unavailable");
  }
  try {
    await execute(
      s.op,
      [
        "run",
        "--environment",
        s.environment,
        "--",
        s.node,
        join(s.bundle, "scripts/tasks.mts"),
        "docker:restart",
      ],
      {
        ...env,
        OP_SERVICE_ACCOUNT_TOKEN: token,
        QODER_DOCKER_IMAGE: s.image,
        QODER_CONTAINER_NAME: s.name,
        QODER_HOST_PORT: String(s.port),
      },
    );
    return result("started");
  } catch {
    return result("authorization-or-startup-failed");
  } finally {
    token = "";
  }
}
function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
export function launchAgent(s: Settings): string {
  const strings = [
    s.node,
    join(s.bundle, "scripts/autostart.mts"),
    "tick",
    join(s.bundle, "settings.json"),
  ]
    .map((v) => `<string>${xml(v)}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${marker} -->
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${strings}</array>
<key>WorkingDirectory</key><string>${xml(s.bundle)}</string>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>60</integer>
<key>ProcessType</key><string>Background</string>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
}
async function readStatus(bundle: string): Promise<Status> {
  try {
    return JSON.parse(
      await readFile(join(bundle, "status.json"), "utf8"),
    ) as Status;
  } catch {
    return {};
  }
}
async function existingOwned(path: string): Promise<boolean> {
  try {
    if (!(await readFile(path, "utf8")).includes(marker))
      throw Error("Unmanaged startup file");
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
export async function autostartTask(action: string): Promise<void> {
  if (process.platform !== "darwin") throw Error("macOS is required");
  const home = homedir();
  const bundle = join(
    home,
    "Library/Application Support/Qoder Proxy/autostart",
  );
  const plist = join(home, "Library/LaunchAgents", `${label}.plist`);
  const domain = `gui/${process.getuid!()}`;
  const env = { HOME: home, PATH: process.env.PATH || "/usr/bin:/bin" };
  if (action === "status") {
    console.log(JSON.stringify(await readStatus(bundle)));
    return;
  }
  if (action === "uninstall") {
    if (await existingOwned(plist)) {
      await run("/bin/launchctl", ["bootout", `${domain}/${label}`], env).catch(
        () => "",
      );
      await rm(plist);
    }
    if (await existingOwned(join(bundle, "owner")))
      await rm(bundle, { recursive: true });
    console.log(
      "Startup agent removed; Keychain credential and proxy container retained.",
    );
    return;
  }
  if (action !== "install") throw Error("Unknown startup task");
  await existingOwned(plist);
  // Refuse to replace unrelated content in the application-support directory.
  try {
    await access(bundle);
    if (!(await existingOwned(join(bundle, "owner"))))
      throw Error("Unmanaged directory");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const locate = async (name: string) => {
    const path = await run("/usr/bin/which", [name], env);
    if (!path.startsWith("/")) throw Error("Missing executable");
    await access(path, constants.X_OK);
    return path;
  };
  const s: Settings = {
    environment: "umcywiy3b7hzpi2ln4zqrcywi4",
    account: userInfo().username,
    node: await locate("node"),
    op: await locate("op"),
    docker: await locate("docker"),
    home,
    bundle,
    ...containerOptions(),
  };
  createArguments(s);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // Validate build artifacts before modifying an existing installation.
  await access(join(root, "dist/runtime-env.js"));
  if (await existingOwned(plist))
    await run("/bin/launchctl", ["bootout", `${domain}/${label}`], env).catch(
      () => "",
    );
  for (const dir of [
    bundle,
    join(bundle, "scripts"),
    join(bundle, "dist"),
    dirname(plist),
  ])
    await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(bundle, 0o700);
  await writeFile(join(bundle, "owner"), marker, { mode: 0o600 });
  for (const file of [
    "scripts/autostart.mts",
    "scripts/hermes-credential.mts",
    "scripts/tasks.mts",
    "scripts/docker.mts",
    "dist/runtime-env.js",
  ]) {
    await copyFile(join(root, file), join(bundle, file));
    await chmod(join(bundle, file), 0o600);
  }
  await writeFile(join(bundle, "settings.json"), JSON.stringify(s), {
    mode: 0o600,
  });
  await writeFile(plist, launchAgent(s), { mode: 0o600 });
  await chmod(plist, 0o600);
  await run("/usr/bin/plutil", ["-lint", plist], env);
  await run("/bin/launchctl", ["bootstrap", domain, plist], env);
  console.log(
    "Installed startup agent. Recovery runs after login and every 60 seconds; status contains no credentials.",
  );
}
async function main(): Promise<void> {
  if (process.argv[2] === "tick") {
    const s = JSON.parse(await readFile(process.argv[3], "utf8")) as Settings;
    const state = await tick(s, await readStatus(s.bundle));
    await writeFile(join(s.bundle, "status.json"), JSON.stringify(state), {
      mode: 0o600,
    });
  } else await autostartTask(process.argv[2] || "status");
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch(() => {
    console.error(
      "Startup operation failed. Check installation and authorization; credentials were not logged.",
    );
    process.exitCode = 1;
  });
}
