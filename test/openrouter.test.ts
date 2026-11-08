import assert from "node:assert/strict";
import { test } from "node:test";
import { freeVariantUsage, freeVisionCandidates, modelListSchema, modelsFromEnv, rankByUsage, type OpenRouterModel } from "../lib/openrouter.js";
import * as selector from "../lib/openrouter.js";

const model = (id: string, overrides: Partial<OpenRouterModel> = {}): OpenRouterModel => ({
  id, name: id, context_length: 262144,
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  pricing: { prompt: 0, completion: 0 }, supported_parameters: ["tools", "response_format"], ...overrides,
});

test("only free variants that take images, answer in text and support JSON mode are candidates", () => {
  const { candidates, excluded } = freeVisionCandidates([
    model("vendor/vision-a:free"),
    model("vendor/paid-vision", { pricing: { prompt: 0.000001, completion: 0.000002 } }),
    model("vendor/text-only:free", { architecture: { input_modalities: ["text"], output_modalities: ["text"] } }),
    model("vendor/music:free", { architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "audio"] } }),
    model("vendor/no-json:free", { supported_parameters: ["tools"] }),
    model("vendor/router", { pricing: { prompt: 0, completion: 0 } }),
  ]);
  assert.deepEqual(candidates.map((candidate) => candidate.id), ["vendor/vision-a:free"]);
  assert.deepEqual(excluded, [
    { id: "vendor/text-only:free", reason: "no image input" },
    { id: "vendor/music:free", reason: "output is text+audio, not text only" },
    { id: "vendor/no-json:free", reason: "no JSON mode" },
  ]);
});

test("usage comes from this model's free variant records only, newest first, one row per day", () => {
  const row = (date: string, variant: string, completion: number, prompt: number, count: number, permaslug = "vendor/vision-a-20260101") =>
    `{\\"date\\":\\"${date} 00:00:00\\",\\"model_permaslug\\":\\"${permaslug}\\",\\"variant\\":\\"${variant}\\",\\"total_completion_tokens\\":${completion},\\"total_prompt_tokens\\":${prompt},\\"total_native_tokens_reasoning\\":0,\\"count\\":${count},\\"change\\":null}`;
  const page = `<script>self.__next_f.push([1,"${[
    row("2026-11-05", "free", 10, 100, 3), row("2026-11-05", "standard", 999, 9999, 99),
    row("2026-11-06", "free", 20, 200, 4), row("2026-11-04", "free", 5, 50, 1), row("2026-11-04", "free", 5, 50, 2),
    row("2026-11-03", "free", 7, 70, 7, "vendor/vision-a-mini-20260101"), row("2026-11-02", "free", 8, 80, 8, "other/model-20260101"),
    // Field order must not matter, and a record with a nested object is skipped rather than misread.
    `{\\"variant\\":\\"free\\",\\"count\\":9,\\"total_prompt_tokens\\":90,\\"model_permaslug\\":\\"vendor/vision-a-20260101\\",\\"total_completion_tokens\\":9,\\"date\\":\\"2026-11-01 00:00:00\\"}`,
    `{\\"date\\":\\"2026-10-31 00:00:00\\",\\"model_permaslug\\":\\"vendor/vision-a-20260101\\",\\"variant\\":\\"free\\",\\"nested\\":{\\"total_completion_tokens\\":1,\\"total_prompt_tokens\\":1,\\"count\\":1}}`,
  ].join(",")}"])</script>`;
  assert.deepEqual(freeVariantUsage(page, "vendor/vision-a:free"), [
    { date: "2026-11-06", promptTokens: 200, completionTokens: 20, requests: 4 },
    { date: "2026-11-05", promptTokens: 100, completionTokens: 10, requests: 3 },
    { date: "2026-11-04", promptTokens: 50, completionTokens: 5, requests: 2 },
    { date: "2026-11-01", promptTokens: 90, completionTokens: 9, requests: 9 },
  ]);
  assert.deepEqual(freeVariantUsage("<html>nothing here</html>", "vendor/vision-a:free"), []);
  // A long stretch with no braces and many near-miss prefixes must not stall the parser.
  const started = performance.now();
  assert.deepEqual(freeVariantUsage(`"date":"2026-11-06" "variant":"free" `.repeat(20_000), "vendor/vision-a:free"), []);
  assert.ok(performance.now() - started < 2_000);
});

