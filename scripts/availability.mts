import { readFile } from "node:fs/promises";
const npmUrl = "https://registry.npmjs.org/@qoder-ai%2fqodercli";
const standaloneUrl =
  "https://qoder-ide.oss-accelerate.aliyuncs.com/qodercli/channels/manifest.json";
const apiUrl = "https://api.qoder.com/api/v1/forward/models";
export interface Dependencies {
  readPin: () => Promise<string>;
  fetchJson: (url: string) => Promise<unknown>;
  cli: () => Promise<{ version: string; names: string[] }>;
}
const version = (raw: unknown): string => {
  if (typeof raw !== "string" || !/^\d+\.\d+\.\d+$/.test(raw)) throw Error();
  return raw;
};
function newer(candidate: string, pin: string): boolean {
  const a = candidate.split(".").map(Number),
    b = pin.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}
const duck = (name: string) =>
  name.replace(/[\s_-]/g, "").toLowerCase() === "qoduck";
export async function checkAvailability(dependencies: Dependencies) {
  const pin = version(await dependencies.readPin());
  const [npm, standalone, api, cli] = await Promise.allSettled([
    dependencies.fetchJson(npmUrl).then((raw) => {
      const v = version(
        (raw as { "dist-tags"?: { latest?: unknown } })?.["dist-tags"]?.latest,
      );
      return { version: v, newerThanPinned: newer(v, pin) };
    }),
    dependencies.fetchJson(standaloneUrl).then((raw) => {
      const v = version((raw as { latest?: unknown })?.latest);
      return { version: v, newerThanPinned: newer(v, pin) };
    }),
    dependencies.fetchJson(apiUrl).then((raw) => {
      const rows = (raw as { data?: unknown })?.data;
      if (!Array.isArray(rows) || !rows.length || rows.length > 256)
        throw Error();
      if (
        rows.some(
          (m) =>
            !m ||
            typeof m.id !== "string" ||
            typeof m.display_name !== "string",
        )
      )
        throw Error();
      return rows.some(
        (m) => m.is_enabled !== false && (duck(m.id) || duck(m.display_name)),
      );
    }),
    dependencies.cli().then((raw) => {
      const v = version(raw.version);
      if (
        !Array.isArray(raw.names) ||
        !raw.names.length ||
        raw.names.length > 1024 ||
        raw.names.some((n) => typeof n !== "string" || n.length > 160)
      )
        throw Error();
      return { version: v, qoduckPresent: raw.names.some(duck) };
    }),
  ]);
  const state = (r: PromiseSettledResult<boolean>) =>
    r.status === "rejected"
      ? ("unknown" as const)
      : r.value
        ? ("present" as const)
        : ("absent" as const);
  const apiState = state(api),
    cliState =
      cli.status === "rejected"
        ? "unknown"
        : cli.value.qoduckPresent
          ? "present"
          : "absent";
  return {
    pinnedVersion: pin,
    npm: npm.status === "fulfilled" ? npm.value : { error: "unavailable" },
    standalone:
      standalone.status === "fulfilled"
        ? standalone.value
        : { error: "unavailable" },
    runningCli:
      cli.status === "fulfilled"
        ? { version: cli.value.version }
        : { error: "unavailable" },
    qoduck: {
      api: apiState,
      cli: cliState,
      discoverableInBoth: apiState === "present" && cliState === "present",
      inferenceVerified: false,
    },
    note: "Read-only check. No candidate CLI was installed or tested. No inference requests, pin changes, container replacements or proxy restarts.",
  };
}
export function formatAvailability(
  result: Awaited<ReturnType<typeof checkAvailability>>,
): string {
  const release = (label: string, value: typeof result.npm) =>
    "error" in value
      ? `${label}: unavailable`
      : `${label}: ${value.version} (newer: ${value.newerThanPinned ? "yes" : "no"})`;
  return [
    `Pinned CLI: ${result.pinnedVersion}`,
    release("npm stable", result.npm),
    release("Standalone stable", result.standalone),
    `Installed CLI: ${"error" in result.runningCli ? "unavailable" : result.runningCli.version}`,
    `QoDuck in account API: ${result.qoduck.api}`,
    `QoDuck in installed CLI: ${result.qoduck.cli}`,
    `Discoverable in both: ${result.qoduck.discoverableInBoth ? "yes" : "no"}`,
    "QoDuck inference verified: no (discovery check only)",
    result.note,
  ].join("\n");
}
export function cliCheckArguments(name: string): string[] {
  if (!/^[\w][\w.-]*$/.test(name)) throw Error("Invalid container name");
  const code = `const fs=require('node:fs'),cp=require('node:child_process');const p=JSON.parse(fs.readFileSync(0,'utf8'));const home=fs.mkdtempSync('/tmp/qoder-availability-');const env={PATH:process.env.PATH,HOME:home,CI:'1',NO_BROWSER:'1',QODER_PERSONAL_ACCESS_TOKEN:p.pat};try{const options={cwd:home,env,encoding:'utf8',timeout:15000,maxBuffer:1048576};const v=cp.spawnSync('/usr/local/bin/qodercli',['--version'],options);const r=cp.spawnSync('/usr/local/bin/qodercli',['--list-models'],options);if(v.status!==0||r.status!==0)process.exit(1);const lines=r.stdout.replace(/\\u001b\\[[0-?]*[ -/]*[@-~]/g,'').trim().split(/\\r?\\n/).map(x=>x.trim()).filter(Boolean);if(lines.shift()!=='MODEL')process.exit(1);process.stdout.write(JSON.stringify({version:v.stdout.trim(),names:lines}));}finally{fs.rmSync(home,{recursive:true,force:true});}`;
  return ["exec", "-i", name, "node", "--eval", code];
}
async function json(url: string): Promise<unknown> {
  const pat =
    process.env.QODER_PERSONAL_ACCESS_TOKEN || process.env.QODER_API_KEY;
  if (url === apiUrl && !pat) throw Error();
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: url === apiUrl ? { Authorization: "Bearer " + pat } : {},
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error();
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > 4 * 1024 * 1024) throw Error();
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function availabilityTask(): Promise<void> {
  const result = await checkAvailability({
    readPin: async () => {
      const source = await readFile("Dockerfile", "utf8");
      const match = source.match(/^ARG QODERCLI_VERSION=(\d+\.\d+\.\d+)$/m);
      if (!match) throw Error("Pinned CLI version not found");
      return match[1]!;
    },
    fetchJson: json,
    cli: async () => {
      const env: NodeJS.ProcessEnv = {};
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
        if (process.env[key]) env[key] = process.env[key];
      const args = cliCheckArguments(
        process.env.QODER_CONTAINER_NAME || "qoder-proxy",
      );
      const pat =
        process.env.QODER_PERSONAL_ACCESS_TOKEN || process.env.QODER_API_KEY;
      if (!pat) throw Error();
      // A pipe carries credentials; no -e/env flag or token is persisted in Docker metadata.
      const { spawn } = await import("node:child_process");
      return new Promise((resolve, reject) => {
        const child = spawn("docker", args, {
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let output = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(Error());
        }, 35000);
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (Buffer.byteLength(output) > 1048576) {
            child.kill("SIGKILL");
            reject(Error());
          }
        });
        child.stderr.resume();
        child.stdin.on("error", () => {});
        child.once("error", () => {
          clearTimeout(timer);
          reject(Error());
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          try {
            if (code !== 0) throw Error();
            resolve(JSON.parse(output));
          } catch {
            reject(Error());
          }
        });
        child.stdin.end(JSON.stringify({ pat }));
      });
    },
  });
  console.log(formatAvailability(result));
  if (
    result.qoduck.api === "unknown" ||
    result.qoduck.cli === "unknown" ||
    "error" in result.npm ||
    "error" in result.standalone
  )
    process.exitCode = 1;
}
