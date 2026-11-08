import { z } from "zod";

export const protocolSchema = z.enum(["messages", "responses", "generate", "openrouter"]);
export type Protocol = z.infer<typeof protocolSchema>;
// OpenRouter ids carry a vendor prefix and a variant suffix, such as vendor/name:free.
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const count = z.number().int().nonnegative().safe();
export const usageSchema = z.object({
  input: count, cachedInput: count, cacheWrite: count, output: count,
}).strict().refine((value) => value.cachedInput + value.cacheWrite <= value.input);
export type Usage = z.infer<typeof usageSchema>;
export const ratesSchema = z.object({
  input: z.number().finite().nonnegative(),
  output: z.number().finite().nonnegative(),
  cachedInput: z.number().finite().nonnegative().optional(),
  cacheWrite: z.number().finite().nonnegative().optional(),
}).strict();
export type Rates = z.infer<typeof ratesSchema>;
export interface VisionRequest {
  system: string;
  task: string;
  images: { mediaType: "image/jpeg" | "image/png"; data: string }[];
}
export interface VisionResponse { model: string; raw: string; usage: Usage | null }

export function estimateCost(usage: Usage | null, rates?: Rates): number | null {
  if (!usage || !rates || (usage.cachedInput > 0 && rates.cachedInput === undefined) ||
      (usage.cacheWrite > 0 && rates.cacheWrite === undefined)) return null;
  return ((usage.input - usage.cachedInput - usage.cacheWrite) * rates.input +
    usage.cachedInput * (rates.cachedInput ?? 0) + usage.cacheWrite * (rates.cacheWrite ?? 0) +
    usage.output * rates.output) / 1_000_000;
}

function tokenUsage(protocol: Protocol, raw: unknown): Usage | null {
  try {
    let value: Usage;
    if (protocol === "messages") {
      const usage = z.object({
        input_tokens: count, output_tokens: count,
        cache_read_input_tokens: count.nullish(), cache_creation_input_tokens: count.nullish(),
      }).parse(raw);
      const cachedInput = usage.cache_read_input_tokens ?? 0;
      const cacheWrite = usage.cache_creation_input_tokens ?? 0;
      value = { input: usage.input_tokens + cachedInput + cacheWrite, cachedInput, cacheWrite, output: usage.output_tokens };
    } else if (protocol === "responses") {
      const usage = z.object({
        input_tokens: count, output_tokens: count,
        input_tokens_details: z.object({ cached_tokens: count }).nullish(),
      }).parse(raw);
      value = { input: usage.input_tokens, cachedInput: usage.input_tokens_details?.cached_tokens ?? 0, cacheWrite: 0, output: usage.output_tokens };
    } else if (protocol === "openrouter") {
      const usage = z.object({
        prompt_tokens: count, completion_tokens: count,
        prompt_tokens_details: z.object({ cached_tokens: count.nullish() }).nullish(),
      }).parse(raw);
      value = { input: usage.prompt_tokens, cachedInput: usage.prompt_tokens_details?.cached_tokens ?? 0, cacheWrite: 0, output: usage.completion_tokens };
    } else {
      const usage = z.object({
        promptTokenCount: count, candidatesTokenCount: count, thoughtsTokenCount: count.optional(),
        cachedContentTokenCount: count.optional(), totalTokenCount: count,
      }).parse(raw);
      const output = usage.candidatesTokenCount + (usage.thoughtsTokenCount ?? 0);
      if (usage.promptTokenCount + output !== usage.totalTokenCount) return null;
      value = { input: usage.promptTokenCount, cachedInput: usage.cachedContentTokenCount ?? 0, cacheWrite: 0, output };
    }
    return usageSchema.parse(value);
  } catch { return null; }
}