test("ranking uses completed UTC days and leaves incomplete windows unknown", () => {
  const candidates = ["b:free", "a:free", "c:free", "d:free", "e:free"].map((id) => ({ id, name: id, contextLength: null, expires: null }));
  const usage = new Map([
    ["a:free", [{ date: "2026-11-06", promptTokens: 1, completionTokens: 1, requests: 1 }]],
    ["b:free", Array.from({ length: 9 }, (_, index) => ({ date: `2026-11-0${9 - index}`, promptTokens: 10, completionTokens: 0, requests: 1 }))],
    ["c:free", []],
    // Gaps in the records do not stretch the window: only the row inside the last seven days counts.
    ["e:free", [{ date: "2026-11-09", promptTokens: 3, completionTokens: 0, requests: 1 }, { date: "2026-10-20", promptTokens: 500, completionTokens: 0, requests: 1 }]],
  ]);
  const ranked = rankByUsage(candidates, usage, 7, new Date("2026-11-09T12:00:00Z"));
  assert.deepEqual(ranked.map((model) => [model.id, model.tokens, model.days]), [["b:free", 70, 7], ["a:free", null, 1], ["c:free", null, 0], ["d:free", null, 0], ["e:free", null, 0]]);
});

test("discovery does not coerce unknown prices to free or discard extra charges", () => {
  const pricing = [
    { prompt: "0", completion: "0", request: "0", image: "0" },
    {}, { prompt: null, completion: 0 }, { prompt: "", completion: 0 },
    { prompt: false, completion: 0 }, { prompt: 0, completion: 0, request: "0.01" },
    { prompt: 0, completion: 0, image: "0.01" }, { prompt: 0, completion: 1 },
  ];
  const parsed = modelListSchema.parse({ data: pricing.map((prices, index) => ({
    ...model(`vendor/pricing-${index}:free`), pricing: prices,
  })) });
  const { candidates } = freeVisionCandidates(parsed.data);
  assert.deepEqual(candidates.map((candidate) => candidate.id), ["vendor/pricing-0:free"]);
  assert.equal(freeVisionCandidates([model("vendor/no-output:free", {
    architecture: { input_modalities: ["image"], output_modalities: [] },
  })]).candidates.length, 0);
});

test("usage parsing rejects fractional, unsafe and impossible daily records", () => {
  const row = {
    date: "2026-11-06 00:00:00", model_permaslug: "vendor/vision-a-20260101",
    variant: "free", total_prompt_tokens: 10, total_completion_tokens: 1, count: 1,
  };
  for (const change of [
    { total_prompt_tokens: 1.5 }, { total_completion_tokens: 1.5 }, { count: 1.5 },
    { total_prompt_tokens: -1 }, { total_prompt_tokens: 1e25 },
    { date: "2026-02-30 00:00:00" }, { date: "2026-13-01" }, { date: "2026-11-06pretend" },
  ]) {
    assert.deepEqual(freeVariantUsage(JSON.stringify({ ...row, ...change }), "vendor/vision-a:free"), []);
  }
  assert.deepEqual(freeVariantUsage(JSON.stringify(row, null, 2), "vendor/vision-a:free"), [
    { date: "2026-11-06", promptTokens: 10, completionTokens: 1, requests: 1 },
  ]);
});

