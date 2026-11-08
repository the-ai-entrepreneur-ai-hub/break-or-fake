import assert from "node:assert/strict";
import { test } from "node:test";
import type { BetaMessage, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages";
import { z } from "zod";
import { MAX_STEPS, runText, type CreateMessage } from "../lib/llm.js";

type Turn = { content: unknown[]; stop_reason: string; stop_details?: unknown };
const final = (text: string): Turn => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });
const toolCall = (name: string, input: unknown): Turn => ({ content: [{ type: "tool_use", id: "call-1", name, input }], stop_reason: "tool_use" });
function scripted(turns: Turn[], calls: MessageCreateParamsNonStreaming[] = []): CreateMessage {
  let index = 0;
  return async (request) => {
    calls.push(structuredClone(request));
    const turn = turns[index++];
    if (!turn) throw new Error("script exhausted");
    return { id: `message-${index}`, type: "message", role: "assistant", model: "scripted", stop_details: null, ...turn } as unknown as BetaMessage;
  };
}
const request = { system: "review", task: "review", tools: {} };

test("image blocks preserve original bytes and accompany the task", async () => {
  const calls: MessageCreateParamsNonStreaming[] = [];
  assert.equal(await runText({
    ...request, createMessage: scripted([final("done")], calls),
    images: [{ mediaType: "image/png", data: Buffer.from("original").toString("base64") }],
  }), "done");
  assert.deepEqual(calls[0]?.messages[0]?.content, [
    { type: "text", text: "review" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("original").toString("base64") } },
  ]);
});

test("money tools cannot enter model definitions even through a mistaken caller", async () => {
  let called = false;
  await assert.rejects(runText({
    ...request, tools: { refund: { parameters: z.object({}) } },
    createMessage: async () => { called = true; throw new Error("unreachable"); },
  }), /read-only/);
  assert.equal(called, false);
});

test("malformed arguments return a repair result and only valid calls execute", async () => {
  const calls: MessageCreateParamsNonStreaming[] = [];
  let executed = 0;
  const tools = { get_order: { parameters: z.object({ id: z.string() }), execute: async () => { executed++; return '{"id":"order"}'; } } };
  assert.equal(await runText({ ...request, tools, createMessage: scripted([toolCall("get_order", {}), toolCall("get_order", { id: "order" }), final("done")], calls) }), "done");
  assert.equal(executed, 1);
  assert.match(JSON.stringify(calls[1]?.messages.at(-1)), /Invalid arguments/);
  assert.deepEqual(calls[2]?.messages.slice(0, calls[1]?.messages.length), calls[1]?.messages);
  const results = calls[2]?.messages.at(-1)?.content as { content: string }[];
  assert.equal(results[0]?.content, '{"id":"order"}');
});

test("unknown tools return an error without executing anything", async () => {
  const calls: MessageCreateParamsNonStreaming[] = [];
  await runText({ ...request, createMessage: scripted([toolCall("refund", {}), final("held")], calls) });
  assert.match(JSON.stringify(calls[1]?.messages.at(-1)), /There is no tool named refund/);
});

test("empty answers, refusal and token exhaustion end the run", async () => {
  for (const [reply, message] of [
    [final(" "), /without a final answer/],
    [{ content: [], stop_reason: "refusal", stop_details: { category: "policy" } }, /refusal/],
    [{ content: [], stop_reason: "max_tokens" }, /max_tokens/],
  ] as const) await assert.rejects(runText({ ...request, createMessage: scripted([reply as Turn]) }), message);
});

test("last step runs no tools and execution errors propagate", async () => {
  let executed = 0;
  const tools = { get_order: { parameters: z.object({}), execute: async () => { executed++; return {}; } } };
  await assert.rejects(runText({ ...request, tools, createMessage: scripted(Array.from({ length: MAX_STEPS }, () => toolCall("get_order", {}))) }), /no final answer/);
  assert.equal(executed, MAX_STEPS - 1);
  await assert.rejects(runText({
    ...request, tools: { get_order: { parameters: z.object({}), execute: async () => { throw new Error("lookup failed"); } } },
    createMessage: scripted([toolCall("get_order", {})]),
  }), /lookup failed/);
});
