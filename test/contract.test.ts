import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { createHmac } from "node:crypto";

const require = createRequire(import.meta.url);
const source = process.env.REVIEW_LEGACY ? "src" : "dist";
const format = require(resolve(source, "helpers/format.js"));
const toolPrompt = require(resolve(source, "helpers/toolPrompt.js"));
const tool = {
  type: "function",
  function: {
    name: "terminal",
    description: "Execute a command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
};
const tools = [tool];
const messages = [{ role: "user", content: "hello" }];

describe("conversation integrity contract", () => {
  it("retains original requirements after more than ten messages", () => {
    const history = [
      { role: "user", content: "ORIGINAL_TASK" },
      ...Array.from({ length: 20 }, (_, n) => ({
        role: "assistant",
        content: `step ${n}`,
      })),
    ];
    expect(format.messagesToPrompt(history)).toContain("ORIGINAL_TASK");
    expect(
      toolPrompt.buildPromptWithTools(history, tools, format.messagesToPrompt),
    ).toContain("ORIGINAL_TASK");
  });
  it("retains every system/developer instruction", () => {
    const prompt = format.messagesToPrompt([
      { role: "system", content: "FIRST" },
      { role: "system", content: "SECOND" },
      { role: "developer", content: "DEVELOPER" },
      ...messages,
    ]);
    expect(prompt).toContain("FIRST");
    expect(prompt).toContain("SECOND");
    expect(prompt).toContain("DEVELOPER");
  });
  it("preserves tool names, arguments, call IDs and matching results", () => {
    const history = [
      ...messages,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_unique",
            type: "function",
            function: {
              name: "terminal",
              arguments: '{"command":"UNIQUE_COMMAND"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_unique", content: "UNIQUE_RESULT" },
    ];
    for (const prompt of [
      format.messagesToPrompt(history),
      toolPrompt.buildPromptWithTools(history, tools, format.messagesToPrompt),
    ]) {
      expect(prompt).toContain("call_unique");
      expect(prompt).toContain("UNIQUE_COMMAND");
      expect(prompt).toContain("UNIQUE_RESULT");
    }
  });
  it("rejects unsupported image input instead of silently discarding it", () => {
    expect(() =>
      format.messagesToPrompt([
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "https://example.com/a.png" },
            },
          ],
        },
      ]),
    ).toThrow(/image|unsupported/i);
  });
  it("serializes native tool arguments as JSON strings", () => {
    const result = format.extractToolCalls([
      {
        type: "function",
        id: "call_1",
        name: "terminal",
        input: { command: "pwd" },
      },
    ]);
    expect(result[0].function.arguments).toBe('{"command":"pwd"}');
  });
});

describe("tool safety contract", () => {
  it("does not turn prose examples into actions", () => {
    expect(
      toolPrompt.parseToolCallFromText(
        'For example: {"tool_call":{"name":"terminal","arguments":{"command":"pwd"}}}',
        tools,
      ),
    ).toBeNull();
  });
  it("rejects undeclared tools and invalid schema arguments", () => {
    for (const call of [
      { name: "invented", arguments: {} },
      { name: "terminal", arguments: 12 },
      { name: "terminal", arguments: {} },
      { name: "terminal", arguments: { command: 42 } },
    ]) {
      expect(() =>
        toolPrompt.parseToolCallFromText(
          JSON.stringify({ tool_call: call }),
          tools,
        ),
      ).toThrow();
    }
  });
  it("accepts quoted braces inside valid tool arguments", () => {
    expect(
      toolPrompt.parseToolCallFromText(
        '{"tool_call":{"name":"terminal","arguments":{"command":"echo }"}}}',
        tools,
      )?.arguments,
    ).toEqual({ command: "echo }" });
  });
  it("supports multiple explicitly requested tool calls", () => {
    const parsed = toolPrompt.parseToolCallFromText(
      JSON.stringify({
        tool_calls: [
          { name: "terminal", arguments: { command: "pwd" } },
          { name: "terminal", arguments: { command: "git status" } },
        ],
      }),
      tools,
    );
    expect(toolPrompt.toOpenAIToolCalls(parsed, "call_test")).toHaveLength(2);
  });
});

