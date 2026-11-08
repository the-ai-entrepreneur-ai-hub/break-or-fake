import { z } from "zod";
import { MODEL_ID, reviewImages, type VisionRequest } from "./vision.js";

// A free variant has an id ending in ":free". Those are the ids OpenRouter's free request caps apply to.
export const FREE_SUFFIX = ":free";
export const USAGE_DAYS = 7;
export const PICKS = 3;
export const MAX_PROBES = 6;

const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  context_length: z.number().nullish(),
  expiration_date: z.string().nullish(),
  architecture: z.object({
    input_modalities: z.array(z.string()).default([]),
    output_modalities: z.array(z.string()).default([]),
  }).partial().default({}),
  pricing: z.record(z.unknown()).default({}),
  supported_parameters: z.array(z.string()).nullish(),
}).passthrough();
export const modelListSchema = z.object({ data: z.array(modelSchema) });
export type OpenRouterModel = z.infer<typeof modelSchema>;

export interface Candidate { id: string; name: string; contextLength: number | null; expires: string | null }
export interface Excluded { id: string; reason: string }
const zeroPrice = (value: unknown) =>
  (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) && Number(value) === 0;

// The reviewer sends three frames plus the listing photo and must get JSON back, so a candidate needs
// image input, text-only output and JSON mode.
export function freeVisionCandidates(models: OpenRouterModel[]): { candidates: Candidate[]; excluded: Excluded[] } {
  const candidates: Candidate[] = [];
  const excluded: Excluded[] = [];
  for (const model of models) {
    if (!model.id.endsWith(FREE_SUFFIX)) continue;
    const input = model.architecture.input_modalities ?? [];
    const output = model.architecture.output_modalities ?? [];
    const params = model.supported_parameters ?? [];
    const reason = !zeroPrice(model.pricing.prompt) || !zeroPrice(model.pricing.completion) ||
      !Object.values(model.pricing).every(zeroPrice) ? "pricing is not explicitly zero"
      : !input.includes("image") ? "no image input"
      : !output.length ? "no text output"
      : output.some((value) => value !== "text") ? `output is ${output.join("+")}, not text only`
      : !params.includes("response_format") ? "no JSON mode"
      : !MODEL_ID.test(model.id) ? "id has characters the reviewer refuses"
      : null;
    if (reason) excluded.push({ id: model.id, reason });
    else candidates.push({ id: model.id, name: model.name ?? model.id, contextLength: model.context_length ?? null, expires: model.expiration_date ?? null });
  }
  return { candidates, excluded };
}

export interface DailyUsage { date: string; promptTokens: number; completionTokens: number; requests: number }

const count = z.number().int().nonnegative().safe();
const dailyRecord = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}(?: 00:00:00|T00:00:00(?:\.000)?Z)?$/),
  model_permaslug: z.string(), variant: z.literal("free"),
  total_prompt_tokens: count, total_completion_tokens: count, count,
});
function calendarDate(date: string): boolean {
  const time = Date.parse(`${date}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === date;
}

// shortcut: public pages expose free-variant daily rows absent from the top-50 dataset;
// if their shape changes, report unknown rather than substituting paid or aggregate traffic.
export function freeVariantUsage(pageHtml: string, id: string): DailyUsage[] {
  const base = id.replace(/:free$/, "");
  const text = pageHtml.replaceAll('\\"', '"');
  const byDate = new Map<string, DailyUsage>();
  // One pass over the flat {...} records keeps this linear on any input; the usage records have no nested objects.
  for (const [record] of text.matchAll(/\{[^{}]*\}/g)) {
    if (!/"variant"\s*:\s*"free"/.test(record)) continue;
    let parsed: z.infer<typeof dailyRecord>;
    try { parsed = dailyRecord.parse(JSON.parse(record)); } catch { continue; }
    const permaslug = parsed.model_permaslug;
    // The page can carry rows for related models; keep only this model and its dated versions, such as base-20260402.
    if (!permaslug.startsWith(base) || !/^(-\d{8})?$/.test(permaslug.slice(base.length))) continue;
    const date = parsed.date.slice(0, 10);
    if (!calendarDate(date)) continue;
    const row = { date, promptTokens: parsed.total_prompt_tokens, completionTokens: parsed.total_completion_tokens, requests: parsed.count };
    const existing = byDate.get(date);
    // The same day can appear in more than one chart on the page; keep the fullest copy.
    if (!existing || row.requests > existing.requests) byDate.set(date, row);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

export interface Ranked extends Candidate { tokens: number | null; requests: number | null; days: number }

// Today's bucket is incomplete; gaps must not be filled by older days or silently treated as zero.
export function rankByUsage(candidates: Candidate[], usage: Map<string, DailyUsage[]>, days = USAGE_DAYS, now = new Date()): Ranked[] {
  const end = now.toISOString().slice(0, 10);
  const since = new Date(Date.parse(`${end}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
  const ranked = candidates.map((candidate): Ranked => {
    const byDate = new Map<string, DailyUsage>();
    for (const row of usage.get(candidate.id) ?? []) {
      if (!calendarDate(row.date) || row.date < since || row.date >= end ||
          ![row.promptTokens, row.completionTokens, row.requests].every((value) => Number.isSafeInteger(value) && value >= 0)) continue;
      if (!byDate.has(row.date) || row.requests > byDate.get(row.date)!.requests) byDate.set(row.date, row);
    }
    const window = [...byDate.values()];
    const tokens = window.reduce((sum, row) => sum + row.promptTokens + row.completionTokens, 0);
    const requests = window.reduce((sum, row) => sum + row.requests, 0);
    const complete = window.length === days && Number.isSafeInteger(tokens) && Number.isSafeInteger(requests);
    return {
      ...candidate, days: window.length,
      tokens: complete ? tokens : null, requests: complete ? requests : null,
    };
  });
  // Unknown usage sorts last, then by id so the order is stable between runs.
  return ranked.sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1) || a.id.localeCompare(b.id));
}

