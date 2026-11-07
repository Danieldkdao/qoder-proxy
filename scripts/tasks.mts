import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { dockerTask } from "./docker.mts";
function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "CI",
    "NODE_ENV",
    "GITHUB_ACTIONS",
    "NO_COLOR",
    "FORCE_COLOR",
  ])
    if (process.env[key]) environment[key] = process.env[key];
  return environment;
}
function runtimeEnvironment(): NodeJS.ProcessEnv {
  const require = createRequire(import.meta.url);
  const runtime = require(
    resolve("dist/runtime-env.js"),
  ) as typeof import("../src/runtime-env");
  const environment: NodeJS.ProcessEnv = {
    ...cleanEnvironment(),
    ...runtime.selectContainerEnvironment(process.env),
  };
  for (const key of ["HOST", "PORT", "QODERCLI_BIN"])
    if (process.env[key]) environment[key] = process.env[key];
  return environment;
}
function run(binary: string, args: string[], env = cleanEnvironment()): void {
  execFileSync(binary, args, { stdio: "inherit", env });
}
const node = (script: string, args: string[] = []) =>
  run(process.execPath, [script, ...args]);
const bin = (name: string, args: string[], env = cleanEnvironment()) =>
  run(resolve("node_modules/.bin", name), args, env);
const patterns = [
  "src/**/*.{ts,html,css}",
  "test/**/*.ts",
  "scripts/*.mts",
  "*.json",
  "*.md",
  ".github/**/*.{md,yml}",
  "docs/**/*.md",
];
async function main(): Promise<void> {
  const task = process.argv[2];
  if (task?.startsWith("docker:")) {
    await dockerTask(task.slice(7));
    return;
  }
  if (task?.startsWith("autostart:")) {
    await (await import("./autostart.mts")).autostartTask(task.slice(10));
    return;
  }
  switch (task) {
    case "build":
      node("scripts/build.mts");
      break;
    case "test":
      node("scripts/build.mts");
      bin("vitest", ["run"]);
      break;
    case "test:docker":
      node("scripts/build.mts");
      bin("vitest", ["run", "test/docker-secrets.test.ts"], {
        ...cleanEnvironment(),
        RUN_DOCKER_TESTS: "1",
      });
      break;
    case "typecheck":
      for (const file of [
        "tsconfig.json",
        "tsconfig.browser.json",
        "tsconfig.test.json",
      ])
        bin("tsc", ["-p", file, "--noEmit"]);
      break;
    case "format":
    case "format:check":
      bin("prettier", [task === "format" ? "--write" : "--check", ...patterns]);
      break;
    case "dev":
    case "test:watch":
      node("scripts/build.mts");
      bin(
        "concurrently",
        [
          "-k",
          "tsc -p tsconfig.json --watch",
          "tsc -p tsconfig.browser.json --watch",
          task === "dev" ? "node --watch dist/server.js" : "vitest",
        ],
        task === "dev" ? runtimeEnvironment() : cleanEnvironment(),
      );
      break;
    case "start":
      run(process.execPath, ["dist/server.js"], runtimeEnvironment());
      break;
    case "qoder:check":
      await (await import("./availability.mts")).availabilityTask();
      break;
    case "proxy:check":
    case "hermes:test":
    case "hermes:chat":
    case "hermes:configure":
      await (await import("./verify.mts")).verifyTask(task);
      break;
    default:
      throw Error("Unknown task");
  }
}
void main().catch((error: unknown) => {
  if (
    error instanceof Error &&
    error.message.startsWith("Hermes acceptance failed: ")
  ) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  console.error(
    "Task failed. Check the non-secret configuration and 1Password authorization; do not print credentials.",
  );
  process.exitCode = 1;
});
