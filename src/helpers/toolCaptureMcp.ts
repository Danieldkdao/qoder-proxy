/** Request-local MCP recorder. It NEVER executes a client function or returns a fabricated tool result. */
import { createInterface } from "node:readline";
import { readFileSync, appendFileSync, existsSync, statSync } from "node:fs";
import type { CaptureTool } from "./nativeTools";
import { nativeAlias } from "./nativeTools";
import { parseToolCallFromText } from "./toolPrompt";
const state = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
  tools: CaptureTool[];
  callsPath: string;
  maxCalls: number;
};
let recorded = 0;
const tools = state.tools.map((tool, index) => ({
  name: nativeAlias(tool, index),
  description:
    tool.function.name +
    ": " +
    (tool.function.description || "Request this external agent function"),
  inputSchema: tool.function.parameters ?? { type: "object" },
}));
function reply(id: unknown, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on(
  "line",
  (line) => {
    let request: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return;
      request = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (request.id === undefined) return;
    const params =
      request.params &&
      typeof request.params === "object" &&
      !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    if (request.method === "initialize") {
      reply(request.id, {
        protocolVersion:
          typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "hermes-tool-capture", version: "1.0.0" },
      });
      return;
    }
    if (request.method === "tools/list") {
      reply(request.id, { tools });
      return;
    }
    if (request.method === "ping") {
      reply(request.id, {});
      return;
    }
    if (request.method !== "tools/call") {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "Method not found" },
        }) + "\n",
      );
      return;
    }
    try {
      const index = tools.findIndex((t) => t.name === params.name);
      if (index < 0) throw Error("Unknown client tool");
      const call = {
        name: state.tools[index]!.function.name,
        arguments: params.arguments,
      };
      parseToolCallFromText(JSON.stringify({ tool_call: call }), state.tools);
      if (recorded >= state.maxCalls) return;
      const forward = state.tools[index]!.forward;
      const external = forward
        ? {
            name: forward.bridge,
            arguments: {
              calls: [{ name: forward.target, arguments: call.arguments }],
            },
          }
        : call;
      parseToolCallFromText(
        JSON.stringify({ tool_call: external }),
        state.tools,
      );
      const data = JSON.stringify(external) + "\n";
      if (
        Buffer.byteLength(data) +
          (existsSync(state.callsPath) ? statSync(state.callsPath).size : 0) >
        1024 * 1024
      )
        throw Error("Request too large");
      appendFileSync(state.callsPath, data, { mode: 0o600 });
      recorded++;
      // Leave the MCP call pending. The parent captures it and terminates this CLI
      // turn; Hermes executes it and supplies its actual result on the next turn.
    } catch {
      reply(request.id, {
        isError: true,
        content: [
          {
            type: "text",
            text: "Unknown tool or invalid arguments. Follow the advertised JSON schema.",
          },
        ],
      });
    }
  },
);
