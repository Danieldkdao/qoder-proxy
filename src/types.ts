export type Role = "system" | "developer" | "user" | "assistant" | "tool";
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface Message {
  role: Role;
  content: string | null | Array<{ type: string; text?: string }>;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}
export interface Tool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}
export interface ParsedCall {
  name: string;
  arguments: Record<string, unknown>;
}
export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };
export interface QoderResult {
  toolCalls?: ParsedCall[];
  text: string;
  finishReason: string;
}
