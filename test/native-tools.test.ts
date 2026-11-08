import { it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
const children: ChildProcess[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const c of children) c.kill("SIGKILL");
  for (const p of directories) rmSync(p, { recursive: true, force: true });
  children.length = 0;
  directories.length = 0;
});
function server() {
  const root = mkdtempSync(join(tmpdir(), "qoder-capture-test-"));
  directories.push(root);
  const calls = join(root, "calls.jsonl");
  const sentinel = join(root, "must-not-execute");
  const state = join(root, "bridge.json");
  writeFileSync(
    state,
    JSON.stringify({
      callsPath: calls,
      maxCalls: 1,
      tools: [
        {
          type: "function",
          function: {
            name: "terminal",
            description: "Run a command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
              additionalProperties: false,
            },
          },
        },
      ],
    }),
  );
  const child = spawn(
    process.execPath,
    [resolve("dist/helpers/toolCaptureMcp.js"), state],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(child);
  let next = 0;
  const pending = new Map<number, (r: any) => void>();
  createInterface({ input: child.stdout! }).on("line", (line) => {
    const data = JSON.parse(line);
    pending.get(data.id)?.(data);
  });
  return {
    root,
    calls,
    sentinel,
    send(method: string, params: unknown = {}) {
      const id = ++next;
      child.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
      return new Promise<any>((resolve, reject) => {
        pending.set(id, resolve);
        setTimeout(() => reject(Error("MCP response timed out")), 750).unref();
      });
    },
    call(params: unknown) {
      child.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "tools/call",
          params,
        }) + "\n",
      );
    },
  };
}
it("exposes only client-declared typed tools through native MCP discovery", async () => {
  const s = server();
  const init = await s.send("initialize", { protocolVersion: "2024-11-05" });
  expect(init.result.protocolVersion).toBe("2024-11-05");
  const list = await s.send("tools/list");
  expect(list.result.tools).toHaveLength(1);
  expect(list.result.tools[0].inputSchema.required).toEqual(["command"]);
  expect(list.result.tools[0].description).toContain("terminal");
});
it("records a valid request without executing it or fabricating a result", async () => {
  const s = server();
  const list = await s.send("tools/list");
  const command = `touch ${s.sentinel}\nprintf '%s' 'café 🙂 "quoted" \\\\path'\n`;
  s.call({
    name: list.result.tools[0].name,
    arguments: { command },
  });
  await new Promise((r) => setTimeout(r, 70));
  expect(existsSync(s.sentinel)).toBe(false);
  const records = readFileSync(s.calls, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(records).toEqual([
    { name: "terminal", arguments: { command } },
  ]);
  s.call({
    name: list.result.tools[0].name,
    arguments: { command: "another" },
  });
  await new Promise((r) => setTimeout(r, 30));
  expect(readFileSync(s.calls, "utf8").trim().split("\n")).toHaveLength(1);
});
it("rejects unknown tools and malformed arguments before recording anything", async () => {
  const s = server();
  const list = await s.send("tools/list");
  expect(
    (
      await s.send("tools/call", {
        name: "Bash",
        arguments: { command: "bad" },
      })
    ).result.isError,
  ).toBe(true);
  expect(
    (
      await s.send("tools/call", {
        name: list.result.tools[0].name,
        arguments: { command: 42 },
      })
    ).result.isError,
  ).toBe(true);
  expect(existsSync(s.calls)).toBe(false);
});

it("promotes only schemas returned by the actual external describe tool and preserves the execution bridge", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { expandDeferredTools } = require(
    resolve("dist/helpers/nativeTools.js"),
  );
  const bridge = {
    type: "function",
    function: {
      name: "tool_call",
      parameters: {
        type: "object",
        properties: { calls: { type: "array" } },
        required: ["calls"],
      },
    },
  };
  const metadata = {
    tools: {
      mcp__socket__depscore: {
        description: "Socket package scores",
        parameters: {
          type: "object",
          properties: { packages: { type: "array" } },
          required: ["packages"],
        },
      },
    },
  };
  const history = (source: string) => [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "described",
          type: "function",
          function: {
            name: source,
            arguments: '{"names":["mcp__socket__depscore"]}',
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "described",
      content: JSON.stringify(metadata),
    },
  ];
  const expanded = expandDeferredTools([bridge], history("tool_describe"));
  expect(expanded).toHaveLength(2);
  expect(expanded[1].function.name).toBe("mcp__socket__depscore");
  expect(expanded[1].forward).toEqual({
    bridge: "tool_call",
    target: "mcp__socket__depscore",
  });
  expect(expandDeferredTools([bridge], history("web_extract"))).toHaveLength(1);
  expect(expandDeferredTools([], history("tool_describe"))).toEqual([]);
  const unsolicited = history("tool_describe");
  unsolicited[0]!.tool_calls![0]!.function.arguments =
    '{"names":["different_tool"]}';
  expect(expandDeferredTools([bridge], unsolicited)).toHaveLength(1);
});

it("waits for complete recorder lines instead of rejecting a partial filesystem write", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { prepareNativeTools } = require(
    resolve("dist/helpers/nativeTools.js"),
  );
  const root = mkdtempSync(join(tmpdir(), "qoder-partial-capture-"));
  directories.push(root);
  const bridge = await prepareNativeTools(root, {
    tools: [
      {
        type: "function",
        function: {
          name: "terminal",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      },
    ],
    choice: "auto",
    parallel: false,
  });
  const config = JSON.parse(readFileSync(bridge.configPath, "utf8"));
  const state = JSON.parse(
    readFileSync(config.mcpServers.hermes.args[1], "utf8"),
  );
  const record =
    JSON.stringify({
      name: "terminal",
      arguments: { command: "echo Unicode 🙂 }" },
    }) + "\n";
  writeFileSync(state.callsPath, record.slice(0, 18));
  expect(await bridge.readCalls(4096)).toEqual([]);
  writeFileSync(state.callsPath, record);
  expect(await bridge.readCalls(4096)).toEqual([
    { name: "terminal", arguments: { command: "echo Unicode 🙂 }" } },
  ]);
});