// Synthetic solid-color images test transport capability, not damage accuracy or physical liveness.
const probeRequest: VisionRequest = {
  system: 'Identify the dominant color in each image in order. Return only JSON: {"colors":["red|green|blue|other","red|green|blue|other"]}. No extra keys.',
  task: "Read both images and return their colors in the same order.",
  images: [
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAlklEQVRoge2SwQkAMBCD3H9pO0QfchBwACNBOA25gRtAXtFdiLuQG7gB5BXdhbgLuYEbQF7RXYi7kBu4AeQV3YW4C7mBG0Be0V2Iu5AbuAHkFd2FuAu5gRtAXtFdiLuQG7gB5BXdhbgLuYEbQF7RXYi7kBu4AeQV3YW4C7mBG0Be0V2Iu5AbuAHkFd2FuAu5gRtAXvGHB6nc8OJ57m0sAAAAAElFTkSuQmCC",
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAlklEQVRoge2SwQkAMBCD3H9pu0M/chBwACMBPA65gRtAXtFdiLuQG7gB5BXdhbgLuYEbQF7RXYi7kBu4AeQV3YW4C7mBG0Be0V2Iu5AbuAHkFd2FuAu5gRtAXtFdiLuQG7gB5BXdhbgLuYEbQF7RXYi7kBu4AeQV3YW4C7mBG0Be0V2Iu5AbuAHkFd2FuAu5gRtAXvGfB8f88OLUsm3FAAAAAElFTkSuQmCC",
  ].map((data) => ({ mediaType: "image/png", data })),
};
const probeAnswer = z.object({ colors: z.tuple([z.literal("red"), z.literal("blue")]) }).strict();
export interface ModelProbe { model: string; ok: boolean; returnedModel?: string; error?: string }

export async function selectFreeModels(ranked: Ranked[], key: string, review: typeof reviewImages = reviewImages) {
  const picks: Ranked[] = [];
  const probes: ModelProbe[] = [];
  const identities = new Set<string>();
  if (!key.trim()) return { picks, probes };
  for (const candidate of ranked) {
    if (picks.length === PICKS || probes.length === MAX_PROBES) break;
    if (!candidate.id.endsWith(FREE_SUFFIX) || !MODEL_ID.test(candidate.id) ||
        candidate.tokens === null || candidate.days !== USAGE_DAYS) continue;
    try {
      const reply = await review("openrouter", candidate.id, key, probeRequest);
      probeAnswer.parse(JSON.parse(reply.raw));
      if (!MODEL_ID.test(reply.model)) throw new Error("invalid model identity");
      const identity = reply.model.split(":")[0].toLowerCase();
      if (identities.has(identity)) {
        probes.push({ model: candidate.id, ok: false, error: "returned model duplicates a selected reviewer" });
        continue;
      }
      identities.add(identity);
      picks.push(candidate);
      probes.push({ model: candidate.id, ok: true, returnedModel: reply.model });
    } catch (error) {
      probes.push({ model: candidate.id, ok: false, error: error instanceof Error &&
        /^review request returned HTTP \d{3}$/.test(error.message) ? error.message : "vision/JSON probe failed" });
    }
  }
  return { picks, probes };
}

// OPENROUTER_MODELS is a comma-separated list of ids, in the order the reviewer runs them.
export function modelsFromEnv(value: string | undefined): string[] {
  const models = (value ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (!models.length) throw new Error("OPENROUTER_MODELS is not set");
  if (new Set(models).size !== models.length) throw new Error("OPENROUTER_MODELS repeats a model");
  for (const model of models) if (!MODEL_ID.test(model)) throw new Error("OPENROUTER_MODELS has an invalid model id");
  return models;
}
