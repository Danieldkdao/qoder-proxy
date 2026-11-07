import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import config from "../config";
import { ProxyError } from "../errors";
import { extractTextContent, normalizeFinishReason } from "./format";
import type { QoderResult } from "../types";

interface Waiter {
  start: () => void;
  reject: (error: Error) => void;
}
class Admission {
  active = 0;
  queue: Waiter[] = [];
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted)
      return Promise.reject(
        new ProxyError("Request cancelled", 499, "cancelled"),
      );
    if (this.active < config.QODER_MAX_CONCURRENCY) {
      this.active++;
      return Promise.resolve(this.release());
    }
    if (this.queue.length >= config.QODER_MAX_QUEUE)
      return Promise.reject(
        new ProxyError(
          "Inference capacity exceeded; retry later",
          503,
          "overloaded",
        ),
      );
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const remove = (error: Error) => {
        this.queue = this.queue.filter((w) => w !== waiter);
        cleanup();
        reject(error);
      };
      const abort = () =>
        remove(new ProxyError("Request cancelled", 499, "cancelled"));
      const waiter: Waiter = {
        start: () => {
          cleanup();
          this.active++;
          resolve(this.release());
        },
        reject: remove,
      };
      const timer = setTimeout(
        () =>
          remove(
            new ProxyError("Inference queue timed out", 503, "overloaded"),
          ),
        config.QODER_QUEUE_TIMEOUT_MS,
      );
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(waiter);
    });
  }
  private release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.start();
    };
  }
}
const admission = new Admission();
const children = new Set<ChildProcess>();
export const processStats = () => ({
  active: admission.active,
  queued: admission.queue.length,
});
function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    /* already exited */
  }
}
export function shutdown(): void {
  for (const waiter of [...admission.queue])
    waiter.reject(new ProxyError("Server shutting down", 503, "unavailable"));
  for (const child of children) {
    terminate(child, "SIGTERM");
    const timer = setTimeout(() => terminate(child, "SIGKILL"), 250);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
  }
}
function childEnvironment(home?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG || "en_US.UTF-8",
    HOME: home || process.env.HOME,
    CI: "1",
    NO_BROWSER: "1",
    QODER_PERSONAL_ACCESS_TOKEN: config.QODER_PAT,
  };
  for (const key of [
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
  ])
    if (process.env[key]) env[key] = process.env[key];
  if (home) env.QODER_CONFIG_DIR = join(home, ".qoder");
  // Test-only fixture tracing never contains production credentials.
  if (process.env.NODE_ENV === "test" && process.env.QODER_TRACE_FILE)
    env.QODER_TRACE_FILE = process.env.QODER_TRACE_FILE;
  return env;
}
export async function listCliModels(): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "qoder-models-")));
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = execFile(
        config.QODERCLI_BIN,
        ["--list-models"],
        {
          env: childEnvironment(home),
          cwd: home,
          timeout: config.QODER_MODEL_DISCOVERY_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          killSignal: "SIGKILL",
        },
        (error, stdout, stderr) => {
          if (error)
            reject(
              Object.assign(
                new ProxyError(
                  "CLI model discovery failed",
                  503,
                  "model_discovery_unavailable",
                ),
                {
                  authenticationRejected:
                    /\b(?:401|403)\b|invalid personal access token|unauthori[sz]ed|authentication.*(?:failed|rejected)|token.*expired/i.test(
                      stderr + stdout,
                    ),
                },
              ),
            );
          else resolve(stdout);
        },
      );
      children.add(child);
      child.once("close", () => children.delete(child));
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
export async function checkQoderCli(): Promise<string | null> {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "qoder-readiness-")),
  );
  try {
    return await new Promise<string | null>((resolve) => {
      let output = "",
        settled = false;
      const finish = (result: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      let child: ChildProcess;
      try {
        child = spawn(config.QODERCLI_BIN, ["--version"], {
          stdio: ["ignore", "pipe", "pipe"],
          env: childEnvironment(home),
          shell: false,
        });
      } catch {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(null);
      }, 5000);
      child.stdout?.on("data", (data: Buffer) => {
        output = (output + data.toString()).slice(0, 1024);
      });
      child.on("error", () => finish(null));
      child.on("close", (code) =>
        finish(
          code === 0 && output.trim() ? output.trim().slice(0, 100) : null,
        ),
      );
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
export async function runQoder(
  prompt: string,
  model: string,
  signal?: AbortSignal,
  onText?: (text: string) => Promise<void>,
  outputTokens = config.QODER_MAX_OUTPUT_TOKENS,
): Promise<QoderResult> {
  if (Buffer.byteLength(prompt) > config.MAX_PROMPT_BYTES)
    throw new ProxyError(
      "Prompt exceeds configured byte limit",
      413,
      "context_length_exceeded",
    );
  const release = await admission.acquire(signal);
  let cwd: string | undefined;
  try {
    if (signal?.aborted)
      throw new ProxyError("Request cancelled", 499, "cancelled");
    cwd = await realpath(await mkdtemp(join(tmpdir(), "qoder-inference-")));
    return await execute(cwd, prompt, model, signal, onText, outputTokens);
  } finally {
    if (cwd) await rm(cwd, { recursive: true, force: true });
    release();
  }
}
async function execute(
  cwd: string,
  prompt: string,
  model: string,
  signal: AbortSignal | undefined,
  onText: ((text: string) => Promise<void>) | undefined,
  outputTokens: string,
): Promise<QoderResult> {
  // stdin avoids ARG_MAX and process-list disclosure. Isolated HOME/cwd and
  // disabled built-ins keep Hermes responsible for executing external tools.
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--model",
    model,
    "--max-output-tokens",
    outputTokens,
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--no-session-persistence",
  ];
  const child = spawn(config.QODERCLI_BIN, args, {
    cwd,
    env: childEnvironment(cwd),
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    detached: process.platform !== "win32",
  });
  children.add(child);
  let failure: Error | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (error: Error) => {
    if (failure) return;
    failure = error;
    terminate(child, "SIGTERM");
    forceTimer = setTimeout(() => terminate(child, "SIGKILL"), 250);
    forceTimer.unref();
  };
  const abort = () =>
    cancel(new ProxyError("Request cancelled", 499, "cancelled"));
  const timeout = setTimeout(
    () =>
      cancel(new ProxyError("Qoder request timed out", 504, "timeout_error")),
    config.QODER_TIMEOUT_MS,
  );
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const closed = new Promise<number | null>((resolve) => {
    child.on("error", () => {
      failure = new ProxyError(
        "Unable to start Qoder CLI",
        502,
        "upstream_unavailable",
      );
    });
    child.on("close", resolve);
  });
  child.stdin.on("error", () => {
    /* EPIPE is reported by close/error */
  });
  child.stdin.end(prompt);
  let bytes = 0,
    text = "",
    resultText = "",
    reason = "stop",
    sawDelta = false;
  child.stderr.on("data", (data: Buffer) => {
    bytes += data.length;
    if (bytes > config.MAX_OUTPUT_BYTES)
      cancel(
        new ProxyError("CLI output exceeded byte limit", 502, "output_limit"),
      );
  });
  const append = async (piece: string) => {
    text += piece;
    if (onText) await onText(piece);
  };
  const parse = async (line: string) => {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!event || typeof event !== "object") return;
    if (event.type === "result") {
      if (
        event.is_error === true ||
        (typeof event.subtype === "string" && event.subtype.startsWith("error"))
      )
        throw new ProxyError(
          "Qoder reported an unsuccessful result",
          502,
          "upstream_error",
        );
      if (typeof event.result === "string") resultText = event.result;
      return;
    }
    const nested = event.event as
      | {
          type?: string;
          delta?: { type?: string; text?: string; stop_reason?: string };
        }
      | undefined;
    if (
      event.type === "stream_event" &&
      nested?.type === "content_block_delta" &&
      nested.delta?.type === "text_delta" &&
      typeof nested.delta.text === "string"
    ) {
      sawDelta = true;
      await append(nested.delta.text);
      return;
    }
    if (event.type === "stream_event" && nested?.type === "message_delta") {
      reason = normalizeFinishReason(nested.delta?.stop_reason);
      return;
    }
    if (event.type === "assistant") {
      const message = event.message as
        { content?: unknown; stop_reason?: unknown } | undefined;
      if (message?.stop_reason)
        reason = normalizeFinishReason(message.stop_reason);
      if (!sawDelta) await append(extractTextContent(message));
    }
  };
  try {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    for await (const raw of child.stdout) {
      if (failure) continue;
      const chunk = raw as Buffer;
      bytes += chunk.length;
      if (bytes > config.MAX_OUTPUT_BYTES) {
        cancel(
          new ProxyError("CLI output exceeded byte limit", 502, "output_limit"),
        );
        continue;
      }
      pending += decoder.write(chunk);
      let at: number;
      while ((at = pending.indexOf("\n")) >= 0) {
        await parse(pending.slice(0, at));
        pending = pending.slice(at + 1);
      }
    }
    pending += decoder.end();
    if (!failure && pending.trim()) await parse(pending);
  } catch (error) {
    cancel(
      error instanceof Error
        ? error
        : new ProxyError("Invalid CLI output", 502),
    );
  }
  const code = await closed;
  clearTimeout(timeout);
  if (forceTimer) clearTimeout(forceTimer);
  signal?.removeEventListener("abort", abort);
  children.delete(child);
  if (failure) throw failure;
  if (code !== 0)
    throw new ProxyError(
      "Qoder CLI exited unsuccessfully",
      502,
      "upstream_error",
    );
  if (!text && resultText) await append(resultText);
  if (!text.trim())
    throw new ProxyError(
      "Qoder produced no assistant output",
      502,
      "empty_response",
    );
  return { text, finishReason: reason };
}
