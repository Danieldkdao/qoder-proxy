import { randomUUID } from "node:crypto";
import { ProxyError } from "../errors";
import type { Message, ToolCall } from "../types";
export const newId = (prefix: string): string =>
  `${prefix}-${randomUUID().replaceAll("-", "")}`;
function textContent(content: unknown): string | null {
  if (content === null) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part: unknown) => {
        if (
          !part ||
          typeof part !== "object" ||
          !("type" in part) ||
          part.type !== "text" ||
          !("text" in part) ||
          typeof part.text !== "string"
        )
          throw new ProxyError(
            "Unsupported content: images and non-text parts are not supported",
            400,
            "unsupported_content",
          );
        return part.text;
      })
      .join("\n");
  throw new ProxyError("Message content must be text, text parts, or null");
}
export function validateMessages(input: unknown): Message[] {
  if (!Array.isArray(input) || input.length === 0)
    throw new ProxyError("messages must be a non-empty array");
  const calls = new Map<string, boolean>();
  return input.map((raw: unknown) => {
    if (
      !raw ||
      typeof raw !== "object" ||
      !("role" in raw) ||
      typeof raw.role !== "string" ||
      !["system", "developer", "user", "assistant", "tool"].includes(raw.role)
    )
      throw new ProxyError("Invalid message role");
    const msg = raw as Message;
    const content = textContent(
      msg.content ??
        (msg.role === "assistant" && msg.tool_calls ? null : undefined),
    );
    if (
      content === null &&
      !(msg.role === "assistant" && msg.tool_calls?.length)
    )
      throw new ProxyError(
        "Null content is only supported for assistant tool calls",
      );
    if (msg.tool_calls !== undefined) {
      if (
        msg.role !== "assistant" ||
        !Array.isArray(msg.tool_calls) ||
        msg.tool_calls.length === 0
      )
        throw new ProxyError("Invalid assistant tool_calls");
      for (const tc of msg.tool_calls) {
        if (
          !tc ||
          typeof tc.id !== "string" ||
          !tc.id ||
          calls.has(tc.id) ||
          tc.type !== "function" ||
          !tc.function ||
          typeof tc.function.name !== "string" ||
          typeof tc.function.arguments !== "string"
        )
          throw new ProxyError("Invalid or duplicate tool call");
        try {
          JSON.parse(tc.function.arguments);
        } catch {
          throw new ProxyError(
            "Tool call arguments must be valid JSON strings",
          );
        }
        calls.set(tc.id, false);
      }
    }
    if (msg.role === "tool") {
      if (
        !msg.tool_call_id ||
        !calls.has(msg.tool_call_id) ||
        calls.get(msg.tool_call_id)
      )
        throw new ProxyError(
          "Tool result must match a preceding unresolved tool call",
        );
      calls.set(msg.tool_call_id, true);
    }
    return {
      role: msg.role,
      content,
      ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
      ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}),
      ...(msg.name ? { name: msg.name } : {}),
    };
  });
}
export function messagesToPrompt(messages: unknown): string {
  return (
    "Conversation (JSON; roles, tool calls and results are authoritative):\n" +
    JSON.stringify(validateMessages(messages))
  );
}
export function extractTextContent(
  message: { content?: unknown } | undefined,
): string {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .map((p: unknown) =>
      p &&
      typeof p === "object" &&
      "type" in p &&
      p.type === "text" &&
      "text" in p &&
      typeof p.text === "string"
        ? p.text
        : "",
    )
    .join("");
}
export function extractToolCalls(content: unknown): ToolCall[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((p) => p?.type === "function" && p.id && p.name && p.input)
    .map((p) => ({
      id: String(p.id),
      type: "function" as const,
      function: {
        name: String(p.name),
        arguments:
          typeof p.input === "string" ? p.input : JSON.stringify(p.input),
      },
    }));
}
export function normalizeFinishReason(reason: unknown): string {
  if (reason === "max_tokens" || reason === "length") return "length";
  if (reason === "tool_use" || reason === "tool_calls") return "tool_calls";
  if (reason === "content_filter" || reason === "refusal")
    return "content_filter";
  return "stop";
}
export function buildStreamChunk(content: string, model: string, id: string) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
}
export function buildDoneChunk(model: string, id: string, reason = "stop") {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
  };
}
export function buildFullChatResponse(
  text: string | null,
  model: string,
  reason: string,
  id: string,
  calls?: ToolCall[],
) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          ...(calls?.length ? { tool_calls: calls } : {}),
        },
        finish_reason: reason,
      },
    ],
  };
}
