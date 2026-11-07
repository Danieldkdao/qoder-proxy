import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const execute = promisify(execFile);
function endpoint(): string {
  const value =
    process.env.QODER_PROXY_BASE_URL ||
    `http://127.0.0.1:${process.env.QODER_HOST_PORT || 3000}/v1`;
  const url = new URL(value);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/$/, "") !== "/v1"
  )
    throw Error(
      "Use a loopback http://127.0.0.1:PORT/v1 endpoint (SSH-forward remote access)",
    );
  return value.replace(/\/$/, "");
}
function credential(): string {
  const key = process.env.PROXY_API_KEY;
  if (!key || key.startsWith("op://") || key.length < 8)
    throw Error("Configure PROXY_API_KEY in 1Password");
  return key;
}
async function completion(body: unknown): Promise<{
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
}> {
  const response = await fetch(endpoint() + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credential()}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(150000),
  });
  if (!response.ok)
    throw Error(
      `Proxy request failed (${response.status}); check PAT, credits and model access`,
    );
  return response.json() as ReturnType<typeof completion>;
}
async function proxyCheck(): Promise<void> {
  const url = endpoint(),
    model = process.env.QODER_HERMES_MODEL || "auto";
  const health = await fetch(url.replace(/\/v1$/, "/health"), {
    signal: AbortSignal.timeout(10000),
  });
  if (!health.ok) throw Error("Proxy is not ready");
  const nonce = "QODER_PROXY_" + randomBytes(8).toString("hex");
  const tools = [
    {
      type: "function",
      function: {
        name: "echo_nonce",
        description: "Return the supplied nonce",
        parameters: {
          type: "object",
          properties: { nonce: { type: "string" } },
          required: ["nonce"],
          additionalProperties: false,
        },
      },
    },
  ];
  const messages: unknown[] = [
    {
      role: "user",
      content: `Call echo_nonce with nonce ${nonce}. After its result, respond with exactly that nonce.`,
    },
  ];
  const first = await completion({
    model,
    messages,
    tools,
    tool_choice: "required",
  });
  const message = first.choices[0]?.message,
    call = message?.tool_calls?.[0];
  if (
    !call ||
    call.function.name !== "echo_nonce" ||
    JSON.parse(call.function.arguments).nonce !== nonce
  )
    throw Error("Model did not follow the required tool protocol");
  messages.push(message, {
    role: "tool",
    tool_call_id: call.id,
    content: nonce,
  });
  const final = await completion({
    model,
    messages,
    tools,
    tool_choice: "none",
  });
  if (!final.choices[0]?.message.content?.includes(nonce))
    throw Error("Model did not consume the tool result");
  console.log(
    "PASS: authenticated proxy → Qoder → tool call → tool result → final answer.",
  );
}
function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
export async function verifyTask(task: string): Promise<void> {
  if (task === "proxy:check") {
    await proxyCheck();
    return;
  }
  const interactive = task === "hermes:chat";
  const directory = await mkdtemp(join(tmpdir(), "hermes-qoder-acceptance-"));
  const profile = interactive
    ? process.env.QODER_HERMES_HOME || join(homedir(), ".hermes-qoder-proxy")
    : join(directory, "profile");
  const model = process.env.QODER_HERMES_MODEL || "auto",
    base = endpoint(),
    key = credential();
  try {
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const file = join(profile, "config.yaml");
    const config = {
      model: {
        provider: "custom",
        default: model,
        base_url: base,
        key_env: "PROXY_API_KEY",
        context_length: 64000,
      },
      agent: {
        max_turns: interactive ? 30 : 4,
        reasoning_effort: false,
        api_max_retries: 1,
        auto_recovery_cycles: 0,
      },
      compression: { enabled: false },
      memory: { enabled: false },
      terminal: {
        backend: "local",
        cwd: interactive ? process.cwd() : directory,
        env_passthrough: [],
        client_env_passthrough: [],
      },
    };
    if (!interactive)
      await writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
    else {
      try {
        await access(file);
      } catch {
        await writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
      }
    }
    const env: NodeJS.ProcessEnv = {
      HERMES_HOME: profile,
      PROXY_API_KEY: key,
      OPENAI_API_KEY: key,
      PATH: process.env.PATH,
      HOME: homedir(),
      USER: process.env.USER,
      LANG: process.env.LANG || "en_US.UTF-8",
      TMPDIR: process.env.TMPDIR,
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    };
    if (interactive) {
      const child = spawn(
        "hermes",
        ["--provider", "custom", "--model", model, "chat", "--base-url", base],
        { env, stdio: "inherit" },
      );
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0
            ? resolve()
            : reject(Error("Hermes exited unsuccessfully")),
        );
      });
      return;
    }
    const proof = join(directory, "proof.txt"),
      nonce = "HERMES_QODER_" + randomBytes(12).toString("hex");
    const command = `printf '%s' ${shellQuote(nonce)} > ${shellQuote(proof)} && cat ${shellQuote(proof)}`;
    const prompt = `This is an end-to-end acceptance test. You MUST use the terminal tool, not just describe a command. Run exactly this command with terminal: ${command}\nAfter the tool result, reply with exactly ${nonce}. Do not change any other files.`;
    const result = await execute(
      "hermes",
      [
        "--provider",
        "custom",
        "--model",
        model,
        "--ignore-rules",
        "-t",
        "terminal",
        "-z",
        prompt,
      ],
      { cwd: directory, env, timeout: 300000, maxBuffer: 1024 * 1024 },
    );
    const written = await readFile(proof, "utf8");
    if (written !== nonce || !result.stdout.includes(nonce))
      throw Error(
        "Hermes did not execute and finish the terminal tool round trip",
      );
    console.log(
      "PASS: real Hermes → proxy → Qoder → real terminal tool → verified temporary file → final answer.",
    );
  } catch {
    throw Error(
      "Hermes acceptance failed. Verify the proxy, supported model and installed Hermes CLI. Credentials and raw subprocess output were not printed.",
    );
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 200,
    });
  }
}
