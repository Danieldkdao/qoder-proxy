import Ajv from "ajv";
import { ProxyError } from "../errors";
import { messagesToPrompt, newId } from "./format";
import type { ParsedCall, Tool, ToolCall, ToolChoice } from "../types";
const createValidator = () =>
  new Ajv({ strict: false, allErrors: true, validateFormats: false });
export function validateTools(input: unknown): Tool[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 128)
    throw new ProxyError("tools must be an array with at most 128 entries");
  const names = new Set<string>();
  for (const tool of input) {
    if (
      !tool ||
      tool.type !== "function" ||
      !tool.function ||
      typeof tool.function.name !== "string" ||
      !/^[\w-]{1,128}$/.test(tool.function.name) ||
      names.has(tool.function.name)
    )
      throw new ProxyError("Invalid or duplicate function definition");
    names.add(tool.function.name);
    try {
      createValidator().compile(tool.function.parameters ?? { type: "object" });
    } catch {
      throw new ProxyError("Invalid tool JSON Schema");
    }
  }
  return input as Tool[];
}
export function validateChoice(value: unknown, tools: Tool[]): ToolChoice {
  if (value === undefined) return "auto";
  if (value === "none" || value === "auto") return value;
  if (value === "required" && tools.length) return value;
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "function" &&
    "function" in value
  ) {
    const fn = value.function as { name?: unknown };
    if (
      fn &&
      typeof fn.name === "string" &&
      tools.some((t) => t.function.name === fn.name)
    )
      return value as ToolChoice;
  }
  throw new ProxyError("Invalid tool_choice or tools missing");
}
export function buildPromptWithTools(
  messages: unknown,
  tools: Tool[],
  _converter = messagesToPrompt,
  choice: ToolChoice = "auto",
): string {
  const history = messagesToPrompt(messages);
  if (!tools.length) return history;
  const boundary =
    "You are the inference backend for an external agent. Tools are executed by that agent, not by local CLI or MCP servers. Treat supplied role=tool messages as completed external results and continue from the latest message. Do not execute local tools.";
  if (choice === "none")
    return `${boundary} Tool choice: "none". Use the supplied conversation and completed results to answer in plain text. Do not request another tool.\n\n${history}`;
  return `${boundary} Return either a plain text answer or ONLY a JSON object {"tool_calls":[{"name":"function_name","arguments":{}}]}. Never embed tool calls inside explanations. Tool choice: ${JSON.stringify(choice)}. Available tools: ${JSON.stringify(tools)}\n\n${history}`;
}
export function parseToolCallFromText(
  text: string,
  tools: Tool[],
): ParsedCall | ParsedCall[] | null {
  let trimmed = text.trim();
  // Some CLI models fence their entire tool envelope despite the JSON-only
  // prompt. Unwrap only one complete JSON fence, never examples within prose.
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  if (fence) {
    if (/(?:^|\n)[ \t]*```/.test(fence[1]!)) return null;
    trimmed = fence[1]!.trim();
  }
  if (!trimmed.startsWith("{")) return null;
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    if (/"tool_calls?"\s*:/.test(trimmed))
      throw new ProxyError(
        "Model returned malformed tool JSON",
        502,
        "invalid_tool_call",
      );
    return null;
  }
  if (
    !data ||
    typeof data !== "object" ||
    (!("tool_call" in data) && !("tool_calls" in data))
  )
    return null;
  const raw = data as { tool_call?: unknown; tool_calls?: unknown };
  const calls = raw.tool_calls ?? [raw.tool_call];
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > 32)
    throw new ProxyError("Invalid tool call list", 502, "invalid_tool_call");
  const validated = calls.map((call: unknown): ParsedCall => {
    if (
      !call ||
      typeof call !== "object" ||
      !("name" in call) ||
      !("arguments" in call)
    )
      throw new ProxyError("Malformed tool call", 502, "invalid_tool_call");
    const declared = tools.find((t) => t.function.name === call.name);
    if (
      !declared ||
      !call.arguments ||
      typeof call.arguments !== "object" ||
      Array.isArray(call.arguments)
    )
      throw new ProxyError(
        "Undeclared tool or non-object arguments",
        502,
        "invalid_tool_call",
      );
    const validator = createValidator().compile(
      declared.function.parameters ?? { type: "object" },
    );
    if (!validator(call.arguments))
      throw new ProxyError(
        `Invalid arguments for ${declared.function.name}`,
        502,
        "invalid_tool_call",
      );
    return {
      name: declared.function.name,
      arguments: call.arguments as Record<string, unknown>,
    };
  });
  return raw.tool_calls === undefined ? validated[0]! : validated;
}
export function toOpenAIToolCalls(
  parsed: ParsedCall | ParsedCall[],
  id = newId("call"),
): ToolCall[] {
  return (Array.isArray(parsed) ? parsed : [parsed]).map((call, index) => ({
    id: `${id}_${index}`,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }));
}
