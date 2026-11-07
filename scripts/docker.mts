import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const execute = promisify(execFile);
const require = createRequire(import.meta.url);
export interface ContainerOptions {
  image: string;
  name: string;
  port: number;
}
export function createArguments(options: ContainerOptions): string[] {
  if (
    !/^[\w][\w.-]*$/.test(options.name) ||
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535 ||
    !options.image ||
    options.image.startsWith("-")
  )
    throw Error("Invalid container settings");
  return [
    "create",
    "--interactive",
    "--init",
    "--label",
    "io.qoder-proxy.managed=true",
    "--name",
    options.name,
    "--publish",
    `127.0.0.1:${options.port}:3000`,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=1g,mode=1777",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--restart",
    "no",
    options.image,
    "node",
    "dist/bootstrap.js",
  ];
}
function dockerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "SSH_AUTH_SOCK",
  ])
    if (process.env[key]) environment[key] = process.env[key];
  return environment;
}
async function docker(args: string[]): Promise<string> {
  const { stdout } = await execute("docker", args, {
    env: dockerEnvironment(),
    timeout: 30000,
    maxBuffer: 65536,
  });
  return stdout.trim();
}
function options(): ContainerOptions {
  return {
    image: process.env.QODER_DOCKER_IMAGE || "qoder-proxy:local",
    name: process.env.QODER_CONTAINER_NAME || "qoder-proxy",
    port: Number(process.env.QODER_HOST_PORT || 3000),
  };
}
async function managed(name: string): Promise<boolean> {
  try {
    const label = await docker([
      "inspect",
      "--format",
      '{{index .Config.Labels "io.qoder-proxy.managed"}}',
      name,
    ]);
    if (label !== "true")
      throw Error("Refusing to modify an unmanaged container");
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      /no such (?:object|container)/i.test(error.message)
    )
      return false;
    throw error;
  }
}
export async function dockerTask(action: string): Promise<void> {
  const settings = options();
  createArguments(settings);
  if (action === "build") {
    await execute("docker", ["build", "-t", settings.image, "."], {
      env: dockerEnvironment(),
      timeout: 600000,
      maxBuffer: 8 * 1024 * 1024,
    });
    console.log(`Built ${settings.image}`);
    return;
  }
  if (action === "status") {
    console.log(
      await docker([
        "ps",
        "--all",
        "--filter",
        `name=^/${settings.name}$`,
        "--format",
        "{{.Names}}: {{.Status}}",
      ]),
    );
    return;
  }
  if (action === "stop") {
    if (await managed(settings.name))
      await docker(["rm", "--force", settings.name]);
    console.log("Managed proxy container stopped");
    return;
  }
  if (action !== "start" && action !== "restart")
    throw Error("Unknown Docker action");
  const runtime = require(
    resolve("dist/runtime-env.js"),
  ) as typeof import("../src/runtime-env");
  const payload = runtime.validateContainerEnvironment(
    runtime.selectContainerEnvironment(process.env),
  );
  if (await managed(settings.name)) {
    if (action !== "restart")
      throw Error(
        "Managed proxy already exists. Use docker:restart to reload secrets.",
      );
    await docker(["rm", "--force", settings.name]);
  }
  const id = await docker(createArguments(settings));
  try {
    // Attach before starting so no bootstrap bytes or readiness messages are lost.
    const attached = spawn(
      "docker",
      ["start", "--attach", "--interactive", id],
      { env: dockerEnvironment(), stdio: ["pipe", "pipe", "pipe"] },
    );
    await new Promise<void>((resolveReady, reject) => {
      let output = "";
      let ready = false;
      const timer = setTimeout(
        () => finish(Error("Secure container bootstrap timed out")),
        20000,
      );
      const finish = (error?: Error) => {
        if (ready) return;
        ready = true;
        clearTimeout(timer);
        attached.stdout.removeAllListeners("data");
        attached.stderr.removeAllListeners("data");
        if (error) reject(error);
        else resolveReady();
      };
      attached.stdout.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-4096);
        if (output.includes("Qoder proxy listening")) finish();
      });
      attached.stderr.on("data", () => {
        /* Never echo bootstrap or upstream diagnostics. */
      });
      attached.once("error", () =>
        finish(Error("Could not start Docker client")),
      );
      attached.once("close", () =>
        finish(Error("Container exited before becoming ready")),
      );
      attached.stdin.on("error", () =>
        finish(Error("Secure environment delivery failed")),
      );
      attached.stdin.end(JSON.stringify(payload) + "\n");
    });
    // --attach is intentionally detached without forwarding signals to PID 1.
    // Destroying the client's transport closes its stdin; the HTTP server stays up.
    attached.stdout.destroy();
    attached.stderr.destroy();
    attached.kill("SIGKILL");
    console.log(
      `Started ${settings.name} at http://127.0.0.1:${settings.port}/v1; secrets were delivered over stdin.`,
    );
  } catch {
    await docker(["rm", "--force", id]).catch(() => {});
    throw Error(
      "Proxy startup failed; verify your 1Password Environment and Docker image. Secret values were not logged.",
    );
  }
}
