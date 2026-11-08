import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AppStore } from "../lib/app-store.js";
import { validateImage } from "../lib/app-images.js";
import { makeEvidenceReviewer, decideEvidence } from "../lib/app-review.js";
import { readCredentials } from "../lib/provenance.js";
import { loadCapture } from "../lib/capture-artifacts.js";
import type { StoredClaim, StoredImage, StoredOrder } from "../lib/app-records.js";
import type { EvaluationSummary, ImageInput } from "../lib/app-types.js";
import { EMPTY_EVALUATION, validateManifest, fingerprint, assertFrozen, runRecordedEvaluation, summarizeEvaluation, type EvaluationRow, type EvaluationManifest } from "../lib/evaluation.js";

const argv = process.argv.slice(2);
const option = (name: string) => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
const mode = argv.includes("--live") ? "live" : "recorded";
const runId = option("--run") ?? `${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new Error("Invalid evaluation run identifier.");
const store = new AppStore(resolve(process.env.DATA_DIR ?? ".data"));
const directory = join(store.directory, "evaluations", runId);
await mkdir(directory, { recursive: true, mode: 0o700 });
const lock = join(directory, "run.lock");
await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
const manifest = validateManifest(JSON.parse(await readFile(new URL("../eval/cases.json", import.meta.url), "utf8")));
const at = new Date().toISOString();
const models = (process.env.OPENROUTER_MODELS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const reviewer = makeEvidenceReviewer(process.env.OPENROUTER_API_KEY ?? "", models);
const inputSchema = z.object({
  cases: z.array(z.object({
    id: z.string(), claimId: z.string().uuid().optional(), listingPath: z.string().optional(),
    uploadPath: z.string().optional(), captureRoot: z.string().optional(), captureId: z.string().uuid().optional(),
  }).strict()).length(10),
}).strict();
type Input = z.infer<typeof inputSchema>["cases"][number];
async function fileImage(path: string): Promise<ImageInput> {
  const bytes = await readFile(resolve(path));
  const image: ImageInput = { mimeType: bytes[0] === 0x89 ? "image/png" : "image/jpeg", data: bytes.toString("base64") };
  await validateImage(image); return image;
}
async function evidence(row: EvaluationManifest["cases"][number], input: Input) {
  let listing: ImageInput, images: ImageInput[], code: string | undefined, sessionHash: string | undefined;
  if (input.claimId) {
    const claim = store.get<StoredClaim>("claims", input.claimId);
    if (!claim || claim.evidenceKind !== row.evidence) throw new Error("Claim evidence does not match its case.");
    const order = store.get<StoredOrder>("orders", claim.orderId);
    if (!order) throw new Error("Missing original order.");
    const original = async (id: string) => {
      const image = store.get<StoredImage>("images", id);
      if (!image || image.orderId !== order.id) throw new Error("Missing order-bound original.");
      const bytes = await readFile(join(store.directory, "evidence", id));
      if (fingerprintBytes(bytes) !== image.sha256) throw new Error("Original evidence changed.");
      const value = { mimeType: image.mimeType, data: bytes.toString("base64") };
      await validateImage(value); return value;
    };
    listing = await original(order.listingImageId);
    images = await Promise.all(claim.imageIds.map(original));
    if (row.evidence === "live") {
      const session = claim.captureSession;
      if (!session || session.expiresAt - session.issuedAt !== 120_000 || session.receivedAt < session.issuedAt ||
          session.receivedAt >= session.expiresAt || images.length !== 3 ||
          session.hashes.some((hash, index) => hash !== fingerprintBytes(Buffer.from(images[index].data, "base64")))) throw new Error("Invalid saved live session.");
      code = session.code; sessionHash = fingerprint(session);
    }
  } else {
    if (!input.listingPath) throw new Error("An original listing photo is required.");
    listing = await fileImage(input.listingPath);
    if (row.evidence === "upload") {
      if (!input.uploadPath) throw new Error("An original uploaded photo is required.");
      images = [await fileImage(input.uploadPath)];
    } else {
      if (!input.captureRoot || !input.captureId) throw new Error("A saved capture session is required.");
      const capture = await loadCapture(resolve(input.captureRoot), input.captureId);
      code = capture.metadata.session.code; sessionHash = fingerprint(capture.metadata);
      images = capture.images.map((image) => ({ mimeType: image.mediaType, data: image.bytes.toString("base64") }));
      for (const image of images) await validateImage(image);
    }
  }
  if (images.length !== (row.evidence === "live" ? 3 : 1)) throw new Error("Wrong number of evidence images.");
  const hashes = [listing, ...images].map((image) => fingerprintBytes(Buffer.from(image.data, "base64")));
  if (sessionHash) hashes.push(sessionHash);
  return { listing, images, code, hashes };
}
function fingerprintBytes(bytes: Buffer): string {
  // The same byte-hash representation is used by saved capture artifacts.
  return createHash("sha256").update(bytes).digest("hex");
}
import { createHash } from "node:crypto";
let report: ReturnType<typeof summarizeEvaluation>;
try {
  if (mode === "recorded") report = runRecordedEvaluation(manifest, at);
  else {
    const path = option("--inputs") ?? ".notes/eval-inputs.json";
    let inputs: Input[] = [], blocked = "";
    try {
      inputs = inputSchema.parse(JSON.parse(await readFile(resolve(path), "utf8"))).cases;
      if (new Set(inputs.map((input) => input.id)).size !== 10 || inputs.some((input) => !manifest.cases.some((row) => row.id === input.id))) throw new Error("Input IDs must match the frozen ten-case manifest.");
    } catch { blocked = "Original inputs for all ten cases are missing or invalid. No live request was made."; }
    if (!reviewer.ready) blocked = "Configure two or three photo reviewers before a live evaluation. No live request was made.";
    const frozenHashes: Record<string, string[]> = {};
    if (!blocked) {
      try { for (const row of manifest.cases) frozenHashes[row.id] = (await evidence(row, inputs.find((input) => input.id === row.id)!)).hashes; }
      catch { blocked = "Original evidence or fresh-capture metadata is missing, invalid, or changed. No live request was made."; }
    }
    if (blocked) {
      report = { ...summarizeEvaluation(manifest, [], "live", at), notice: blocked };
      process.exitCode = 77;
    } else {
      const freeze = fingerprint({ manifest, models, hashes: frozenHashes });
      const freezePath = join(directory, "frozen.json");
      try { const previous = JSON.parse(await readFile(freezePath, "utf8")); assertFrozen(previous.fingerprint, freeze); }
      catch (error: unknown) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
        await writeFile(freezePath, JSON.stringify({ fingerprint: freeze, manifest, models, hashes: frozenHashes }, null, 2), { flag: "wx", mode: 0o600 });
      }
      const rows: EvaluationRow[] = [];
      let nextReview = 0;
      for (const row of manifest.cases) {
        const resultPath = join(directory, `${row.id}.json`);
        try { rows.push(JSON.parse(await readFile(resultPath, "utf8"))); continue; }
        catch (error: unknown) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
        await delay(Math.max(0, nextReview - Date.now()));
        nextReview = Date.now() + Math.ceil(60_000 * models.length / 18);
        const started = performance.now();
        let result: EvaluationRow;
        try {
          const original = await evidence(row, inputs.find((input) => input.id === row.id)!);
          assertFrozen(fingerprint(frozenHashes[row.id]), fingerprint(original.hashes));
          const credentials = await Promise.all([original.listing, ...original.images].map((image) =>
            readCredentials(Buffer.from(image.data, "base64"), image.mimeType, ["OpenAI", "DALL-E", "Adobe Firefly", "Midjourney", "Stable Diffusion", "Qwen-Image"])));
          const reviewed = await reviewer.review({ ...original, kind: row.evidence, message: row.message, title: row.id, credentials });
          const decision = decideEvidence({ amountCents: row.amountCents, evidence: row.evidence, message: row.message, credentials,
            clear: reviewed.clear, listingBound: true, eligible: true, payerRefunds90d: 0, judge: false });
          result = { id: row.id, label: row.label, mode: "live", decision: decision.status, at: new Date().toISOString(),
            modelIds: reviewed.reviews.filter((review) => review.ok).map((review) => review.returnedModel ?? review.model),
            durationMs: Math.round(performance.now() - started), hashes: original.hashes };
        } catch {
          result = { id: row.id, label: row.label, mode: "live", decision: "held", at: new Date().toISOString(), modelIds: [],
            durationMs: Math.round(performance.now() - started), hashes: frozenHashes[row.id], error: "Review failed; this is not a completed observation." };
        }
        await writeFile(resultPath, JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
        rows.push(result);
        console.log(`${row.id}: ${result.error ? "error" : result.decision}`);
      }
      report = summarizeEvaluation(manifest, rows, "live", at);
      if (report.status !== "complete") process.exitCode = 1;
    }
  }
  const previous = store.get<EvaluationSummary>("settings", "evaluation") ?? EMPTY_EVALUATION;
  const summary: EvaluationSummary = mode === "recorded"
    ? { ...previous, recordedChecks: report.policyChecks, reportDate: report.at }
    : { ...previous, liveCompleted: report.completed, liveStatus: report.status, reportDate: report.at,
      honestHolds: report.honestHolds.total ? { count: report.honestHolds.count, total: report.honestHolds.total } : null,
      catches: report.catches.total ? { count: report.catches.count, total: report.catches.total } : null,
      falseRefunds: report.falseRefunds.total ? { count: report.falseRefunds.count, total: report.falseRefunds.total } : null };
  store.put("settings", "evaluation", summary);
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
  console.log(`Saved local report: ${join(directory, "report.json")}`);
} finally { await unlink(lock); store.close(); }