const modelName = z.string().trim().min(1);
function completion(protocol: Protocol, raw: unknown): VisionResponse {
  let model: string;
  let text: string;
  let usage: unknown;
  if (protocol === "messages") {
    const reply = z.object({
      model: modelName, stop_reason: z.literal("end_turn"), usage: z.unknown(),
      content: z.array(z.object({ type: z.enum(["text", "thinking", "redacted_thinking"]), text: z.string().optional() })),
    }).parse(raw);
    model = reply.model;
    text = reply.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
    usage = reply.usage;
  } else if (protocol === "responses") {
    const reply = z.object({
      model: modelName, status: z.literal("completed"), usage: z.unknown(),
      output: z.array(z.object({
        type: z.enum(["message", "reasoning"]),
        content: z.array(z.object({ type: z.literal("output_text"), text: z.string() })).optional(),
      })),
    }).parse(raw);
    model = reply.model;
    text = reply.output.filter((part) => part.type === "message").flatMap((part) => part.content ?? []).map((part) => part.text).join("");
    usage = reply.usage;
  } else if (protocol === "openrouter") {
    const reply = z.object({
      model: modelName, usage: z.unknown(),
      choices: z.array(z.object({
        finish_reason: z.literal("stop"),
        message: z.object({ content: z.string().nullable(), tool_calls: z.array(z.unknown()).max(0).nullish() }),
      })).length(1),
    }).parse(raw);
    model = reply.model;
    text = reply.choices[0].message.content ?? "";
    usage = reply.usage;
  } else {
    const reply = z.object({
      modelVersion: modelName, usageMetadata: z.unknown(),
      promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
      candidates: z.array(z.object({
        finishReason: z.literal("STOP"),
        content: z.object({ parts: z.array(z.object({ text: z.string(), thought: z.boolean().optional() })) }),
      })).length(1),
    }).parse(raw);
    if (reply.promptFeedback?.blockReason) throw new Error("review was blocked");
    model = reply.modelVersion;
    text = reply.candidates[0].content.parts.filter((part) => !part.thought).map((part) => part.text).join("");
    usage = reply.usageMetadata;
  }
  if (!text.trim()) throw new Error("empty review");
  return { model, raw: text, usage: tokenUsage(protocol, usage) };
}

export async function reviewImages(
  protocol: Protocol, model: string, key: string, request: VisionRequest, send: typeof fetch = fetch,
): Promise<VisionResponse> {
  protocolSchema.parse(protocol);
  if (!key.trim() || !MODEL_ID.test(model)) throw new Error("missing key or invalid model");
  let url: string;
  let body: unknown;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (protocol === "messages") {
    url = "https://api.anthropic.com/v1/messages";
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    body = {
      model, max_tokens: 16000, system: request.system,
      messages: [{ role: "user", content: [
        { type: "text", text: request.task },
        ...request.images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } })),
      ] }],
    };
  } else if (protocol === "responses") {
    url = "https://api.openai.com/v1/responses";
    headers.authorization = `Bearer ${key}`;
    body = {
      model, instructions: request.system, max_output_tokens: 16000, store: false,
      text: { format: { type: "json_object" } },
      input: [{ role: "user", content: [
        { type: "input_text", text: request.task },
        ...request.images.map((image) => ({ type: "input_image", detail: "high", image_url: `data:${image.mediaType};base64,${image.data}` })),
      ] }],
    };
  } else if (protocol === "openrouter") {
    url = "https://openrouter.ai/api/v1/chat/completions";
    headers.authorization = `Bearer ${key}`;
    headers["x-title"] = "Break or Fake";
    body = {
      model, max_tokens: 16000, stream: false, response_format: { type: "json_object" },
      ...(model.endsWith(":free") ? {
        provider: { require_parameters: true, max_price: { prompt: 0, completion: 0, request: 0, image: 0 } },
      } : {}),
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: [
          { type: "text", text: request.task },
          ...request.images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } })),
        ] },
      ],
    };
  } else {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    headers["x-goog-api-key"] = key;
    body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: "user", parts: [
        { text: request.task },
        ...request.images.map((image) => ({ inlineData: { mimeType: image.mediaType, data: image.data } })),
      ] }],
      generationConfig: { maxOutputTokens: 16000, responseMimeType: "application/json" },
    };
  }
  let response: Response;
  try {
    response = await send(url, {
      method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(90_000),
    });
  } catch { throw new Error("review request failed"); }
  if (!response.ok) throw new Error(`review request returned HTTP ${response.status}`);
  try { return completion(protocol, await response.json()); }
  catch { throw new Error("review response was incomplete or invalid"); }
}
