import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateCost, reviewImages, type Protocol } from "../lib/vision.js";

const request = { system: "test", task: "test", images: Array.from({ length: 4 }, () => ({ mediaType: "image/png" as const, data: "b3JpZ2luYWw=" })) };
const replies = {
  messages: { model: "test-model-v1", stop_reason: "end_turn", content: [{ type: "text", text: '{"ok":true}' }],
    usage: { input_tokens: 80, cache_read_input_tokens: 20, cache_creation_input_tokens: 0, output_tokens: 50 } },
  responses: { model: "test-model-v1", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: '{"ok":true}' }] }],
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 50 } },
  generate: { modelVersion: "test-model-v1", candidates: [{ finishReason: "STOP", content: { parts: [{ text: "private", thought: true }, { text: '{"ok":true}' }] } }],
    usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 20, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 150 } },
  openrouter: { model: "test-model-v1", provider: "test-provider", choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"ok":true}', tool_calls: [] } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 20 } } },
};
const fetchReply = (body: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(body), { status });

test("free variants require supported parameters and zero token, request and image prices", async () => {
  for (const model of ["vendor/name:free", "vendor/name"]) {
    let body: Record<string, unknown> = {};
    await reviewImages("openrouter", model, "test-only", request, async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return fetchReply(replies.openrouter)("", {});
    });
    assert.equal(body.model, model);
    assert.equal(body.models, undefined);
    assert.deepEqual(body.provider, model.endsWith(":free") ? {
      require_parameters: true, max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
    } : undefined);
  }
});

test("each direct protocol sends original images and no tools, and normalizes usage", async () => {
  for (const protocol of ["messages", "responses", "generate", "openrouter"] as const) {
    let sent: { url: string; options: RequestInit } | undefined;
    const result = await reviewImages(protocol, "test-model", "test-only", request, async (url, options) => {
      sent = { url: String(url), options: options! };
      return fetchReply(replies[protocol])("", {});
    });
    assert.equal(result.model, "test-model-v1");
    assert.equal(result.raw, '{"ok":true}');
    assert.deepEqual(result.usage, { input: 100, cachedInput: 20, cacheWrite: 0, output: 50 });
    assert.ok(sent);
    assert.ok(sent.url.startsWith("https://"));
    assert.ok(!sent.url.includes("test-only"));
    assert.equal(sent.options.redirect, "error");
    assert.ok(sent.options.signal);
    const body = JSON.parse(sent.options.body as string);
    assert.equal(body.tools, undefined);
    assert.equal(body.fallbacks, undefined);
    assert.equal((sent.options.body as string).match(/b3JpZ2luYWw=/g)?.length, 4);
    if (protocol === "responses") {
      assert.equal(body.store, false);
      assert.equal(body.text.format.type, "json_object");
    }
    if (protocol === "generate") {
      assert.equal(body.generationConfig.responseMimeType, "application/json");
      assert.equal(new Headers(sent.options.headers).get("x-goog-api-key"), "test-only");
    }
    if (protocol === "openrouter") {
      assert.equal(sent.url, "https://openrouter.ai/api/v1/chat/completions");
      assert.equal(new Headers(sent.options.headers).get("authorization"), "Bearer test-only");
      assert.equal(body.response_format.type, "json_object");
      assert.equal(body.stream, false);
      assert.equal(body.messages[0].role, "system");
      assert.equal(body.messages[1].content.filter((part: { type: string }) => part.type === "image_url").length, 4);
    }
  }
  const prefixed = await reviewImages("openrouter", "vendor/name:free", "test-only", request, fetchReply(replies.openrouter));
  assert.equal(prefixed.model, "test-model-v1");
  await assert.rejects(reviewImages("openrouter", "bad id", "test-only", request, fetchReply(replies.openrouter)), /invalid model/);
});

test("refusals, truncated answers, tool calls and empty completions fail closed", async () => {
  const invalid: [Protocol, unknown][] = [
    ["messages", { ...replies.messages, stop_reason: "max_tokens" }],
    ["messages", { ...replies.messages, content: [{ type: "tool_use", name: "refund" }] }],
    ["messages", { ...replies.messages, content: [] }],
    ["responses", { ...replies.responses, status: "incomplete" }],
    ["responses", { ...replies.responses, output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }],
    ["responses", { ...replies.responses, output: [{ type: "function_call", name: "refund" }] }],
    ["generate", { ...replies.generate, promptFeedback: { blockReason: "SAFETY" } }],
    ["generate", { ...replies.generate, candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{}" }] } }] }],
    ["generate", { ...replies.generate, candidates: [{ finishReason: "STOP", content: { parts: [{ functionCall: { name: "refund" } }] } }] }],
    ["openrouter", { ...replies.openrouter, choices: [{ finish_reason: "length", message: { content: "{" } }] }],
    ["openrouter", { ...replies.openrouter, choices: [{ finish_reason: "stop", message: { content: null, tool_calls: [{ function: { name: "refund" } }] } }] }],
    ["openrouter", { ...replies.openrouter, choices: [{ finish_reason: "stop", message: { content: "" } }] }],
    ["openrouter", { ...replies.openrouter, choices: [] }],
    ["openrouter", { error: { message: "rate limited", code: 429 } }],
  ];
  for (const [protocol, body] of invalid) {
    await assert.rejects(reviewImages(protocol, "test-model", "test-only", request, fetchReply(body)));
  }
});

test("HTTP and transport failures never echo provider bodies or credentials", async () => {
  await assert.rejects(reviewImages("responses", "test-model", "test-only", request, fetchReply({ error: "private-provider-body" }, 401)), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /401/);
    assert.doesNotMatch(error.message, /test-only|private-provider-body/);
    return true;
  });
  await assert.rejects(reviewImages("generate", "test-model", "test-only", request, async () => { throw new Error("test-only"); }), /request failed/);
});

test("missing or inconsistent usage stays unknown and pricing includes cache and reasoning", async () => {
  const missing = await reviewImages("responses", "test-model", "test-only", request, fetchReply({ ...replies.responses, usage: undefined }));
  assert.equal(missing.usage, null);
  const bad = await reviewImages("responses", "test-model", "test-only", request, fetchReply({
    ...replies.responses, usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 20 }, output_tokens: 5 },
  }));
  assert.equal(bad.usage, null);
  const usage = { input: 100, cachedInput: 20, cacheWrite: 0, output: 50 };
  assert.equal(estimateCost(usage), null);
  assert.equal(estimateCost(null, { input: 2, cachedInput: 1, output: 10 }), null);
  assert.equal(estimateCost(usage, { input: 2, cachedInput: 1, output: 10 }), 0.00068);
  assert.equal(estimateCost(usage, { input: 2, output: 10 }), null);
  assert.equal(estimateCost({ ...usage, cacheWrite: 5 }, { input: 2, cachedInput: 1, output: 10 }), null);
});
