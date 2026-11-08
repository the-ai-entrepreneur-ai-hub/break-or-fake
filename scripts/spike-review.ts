import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { loadCapture } from "../lib/capture-artifacts.js";
import { listingHash } from "../lib/listing.js";
import { makeClient, runText } from "../lib/llm.js";
import { readCredentials } from "../lib/provenance.js";
import { decideSpike, findingsSchema, trialResultSchema } from "../lib/spike.js";

const root = new URL("../", import.meta.url).pathname;
const trialsSchema = z.array(z.object({
  id: z.string().uuid(), group: z.enum(["honest", "replay"]), device: z.enum(["iphone", "android"]),
  buyerMessage: z.string().max(1000),
  listing: z.object({ path: z.string(), mimeType: z.enum(["image/jpeg", "image/png"]), title: z.string(), price: z.string().regex(/^\d+\.\d{2}$/) }),
}).strict()).max(40);

async function main(): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    console.log("spike review skipped: model key is absent; no review was measured");
    return 77;
  }
  let source: string;
  try { source = await readFile(resolve(root, ".notes/trials.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    console.log("spike review skipped: .notes/trials.json is absent; no review was measured");
    return 77;
  }
  const trials = trialsSchema.parse(JSON.parse(source));
  if (!trials.length) { console.log("spike review skipped: no trials supplied"); return 77; }
  if (new Set(trials.map((trial) => trial.id)).size !== trials.length) throw new Error("duplicate trial ids");
  const generators = z.array(z.string().min(1)).min(1).parse(JSON.parse(await readFile(resolve(root, ".notes/generators.json"), "utf8")));
  const system = await readFile(resolve(root, ".notes/review-system.txt"), "utf8");
  const results = resolve(root, ".notes/spike-results");
  await mkdir(results, { recursive: true });
  let failures = 0;
  for (const trial of trials) {
    const path = resolve(results, `${trial.id}.json`);
    try {
      const existing = trialResultSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (existing.error) failures++;
      console.log(`already measured: ${trial.id}; preserved existing result`);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const models: string[] = [];
    const started = performance.now();
    try {
      const capture = await loadCapture(resolve(root, ".notes/captures"), trial.id);
      const imagePath = await realpath(resolve(root, trial.listing.path));
      if (!imagePath.startsWith(`${root.replace(/\/$/, "")}${sep}`)) throw new Error("listing must be inside this workspace");
      const bytes = await readFile(imagePath);
      if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error("invalid listing image size");
      const images = [{ bytes, mediaType: trial.listing.mimeType }, ...capture.images];
      const credentials = await Promise.all(images.map((image) => readCredentials(image.bytes, image.mediaType, generators)));
      const create = makeClient();
      const raw = await runText({
        createMessage: async (params) => {
          const response = await create(params);
          models.push(response.model);
          return response;
        },
        system,
        task: JSON.stringify({ listing: { title: trial.listing.title, price: trial.listing.price }, buyerMessage: trial.buyerMessage }),
        images: images.map((image) => ({ mediaType: image.mediaType, data: image.bytes.toString("base64") })),
        tools: {},
      });
      const findings = findingsSchema.parse(JSON.parse(raw));
      const decision = decideSpike(findings, capture.metadata.session.code, credentials, trial.buyerMessage);
      await writeFile(path, JSON.stringify({
        id: trial.id, group: trial.group, device: trial.device, mode: "live",
        model: models.at(-1), models, at: new Date().toISOString(), durationMs: performance.now() - started,
        ...decision, findings, credentials, capture: capture.metadata,
        listingHash: listingHash(bytes, trial.listing.title, trial.listing.price),
        imageHashes: images.map((image) => createHash("sha256").update(image.bytes).digest("hex")),
        raw, moneyCalls: 0,
      }, null, 2), { flag: "wx", mode: 0o600 });
      console.log(`measured ${trial.id}`);
    } catch {
      failures++;
      await writeFile(path, JSON.stringify({
        id: trial.id, group: trial.group, device: trial.device, mode: "live",
        model: models.at(-1) || "not-run", at: new Date().toISOString(),
        codeRead: false, wouldRefund: false, error: "Review failed; inspect local inputs and retry in a separate run.",
      }, null, 2), { flag: "wx", mode: 0o600 });
      console.error(`review failed for ${trial.id}; held, not counted as a completed trial`);
    }
  }
  return failures ? 1 : 0;
}
try { process.exitCode = await main(); }
catch { console.error("spike review failed: check the local trial manifest, prompts and evidence files"); process.exitCode = 1; }
