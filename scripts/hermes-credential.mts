import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
interface Settings {
  home: string;
  account: string;
  node: string;
  op: string;
  environment: string;
}
type Runner = (
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<string>;
const execute = promisify(execFile);
const run: Runner = async (file, args, env) =>
  (
    await execute(file, args, {
      env,
      timeout: file === "/usr/bin/security" ? 5000 : 8000,
      maxBuffer: 65536,
    })
  ).stdout;
// stdout is a credential channel consumed only by Hermes key_cmd. Never run this as a diagnostic.
export async function hermesCredential(
  s: Settings,
  execute: Runner = run,
): Promise<string> {
  try {
    const env = {
      HOME: s.home,
      USER: s.account,
      PATH: [dirname(s.node), dirname(s.op), "/usr/bin", "/bin"].join(":"),
    };
    const token = (
      await execute(
        "/usr/bin/security",
        [
          "find-generic-password",
          "-s",
          "com.qoder-proxy.1password.service-account",
          "-a",
          s.account,
          "-w",
        ],
        env,
      )
    ).trim();
    if (!token) throw Error();
    // Masking must be off for this private pipe: Hermes needs the real key, not a masked string.
    const key = (
      await execute(
        s.op,
        [
          "run",
          "--no-masking",
          "--environment",
          s.environment,
          "--",
          s.node,
          "-e",
          'process.stdout.write(process.env.PROXY_API_KEY || "")',
        ],
        { ...env, OP_SERVICE_ACCOUNT_TOKEN: token },
      )
    ).trim();
    if (key.length < 8 || /[\r\n\0]/.test(key) || key.startsWith("op://"))
      throw Error();
    return key;
  } catch {
    throw Error("Hermes proxy credential unavailable");
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void (async () => {
    const s = JSON.parse(
      await readFile(
        join(
          homedir(),
          "Library/Application Support/Qoder Proxy/autostart/settings.json",
        ),
        "utf8",
      ),
    ) as Settings;
    process.stdout.write(await hermesCredential(s));
  })().catch(() => {
    console.error("Hermes proxy credential unavailable");
    process.exitCode = 1;
  });
}