test("completed windows deduplicate dates, cover leap days and reject unsafe totals", () => {
  const candidate = { id: "vendor/a:free", name: "a", contextLength: null, expires: null };
  const rows = ["2028-02-23", "2028-02-24", "2028-02-25", "2028-02-26", "2028-02-27", "2028-02-28", "2028-02-29"]
    .map((date) => ({ date, promptTokens: 10, completionTokens: 1, requests: 1 }));
  const now = new Date("2028-03-01T00:05:00Z");
  const usage = new Map([[candidate.id, [...rows, rows[0],
    { date: "2028-03-01", promptTokens: 9999, completionTokens: 0, requests: 1 },
    { date: "2028-03-02", promptTokens: 9999, completionTokens: 0, requests: 1 },
    { date: "2028-02-22", promptTokens: 9999, completionTokens: 0, requests: 1 },
  ]]]);
  assert.deepEqual(rankByUsage([candidate], usage, 7, now).map(({ tokens, requests, days }) => ({ tokens, requests, days })),
    [{ tokens: 77, requests: 7, days: 7 }]);
  usage.set(candidate.id, rows.map((row) => ({ ...row, promptTokens: Number.MAX_SAFE_INTEGER })));
  assert.equal(rankByUsage([candidate], usage, 7, now)[0].tokens, null);
  usage.set(candidate.id, rows.slice(1));
  assert.equal(rankByUsage([candidate], usage, 7, now)[0].tokens, null);
});

const rankedModel = (id: string, tokens: number | null = 100) => ({
  id, name: id, contextLength: null, expires: null, days: 7, tokens, requests: 1,
});

test("selection uses image and JSON probes, skips failures and returned aliases, and stops at three", async () => {
  const select = selector.selectFreeModels;
  assert.equal(typeof select, "function");
  const calls: string[] = [];
  const ranked = [
    rankedModel("vendor/unknown:free", null), rankedModel("vendor/paid"),
    { ...rankedModel("vendor/incomplete:free"), days: 6 },
    ...["a", "b", "c", "d", "e", "f", "g"].map((id) => rankedModel(`vendor/${id}:free`)),
  ];
  const result = await select(ranked, "not-a-real-key", async (protocol, id, _key, request) => {
    calls.push(id);
    assert.equal(protocol, "openrouter");
    assert.equal(request.images.length, 2);
    const { default: sharp } = await import("sharp");
    for (const [index, image] of request.images.entries()) {
      assert.equal(image.mediaType, "image/png");
      const { data, info } = await sharp(Buffer.from(image.data, "base64")).raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.width, 64);
      assert.equal(info.height, 64);
      assert.deepEqual([...data.subarray(0, 3)], index === 0 ? [255, 0, 0] : [0, 0, 255]);
    }
    if (id === "vendor/a:free") throw new Error("sensitive-key raw-provider-body");
    if (id === "vendor/b:free") return { model: id, raw: '{"colors":["blue","red"]}', usage: null };
    const model = id === "vendor/c:free" ? "vendor/shared:free" : id === "vendor/d:free" ? "VENDOR/shared" : id;
    return { model, raw: '{"colors":["red","blue"]}', usage: null };
  });
  assert.deepEqual(result.picks.map((pick) => pick.id), ["vendor/c:free", "vendor/e:free", "vendor/f:free"]);
  assert.deepEqual(calls, ["a", "b", "c", "d", "e", "f"].map((id) => `vendor/${id}:free`));
  assert.equal(result.probes.filter((probe) => probe.ok).length, 3);
  assert.doesNotMatch(JSON.stringify(result), /sensitive-key|raw-provider-body/);
});

test("selection makes no calls without a key and never exceeds six probes", async () => {
  const select = selector.selectFreeModels;
  assert.equal(typeof select, "function");
  const ranked = Array.from({ length: 9 }, (_, index) => rankedModel(`vendor/m-${index}:free`));
  let calls = 0;
  const review = async () => { calls++; throw new Error("private failure"); };
  assert.deepEqual(await select(ranked, "", review), { picks: [], probes: [] });
  assert.equal(calls, 0);
  const result = await select(ranked, "not-a-real-key", review);
  assert.equal(calls, 6);
  assert.equal(result.probes.length, 6);
  assert.deepEqual(result.picks, []);
});

test("OPENROUTER_MODELS must list distinct, well-formed ids", () => {
  assert.deepEqual(modelsFromEnv(" vendor/a:free, vendor/b-1.5:free "), ["vendor/a:free", "vendor/b-1.5:free"]);
  assert.throws(() => modelsFromEnv(undefined), /not set/);
  assert.throws(() => modelsFromEnv("vendor/a:free,vendor/a:free"), /repeats/);
  assert.throws(() => modelsFromEnv("vendor/a:free,bad id"), /invalid/);
});
