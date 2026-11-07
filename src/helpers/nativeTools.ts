import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Tool, ToolChoice, ParsedCall, Message } from "../types";
import { parseToolCallFromText, validateTools } from "./toolPrompt";
import { ProxyError } from "../errors";
export interface NativeToolOptions {
  tools: Tool[];
  choice: ToolChoice;
  parallel: boolean;
  messages?: Message[];
}
export interface CaptureTool extends Tool {
  forward?: { bridge: string; target: string };
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function expandDeferredTools(
  tools: Tool[],
  messages: Message[],
): CaptureTool[] {
  const bridge = tools.find((t) => t.function.name === "tool_call");
  if (
    !bridge ||
    !object(bridge.function.parameters?.properties) ||
    !object(bridge.function.parameters.properties.calls)
  )
    return tools;
  const requested = new Map<string, Set<string>>();
  const discovered = new Map<string, CaptureTool>();
  for (const message of messages) {
    if (message.role === "assistant")
      for (const call of message.tool_calls ?? []) {
        if (call.function.name !== "tool_describe") continue;
        try {
          const args = JSON.parse(call.function.arguments);
          const names = Array.isArray(args.names) ? args.names : [args.names];
          requested.set(
            call.id,
            new Set(
              names.filter((n: unknown): n is string => typeof n === "string"),
            ),
          );
        } catch {
          continue;
        }
      }
    if (
      message.role !== "tool" ||
      !message.tool_call_id ||
      !requested.has(message.tool_call_id) ||
      typeof message.content !== "string"
    )
      continue;
    try {
      const data: unknown = JSON.parse(message.content);
      if (!object(data) || !object(data.tools)) continue;
      for (const [name, metadata] of Object.entries(data.tools)) {
        if (
          !requested.get(message.tool_call_id)!.has(name) ||
          tools.some((t) => t.function.name === name) ||
          !object(metadata) ||
          !object(metadata.parameters)
        )
          continue;
        const candidate: CaptureTool = {
          type: "function",
          function: {
            name,
            description:
              typeof metadata.description === "string"
                ? metadata.description
                : undefined,
            parameters: metadata.parameters,
          },
          forward: { bridge: bridge.function.name, target: name },
        };
        try {
          validateTools([candidate]);
        } catch {
          continue;
        }
        discovered.set(name, candidate);
      }
    } catch {
      continue;
    }
  }
  return [...tools, ...discovered.values()].slice(0, 128);
}
export const nativeAlias = (tool: Tool, index: number) =>
  `f${index}_${tool.function.name.slice(0, 32)}`;
export async function prepareNativeTools(
  cwd: string,
  options: NativeToolOptions,
) {
  const selected =
    typeof options.choice === "object"
      ? options.tools.filter(
          (t) =>
            t.function.name ===
            (options.choice as { function: { name: string } }).function.name,
        )
      : options.tools;
  const exposed = expandDeferredTools(selected, options.messages ?? []);
  const callsPath = join(cwd, "tool-requests.jsonl");
  const statePath = join(cwd, "tool-state.json");
  const configPath = join(cwd, "mcp.json");
  await writeFile(
    statePath,
    JSON.stringify({
      tools: exposed,
      callsPath,
      maxCalls: options.parallel ? 32 : 1,
    }),
    { mode: 0o600 },
  );
  await writeFile(
    configPath,
    JSON.stringify({
      mcpServers: {
        hermes: {
          command: process.execPath,
          args: [join(__dirname, "toolCaptureMcp.js"), statePath],
          env: {
            QODER_PERSONAL_ACCESS_TOKEN: "",
            QODER_PAT: "",
            PROXY_API_KEY: "",
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  const names = exposed.map((t, i) => "mcp__hermes__" + nativeAlias(t, i));
  return {
    configPath,
    names,
    async readCalls(limit: number): Promise<ParsedCall[]> {
      let text: string;
      try {
        text = await readFile(callsPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      if (Buffer.byteLength(text) > limit)
        throw new ProxyError(
          "Captured tool requests exceed output limit",
          502,
          "output_limit",
        );
      const complete = text.lastIndexOf("\n");
      const lines =
        complete < 0 ? [] : text.slice(0, complete).split("\n").filter(Boolean);
      if (lines.length > 32)
        throw new ProxyError(
          "Too many native tool requests",
          502,
          "invalid_tool_call",
        );
      return lines.map(
        (line) =>
          parseToolCallFromText(
            JSON.stringify({ tool_call: JSON.parse(line) }),
            selected,
          ) as ParsedCall,
      );
    },
  };
}