let server: ChildProcess;
let base: string;
let dir: string;
let logs = "";
async function request(body: unknown, headers: Record<string, string> = {}) {
  return fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
function events(raw: string): any[] {
  return raw
    .split("\n")
    .filter((s) => s.startsWith("data: {"))
    .map((s) => JSON.parse(s.slice(6)));
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "qoder-contract-"));
  const binary = join(dir, "qoder.ts");
  writeFileSync(
    binary,
    "#!" +
      process.execPath +
      "\n" +
      readFileSync(resolve("test/fake-qoder.fixture.ts"), "utf8"),
  );
  chmodSync(binary, 0o700);
  const port = await new Promise<number>((resolvePort) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as any).port;
      s.close(() => resolvePort(p));
    });
  });
  base = `http://127.0.0.1:${port}`;
  server = spawn(
    process.execPath,
    [
      "--import",
      resolve("test/catalog-preload.fixture.ts"),
      resolve(source, "server.js"),
    ],
    {
      env: {
        ...process.env,
        PORT: String(port),
        QODERCLI_BIN: binary,
        QODER_PERSONAL_ACCESS_TOKEN: "test-pat",
        PROXY_API_KEY: "test-key",
        DASHBOARD_PASSWORD: "test-password",
        DASHBOARD_SECRET: "test-secret",
        NODE_ENV: "test",
        QODER_TIMEOUT_MS: "1000",
        QODER_MAX_CONCURRENCY: "1",
        QODER_MAX_QUEUE: "1",
        QODER_TRACE_FILE: join(dir, "trace"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout!.on("data", (d) => {
    logs += d;
  });
  server.stderr!.on("data", (d) => {
    logs += d;
  });
  for (let n = 0; n < 150; n++) {
    try {
      if ((await fetch(base + "/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 30));
  }
  throw Error("Server failed to start: " + logs);
}, 15000);
afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 150));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("HTTP / Hermes provider contract", () => {
  it("returns normal final text when streaming with tools", async () => {
    const response = await request({
      model: "auto",
      messages,
      tools,
      stream: true,
    });
    const chunks = events(await response.text());
    expect(
      chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join(""),
    ).toBe("FINAL_ANSWER");
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
  });
  it("returns indexed streamed tool calls with JSON arguments", async () => {
    const response = await request({
      model: "auto",
      messages: [{ role: "user", content: "RETURN_TOOL" }],
      tools,
      stream: true,
    });
    const chunks = events(await response.text());
    const call = chunks.flatMap(
      (c) => c.choices?.[0]?.delta?.tool_calls ?? [],
    )[0];
    expect(call.index).toBe(0);
    expect(JSON.parse(call.function.arguments)).toEqual({ command: "pwd" });
    expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });
  it("completes a tool-call/result/final-answer round trip", async () => {
    const history: any[] = [{ role: "user", content: "WORKFLOW_REQUEST" }];
    const first = await request({ model: "auto", messages: history, tools });
    const assistant = (await first.json()).choices[0].message;
    expect(assistant.tool_calls).toHaveLength(1);
    history.push(assistant, {
      role: "tool",
      tool_call_id: assistant.tool_calls[0].id,
      content: "working dir: /project",
    });
    const second = await request({
      model: "auto",
      messages: history,
      tools,
      stream: true,
    });
    expect(
      events(await second.text())
        .map((c) => c.choices?.[0]?.delta?.content ?? "")
        .join(""),
    ).toBe("WORKFLOW_DONE");
  });
  it("explicitly reports unavailable usage when requested in streams", async () => {
    const response = await request({
      model: "auto",
      messages,
      stream: true,
      stream_options: { include_usage: true },
    });
    const chunks = events(await response.text());
    expect(chunks.at(-1)).toMatchObject({ choices: [], usage: null });
  });
  it("rejects malformed stream usage options", async () => {
    for (const options of [[], { include_usage: "yes" }, { invented: true }]) {
      expect(
        (
          await request({
            model: "auto",
            messages,
            stream: true,
            stream_options: options,
          })
        ).status,
      ).toBe(400);
    }
  });
  it("honors tool_choice none", async () => {
    const response = await request({
      model: "auto",
      messages: [{ role: "user", content: "RETURN_TOOL" }],
      tools,
      tool_choice: "none",
    });
    const data = await response.json();
    expect(data.choices?.[0]?.message?.tool_calls).toBeUndefined();
  });
  it("enforces required and named tool choices", async () => {
    for (const choice of [
      "required",
      { type: "function", function: { name: "terminal" } },
    ]) {
      const response = await request({
        model: "auto",
        messages,
        tools,
        tool_choice: choice,
      });
      expect(response.status).toBe(502);
    }
  });
  it("returns a recognizable stream error on CLI failure", async () => {
    const response = await request({
      model: "auto",
      messages: [{ role: "user", content: "FAIL_EXIT" }],
      stream: true,
    });
    expect(events(await response.text()).some((c) => c.error)).toBe(true);
  });
  it("rejects unsupported settings instead of ignoring them", async () => {
    for (const option of [
      { temperature: 0.5 },
      { max_tokens: 50 },
      { response_format: { type: "json_object" } },
    ]) {
      expect(
        (await request({ model: "auto", messages, ...option })).status,
      ).toBe(400);
    }
  });
  it("validates malformed message structures with 400 errors", async () => {
    for (const bad of [
      [null],
      [{ role: "user", content: 123 }],
      [{ role: "alien", content: "hello" }],
    ])
      expect((await request({ model: "auto", messages: bad })).status).toBe(
        400,
      );
  });
  it("does not leak diagnostic output into model answers", async () => {
    const response = await request({
      model: "auto",
      messages: [{ role: "user", content: "DIAGNOSTICS" }],
    });
    expect((await response.json()).choices[0].message.content).toBe(
      "FINAL_ANSWER",
    );
  });
  it("preserves UTF-8 characters across CLI chunks", async () => {
    const response = await request({
      model: "auto",
      messages: [{ role: "user", content: "UNICODE" }],
    });
    expect((await response.json()).choices[0].message.content).toBe("🙂");
  });
  it("rejects empty and structured CLI error results", async () => {
    for (const text of ["EMPTY_OUTPUT", "RESULT_ERROR"])
      expect(
        (
          await request({
            model: "auto",
            messages: [{ role: "user", content: text }],
          })
        ).status,
      ).toBe(502);
  });
  it("returns 400 for invalid JSON", async () => {
    const response = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });
    expect(response.status).toBe(400);
  });
  it("accepts large context without overflowing process argument limits", async () => {
    expect(
      (
        await request({
          model: "auto",
          messages: [{ role: "user", content: "x".repeat(400000) }],
        })
      ).status,
    ).toBe(200);
  });
  it("enforces timeouts with recognizable errors", async () => {
    const response = await request({
      model: "auto",
      messages: [{ role: "user", content: "HANG_TIMEOUT" }],
    });
    expect(response.status).toBe(504);
  });
  it("bounds concurrent CLI work and rejects excess queued requests", async () => {
    const body = {
      model: "auto",
      messages: [{ role: "user", content: "DELAY_REQUEST" }],
    };
    const responses = await Promise.all([
      request(body),
      request(body),
      request(body),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 503]);
  });
  it("cancels CLI work when a client disconnects after sending the request", async () => {
    const controller = new AbortController();
    const pending = fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
      },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "CANCEL_REQUEST" }],
      }),
      signal: controller.signal,
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, 150));
    controller.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 150));
    expect(readFileSync(join(dir, "trace"), "utf8")).toContain("CANCELLED");
  });
  it("does not expose the proxy key to dashboard JavaScript", async () => {
    const login = await fetch(base + "/dashboard/login", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "password=test-password",
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const response = await fetch(base + "/dashboard/api/config", {
      headers: { Cookie: cookie },
    });
    expect(await response.text()).not.toContain("test-key");
  });
  it("rejects expired correctly signed dashboard sessions", async () => {
    const data = "1.random";
    const sig = createHmac("sha256", "test-secret").update(data).digest("hex");
    const token = Buffer.from(`${data}.${sig}`).toString("base64url");
    const response = await fetch(base + "/dashboard/api/config", {
      headers: { Cookie: `qoder_dash=${token}` },
      redirect: "manual",
    });
    expect(response.status).toBe(401);
  });
  it("revokes dashboard sessions on logout", async () => {
    const login = await fetch(base + "/dashboard/login", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "password=test-password",
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    await fetch(base + "/dashboard/logout", {
      redirect: "manual",
      headers: { Cookie: cookie },
    });
    expect(
      (
        await fetch(base + "/dashboard/api/config", {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(401);
  });
  it("discovers CLI-compatible live models for Desktop and accepts the discovered ID in chat", async () => {
    const response = await fetch(base + "/v1/models", {
      headers: { Authorization: "Bearer test-key" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.object).toBe("list");
    expect(
      body.data.every(
        (m: any) =>
          m.supports_reasoning === false && m.supports_vision === false,
      ),
    ).toBe(true);
    expect(body.data.map((m: any) => m.id)).toEqual([
      "auto",
      "next_generation",
    ]);
    const completion = await request({ model: "next_generation", messages });
    expect(completion.status).toBe(200);
    expect((await completion.json()).model).toBe("next_generation");
    for (const model of ["api_only", "constructor", "__proto__", "not-a-model"])
      expect((await request({ model, messages })).status).toBe(400);
  });
  it("serves names to Hermes while translating completions to canonical CLI IDs", async () => {
    const url = base + "/hermes/v1";
    expect((await fetch(url + "/models")).status).toBe(401);
    const response = await fetch(url + "/models", {
      headers: { Authorization: "Bearer test-key" },
    });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.data.map((m: any) => m.id)).toEqual([
      "Auto",
      "Next Generation",
    ]);
    expect(data.data[1].qoder.id).toBe("next_generation");
    const answer = await fetch(url + "/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "Next Generation",
        messages: [{ role: "user", content: "REPORT_MODEL" }],
      }),
    });
    expect(answer.status).toBe(200);
    const body = await answer.json();
    expect(body.model).toBe("Next Generation");
    expect(body.choices[0].message.content).toBe("CLI_MODEL=next_generation");
    expect((await request({ model: "Next Generation", messages })).status).toBe(
      400,
    );
  });
  it("does not advertise misleading OpenAI and Claude model aliases", async () => {
    const response = await fetch(base + "/v1/models", {
      headers: { Authorization: "Bearer test-key" },
    });
    expect(
      (await response.json()).data.some((m: any) => /gpt|claude/.test(m.id)),
    ).toBe(false);
  });
});

describe("build and dashboard contracts", () => {
  it("never masks CLI installation failure", () => {
    expect(readFileSync("Dockerfile", "utf8")).not.toContain("|| true");
  });
  it("pins the CLI version in container builds", () => {
    expect(readFileSync("Dockerfile", "utf8")).toMatch(
      /@qoder-ai\/qodercli@(?:\$\{|[0-9])/,
    );
  });
  it("does not publish a fork into the upstream image namespace", () => {
    expect(
      readFileSync(".github/workflows/docker-publish.yml", "utf8"),
    ).not.toContain("ghcr.io/foxy1402/qoder-proxy");
  });
  it("escapes untrusted dashboard JSON before inserting HTML", () => {
    // Public browser helper is intentionally tested by behavior, with no browser network calls.
    const browserSource = readFileSync(
      resolve(source, "dashboard/public/app.js"),
      "utf8",
    );
    const start = browserSource.indexOf("function syntaxJson(");
    const end = browserSource.indexOf("function copyText(", start);
    const fn = new Function(
      browserSource.slice(
        browserSource.indexOf("function escHtml("),
        browserSource.indexOf("function mdToHtml("),
      ) +
        browserSource.slice(start, end) +
        "; return syntaxJson;",
    )();
    expect(fn({ content: "<img src=x onerror=alert(1)>" })).not.toContain(
      "<img",
    );
  });
});
