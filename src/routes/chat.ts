import type { Request, Response } from "express";
import { Router } from "express";
import { once } from "node:events";
import { ProxyError, errorBody } from "../errors";
import {
  buildDoneChunk,
  buildFullChatResponse,
  buildStreamChunk,
  getModelMapping,
  messagesToPrompt,
  newId,
  validateMessages,
} from "../helpers/format";
import {
  buildPromptWithTools,
  parseToolCallFromText,
  toOpenAIToolCalls,
  validateChoice,
  validateTools,
} from "../helpers/toolPrompt";
import { runQoder } from "../helpers/spawn";
const accepted = new Set([
  "messages",
  "model",
  "stream",
  "tools",
  "tool_choice",
  "max_tokens",
  "max_completion_tokens",
  "stream_options",
  "parallel_tool_calls",
]);
export async function handleChat(
  req: Request,
  res: Response,
  legacy = false,
): Promise<void> {
  const controller = new AbortController();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cancel = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.once("aborted", cancel);
  res.once("close", cancel);
  const write = async (data: unknown) => {
    if (res.destroyed || controller.signal.aborted)
      throw new ProxyError("Request cancelled", 499, "cancelled");
    if (!res.write(`data: ${JSON.stringify(data)}\n\n`))
      await once(res, "drain", { signal: controller.signal });
  };
  try {
    const body: Record<string, unknown> = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ProxyError("Request body must be an object");
    if (legacy) {
      if (typeof body.prompt !== "string" || !body.prompt)
        throw new ProxyError("prompt must be a non-empty string");
      body.messages = [{ role: "user", content: body.prompt }];
      delete body.prompt;
    }
    for (const key of Object.keys(body))
      if (!accepted.has(key))
        throw new ProxyError(
          `Unsupported request option: ${key}`,
          400,
          "unsupported_parameter",
        );
    if (body.stream !== undefined && typeof body.stream !== "boolean")
      throw new ProxyError("stream must be a boolean");
    if (
      body.parallel_tool_calls !== undefined &&
      typeof body.parallel_tool_calls !== "boolean"
    )
      throw new ProxyError("parallel_tool_calls must be boolean");
    if (
      body.stream_options !== undefined &&
      (!body.stream_options ||
        typeof body.stream_options !== "object" ||
        Object.keys(body.stream_options).some((k) => k !== "include_usage"))
    )
      throw new ProxyError("Unsupported stream_options");
    if (
      body.max_tokens !== undefined &&
      body.max_completion_tokens !== undefined
    )
      throw new ProxyError("Specify only one output token limit");
    const limit = body.max_tokens ?? body.max_completion_tokens;
    // The CLI exposes two coarse output budgets. Refuse unsupported precision.
    if (limit !== undefined && limit !== 16000 && limit !== 32000)
      throw new ProxyError(
        "Only max_tokens 16000 or 32000 is supported by the CLI",
        400,
        "unsupported_parameter",
      );
    const messages = validateMessages(body.messages),
      tools = validateTools(body.tools),
      choice = validateChoice(body.tool_choice, tools);
    const model = getModelMapping(body.model),
      id = newId(legacy ? "cmpl" : "chatcmpl");
    const enabled = tools.length > 0 && choice !== "none";
    const prompt = enabled
      ? buildPromptWithTools(messages, tools, messagesToPrompt, choice)
      : messagesToPrompt(messages);
    const streaming = body.stream === true;
    if (streaming) {
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      if (!legacy)
        await write({
          ...buildStreamChunk("", model, id),
          choices: [
            { index: 0, delta: { role: "assistant" }, finish_reason: null },
          ],
        });
      heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write(": keepalive\n\n");
      }, 10000);
      heartbeat.unref();
    }
    const legacyChunk = (text: string, reason: string | null) => ({
      id,
      object: "text_completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, text, logprobs: null, finish_reason: reason }],
    });
    const result = await runQoder(
      prompt,
      model,
      controller.signal,
      streaming && !enabled
        ? async (text) => {
            await write(
              legacy
                ? legacyChunk(text, null)
                : buildStreamChunk(text, model, id),
            );
          }
        : undefined,
      limit === 32000 ? "32k" : limit === 16000 ? "16k" : undefined,
    );
    const parsed = enabled ? parseToolCallFromText(result.text, tools) : null;
    const calls = parsed ? toOpenAIToolCalls(parsed) : undefined;
    if (body.parallel_tool_calls === false && calls && calls.length > 1)
      throw new ProxyError(
        "Model returned parallel calls when disabled",
        502,
        "invalid_tool_call",
      );
    if ((choice === "required" || typeof choice === "object") && !calls)
      throw new ProxyError(
        "Model failed required tool selection",
        502,
        "invalid_tool_call",
      );
    if (
      typeof choice === "object" &&
      calls?.some((c) => c.function.name !== choice.function.name)
    )
      throw new ProxyError(
        "Model selected a different tool",
        502,
        "invalid_tool_call",
      );
    const reason = calls?.length ? "tool_calls" : result.finishReason;
    if (streaming) {
      if (calls)
        await write({
          ...buildStreamChunk("", model, id),
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: calls.map((call, index) => ({ ...call, index })),
              },
              finish_reason: null,
            },
          ],
        });
      else if (enabled) await write(buildStreamChunk(result.text, model, id));
      await write(
        legacy ? legacyChunk("", reason) : buildDoneChunk(model, id, reason),
      );
      res.end("data: [DONE]\n\n");
    } else if (legacy)
      res.json({
        id,
        object: "text_completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            text: result.text,
            logprobs: null,
            finish_reason: reason,
          },
        ],
      });
    else
      res.json(
        buildFullChatResponse(
          calls ? null : result.text,
          model,
          reason,
          id,
          calls,
        ),
      );
  } catch (error) {
    res.locals.errorCode =
      error instanceof ProxyError ? error.code : "server_error";
    if (!res.destroyed && !res.writableEnded) {
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify(errorBody(error))}\n\n`);
        res.end("data: [DONE]\n\n");
      } else
        res
          .status(error instanceof ProxyError ? error.status : 500)
          .json(errorBody(error));
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    req.removeListener("aborted", cancel);
    res.removeListener("close", cancel);
  }
}
export const chatRouter = Router();
chatRouter.post("/", (req, res) => {
  void handleChat(req, res);
});
