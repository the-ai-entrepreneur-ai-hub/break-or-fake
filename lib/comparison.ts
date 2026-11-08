import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { loadCapture } from "./capture-artifacts.js";
import { listingHash } from "./listing.js";
import { readCredentials } from "./provenance.js";
import { decideSpike, findingsSchema, summarizeSpike, trialResultSchema } from "./spike.js";
import { estimateCost, MODEL_ID, protocolSchema, ratesSchema, reviewImages, usageSchema, type Protocol, type VisionResponse } from "./vision.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const labelSchema = z.object({ id: z.string().uuid(), group: z.enum(["honest", "replay"]), device: z.enum(["iphone", "android"]) });
const trialSchema = labelSchema.extend({
  buyerMessage: z.string().max(1000),
  listing: z.object({
    path: z.string().min(1), mimeType: z.enum(["image/jpeg", "image/png"]),
    title: z.string(), price: z.string().regex(/^\d+\.\d{2}$/),
  }).strict(),
}).strict();
export const comparisonConfigSchema = z.object({
  runId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  profiles: z.array(z.object({
    protocol: protocolSchema,
    model: z.string().regex(MODEL_ID),
    rates: ratesSchema.optional(),
  }).strict()).length(3).refine((profiles) => new Set(profiles.map((profile) => profile.protocol)).size === 3),
}).strict();
export type ComparisonConfig = z.infer<typeof comparisonConfigSchema>;
const manifestSchema = z.object({
  version: z.literal(1), config: comparisonConfigSchema, systemHash: digestSchema,
  generators: z.array(z.string().min(1)).min(1),
  trials: z.array(labelSchema.extend({ inputHash: digestSchema })).min(1).max(40),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;
const resultSchema = trialResultSchema.extend({
  protocol: protocolSchema, requestedModel: z.string().min(1), runHash: digestSchema, inputHash: digestSchema,
  durationMs: z.number().finite().nonnegative(), usage: usageSchema.nullable(),
  estimatedCostUSD: z.number().finite().nonnegative().nullable(),
}).refine((result) => !result.wouldRefund || (result.codeRead && !result.error));
type Result = z.infer<typeof resultSchema>;
const keyNames: Record<Protocol, string> = {
  messages: "ANTHROPIC_API_KEY", responses: "REVIEW_RESPONSES_KEY", generate: "REVIEW_GENERATE_KEY", openrouter: "OPENROUTER_API_KEY",
};
export interface ComparisonOptions {
  env?: NodeJS.ProcessEnv;
  reportOnly?: boolean;
  review?: typeof reviewImages;
}

async function optionalJSON(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

async function loadTrial(root: string, trial: z.infer<typeof trialSchema>) {
  const capture = await loadCapture(resolve(root, ".notes/captures"), trial.id);
  const imagePath = await realpath(resolve(root, trial.listing.path));
  if (!imagePath.startsWith(`${root}${sep}`)) throw new Error("listing outside workspace");
  const bytes = await readFile(imagePath);
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error("invalid listing image size");
  const listing = listingHash(bytes, trial.listing.title, trial.listing.price);
  return {
    capture, listing,
    inputHash: hash({ trial, listing, capture: capture.metadata }),
    images: [{ bytes, mediaType: trial.listing.mimeType }, ...capture.images],
    task: JSON.stringify({ listing: { title: trial.listing.title, price: trial.listing.price }, buyerMessage: trial.buyerMessage }),
  };
}

async function readResults(directory: string, config: ComparisonConfig, manifest?: Manifest): Promise<Result[]> {
  const results: Result[] = [];
  for (const profile of config.profiles) {
    let files: string[];
    try { files = await readdir(resolve(directory, profile.protocol)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
      const result = resultSchema.parse(await optionalJSON(resolve(directory, profile.protocol, file)));
      const trial = manifest?.trials.find((value) => value.id === result.id);
      if (!manifest || !trial || file !== `${result.id}.json` || result.protocol !== profile.protocol ||
          result.requestedModel !== profile.model || result.runHash !== hash(manifest) ||
          result.inputHash !== trial.inputHash || result.group !== trial.group || result.device !== trial.device) {
        throw new Error("comparison result does not match its frozen inputs");
      }
      results.push(result);
    }
  }
  return results;
}

function summarize(config: ComparisonConfig, results: Result[]) {
  const models = config.profiles.map((profile) => {
    const rows = results.filter((result) => result.protocol === profile.protocol);
    const live = rows.filter((result) => result.mode === "live");
    const durations = live.filter((result) => !result.error).map((result) => result.durationMs).sort((a, b) => a - b);
    const used = live.flatMap((result) => result.usage ? [result.usage] : []);
    return {
      protocol: profile.protocol, requestedModel: profile.model,
      returnedModels: [...new Set(live.filter((result) => !result.error).map((result) => result.model))],
      ...summarizeSpike(rows),
      latencyMs: { observations: durations.length, mean: durations.length ? durations.reduce((sum, n) => sum + n, 0) / durations.length : null,
        p95: durations.length ? durations[Math.ceil(durations.length * 0.95) - 1] : null },
      usage: { observations: used.length, input: used.reduce((sum, value) => sum + value.input, 0), output: used.reduce((sum, value) => sum + value.output, 0) },
      estimatedCostUSD: live.length && live.every((result) => result.estimatedCostUSD !== null)
        ? live.reduce((sum, result) => sum + result.estimatedCostUSD!, 0) : null,
    };
  });
  return {
    asOf: new Date().toISOString(), runId: config.runId,
    status: models.every((model) => model.decision !== "blocked") ? "complete" : "blocked",
    models, eligibleProtocols: models.filter((model) => model.decision === "go").map((model) => model.protocol), moneyCalls: 0,
  };
}

async function compare(root: string, directory: string, config: ComparisonConfig, options: ComparisonOptions) {
  const env = options.env ?? process.env;
  const review = options.review ?? reviewImages;
  const saved = await optionalJSON(resolve(directory, "manifest.json"));
  let manifest = saved === undefined ? undefined : manifestSchema.parse(saved);
  if (manifest && hash(manifest.config) !== hash(config)) throw new Error("configuration changed; use a new run id");
  let trials: z.infer<typeof trialSchema>[] = [];
  let system = "";
  if (!options.reportOnly && config.profiles.some((profile) => env[keyNames[profile.protocol]]?.trim())) {
    const input = await optionalJSON(resolve(root, ".notes/trials.json"));
    if (input !== undefined) {
      trials = z.array(trialSchema).min(1).max(40).parse(input);
      if (new Set(trials.map((trial) => trial.id)).size !== trials.length) throw new Error("duplicate trial ids");
      system = await readFile(resolve(root, ".notes/review-system.txt"), "utf8");
      const generators = z.array(z.string().min(1)).min(1).parse(await optionalJSON(resolve(root, ".notes/generators.json")));
      const references = [];
      for (const trial of trials) {
        const loaded = await loadTrial(root, trial);
        references.push({ id: trial.id, group: trial.group, device: trial.device, inputHash: loaded.inputHash });
      }
      const proposed: Manifest = { version: 1, config, systemHash: hash(system), generators, trials: references };
      if (manifest && hash(manifest) !== hash(proposed)) throw new Error("run inputs changed; use a new run id");
      if (!manifest) await writeFile(resolve(directory, "manifest.json"), JSON.stringify(proposed, null, 2), { flag: "wx", mode: 0o600 });
      manifest = proposed;
    }
  }
  const results = await readResults(directory, config, manifest);
  for (const trial of trials) {
    const pending = config.profiles.filter((profile) => env[keyNames[profile.protocol]]?.trim() &&
      !results.some((result) => result.protocol === profile.protocol && result.id === trial.id));
    if (!pending.length) continue;
    const loaded = await loadTrial(root, trial);
    if (loaded.inputHash !== manifest!.trials.find((value) => value.id === trial.id)?.inputHash) throw new Error("capture changed; use a new run id");
    const credentials = await Promise.all(loaded.images.map((image) => readCredentials(image.bytes, image.mediaType, manifest!.generators)));
    const request = { system, task: loaded.task, images: loaded.images.map((image) => ({ mediaType: image.mediaType, data: image.bytes.toString("base64") })) };
    for (const profile of pending) {
      let reply: VisionResponse | undefined;
      let finding: unknown;
      let decision = { codeRead: false, wouldRefund: false };
      let error: string | undefined;
      const started = performance.now();
      try {
        reply = await review(profile.protocol, profile.model, env[keyNames[profile.protocol]]!.trim(), request);
        const findings = findingsSchema.parse(JSON.parse(reply.raw));
        finding = findings;
        decision = decideSpike(findings, loaded.capture.metadata.session.code, credentials, trial.buyerMessage);
      } catch { error = "Review failed; held and excluded from completed trials."; }
      const result: Result = resultSchema.parse({
        id: trial.id, group: trial.group, device: trial.device, protocol: profile.protocol, requestedModel: profile.model,
        mode: "live", model: reply?.model ?? "not-run", runHash: hash(manifest), inputHash: loaded.inputHash,
        at: new Date().toISOString(), durationMs: performance.now() - started, usage: reply?.usage ?? null,
        estimatedCostUSD: estimateCost(reply?.usage ?? null, profile.rates),
        ...decision, ...(error ? { error } : {}), findings: finding, raw: reply?.raw,
        credentials, listingHash: loaded.listing, capture: loaded.capture.metadata, moneyCalls: 0,
      });
      const folder = resolve(directory, profile.protocol);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(resolve(folder, `${trial.id}.json`), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
      results.push(result);
    }
  }
  const report = summarize(config, results);
  await writeFile(resolve(directory, "comparison.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const rows = report.models.map((model) => `| ${model.protocol} | ${model.requestedModel} | ${model.decision} | ${model.honest.codesRead}/${model.honest.completed} | ${model.honest.held}/${model.honest.completed} | ${model.replay.wouldRefund}/${model.replay.completed} | ${model.latencyMs.mean?.toFixed(0) ?? "unknown"} | ${model.estimatedCostUSD?.toFixed(6) ?? "unknown"} |`);
  await writeFile(resolve(directory, "comparison.md"), `# Capture comparison\n\nRecorded ${report.asOf}. Status: ${report.status}. Money calls: 0.\n\n| Protocol | Requested model | Decision | Honest codes | Honest holds | Replays that would refund | Mean ms | Estimated USD |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\nEach model needs 20 honest trials across both phones and 20 replays. Pass requires at least 18/20 honest codes and 0/20 replay refund candidates. Zero observations are not a pass. Recorded-only results never count. Cost uses configured per-token rates, not an invoice; missing usage or pricing is unknown. See comparison.json for errors, returned model versions, token counts and latency coverage.\n`, { mode: 0o600 });
  return report;
}

export async function runComparison(root: string, input: ComparisonConfig, options: ComparisonOptions) {
  const config = comparisonConfigSchema.parse(input);
  root = await realpath(root);
  const directory = resolve(root, ".notes/comparisons", config.runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = resolve(directory, "run.lock");
  try { await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch { throw new Error("comparison is already running; inspect its local lock before retrying"); }
  try { return await compare(root, directory, config, options); }
  finally { await unlink(lock); }
}
