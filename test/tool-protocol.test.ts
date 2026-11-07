import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const require = createRequire(import.meta.url);
const { parseToolCallFromText, toOpenAIToolCalls } = require(
  resolve("dist/helpers/toolPrompt.js"),
);
const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
];
const call = {
  tool_calls: [
    { name: "read_file", arguments: { path: "/workspace/plan.json" } },
  ],
};
describe("external agent tool transport", () => {
  for (const language of ["json", "JSON", ""]) {
    it(`accepts a whole ${language || "unlabelled"} fenced tool envelope`, () => {
      const parsed = parseToolCallFromText(
        `\n\`\`\`${language}\n${JSON.stringify(call)}\n\`\`\`\n`,
        tools,
      );
      expect(parsed).toEqual(call.tool_calls);
      expect(toOpenAIToolCalls(parsed)[0].function).toEqual({
        name: "read_file",
        arguments: '{"path":"/workspace/plan.json"}',
      });
    });
  }
  it("accepts Windows newlines around the complete JSON envelope", () =>
    expect(
      parseToolCallFromText(
        "```json\r\n" + JSON.stringify(call) + "\r\n```",
        tools,
      ),
    ).toEqual(call.tool_calls));
  for (const output of [
    "Example:\n```json\n" + JSON.stringify(call) + "\n```",
    "```json\n" + JSON.stringify(call) + "\n```\nThis is just an example.",
    "```json\n" +
      JSON.stringify(call) +
      "\n```\n```json\n" +
      JSON.stringify(call) +
      "\n```",
    "```javascript\n" + JSON.stringify(call) + "\n```",
  ])
    it("does not execute an embedded, repeated or differently labelled example", () =>
      expect(parseToolCallFromText(output, tools)).toBeNull());
  it("still validates declared tool names and argument schemas inside fences", () => {
    for (const args of [
      { name: "invented", arguments: {} },
      { name: "read_file", arguments: { path: 12 } },
      {
        name: "read_file",
        arguments: { path: "/workspace/plan.json", extra: true },
      },
    ]) {
      expect(() =>
        parseToolCallFromText(
          "```json\n" + JSON.stringify({ tool_calls: [args] }) + "\n```",
          tools,
        ),
      ).toThrow();
    }
  });
  it("fails closed on a malformed complete tool envelope", () =>
    expect(() =>
      parseToolCallFromText('```json\n{"tool_calls":[\n```', tools),
    ).toThrow());
});
it("keeps an explicit no-tools decision while continuing completed external results", () => {
  const { buildPromptWithTools } = require(
    resolve("dist/helpers/toolPrompt.js"),
  );
  const prompt = buildPromptWithTools(
    [
      {
        role: "user",
        content: "Read the plan, then answer using its contents.",
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "previous-call",
            type: "function",
            function: {
              name: "read_file",
              arguments: '{"path":"/workspace/plan.json"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "previous-call",
        content: "UNIQUE_COMPLETED_RESULT",
      },
    ],
    tools,
    undefined,
    "none",
  );
  expect(prompt).toContain('Tool choice: "none"');
  expect(prompt).toContain("UNIQUE_COMPLETED_RESULT");
  expect(prompt).toContain("previous-call");
  expect(prompt).not.toContain("Available tools:");
});
