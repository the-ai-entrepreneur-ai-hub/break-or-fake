import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  freeVariantUsage, freeVisionCandidates, modelListSchema, rankByUsage, selectFreeModels,
  MAX_PROBES, USAGE_DAYS, type DailyUsage,
} from "../lib/openrouter.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const BASE = "https://openrouter.ai";
const get = (url: string, headers: Record<string, string> = {}) =>
  fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
const millions = (value: number | null) => value === null ? "unknown" : `${(value / 1_000_000).toFixed(1)}M`;
interface UsageSource { id: string; url: string; fetchedAt: string; sha256: string; rows: DailyUsage[] }

// Only the explicit free page and its free-variant records may supply these counts.
async function usageFor(ids: string[]) {
  const usage = new Map<string, DailyUsage[]>();
  const sources: UsageSource[] = [];
  await Promise.all(ids.map(async (id) => {
    usage.set(id, []);
    const url = `${BASE}/${id}`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const page = await get(url);
        if (page.ok) {
          const html = await page.text();
          const rows = freeVariantUsage(html, id);
          usage.set(id, rows);
          sources.push({ id, url, fetchedAt: new Date().toISOString(), sha256: createHash("sha256").update(html).digest("hex"), rows });
          return;
        }
        await page.body?.cancel();
        if (page.status === 404) return;
      } catch { /* Public-page failures remain unknown; never substitute another variant. */ }
      if (attempt === 1) await new Promise((done) => setTimeout(done, 1_000));
    }
  }));
  return { usage, sources: sources.sort((a, b) => a.id.localeCompare(b.id)) };
}

async function saveReport(record: unknown) {
  await mkdir(resolve(root, ".notes"), { recursive: true, mode: 0o700 });
  const report = await open(resolve(root, ".notes/openrouter-models.json"), "w", 0o600);
  try {
    await report.chmod(0o600);
    await report.writeFile(`${JSON.stringify(record, null, 2)}\n`);
  } finally {
    await report.close();
  }
}

async function main(): Promise<number> {
  // Freeze the window before fetching, including when a run crosses UTC midnight.
  const asOf = new Date();
  const endExclusive = asOf.toISOString().slice(0, 10);
  const midnight = Date.parse(`${endExclusive}T00:00:00Z`);
  const window = {
    startDate: new Date(midnight - USAGE_DAYS * 86_400_000).toISOString().slice(0, 10),
    endDate: new Date(midnight - 86_400_000).toISOString().slice(0, 10), days: USAGE_DAYS,
  };
  const list = await get(`${BASE}/api/v1/models`);
  if (!list.ok) throw new Error("catalog request failed");
  const { data } = modelListSchema.parse(await list.json());
  const { candidates, excluded } = freeVisionCandidates(data);
  console.log(`${data.length} models listed, ${candidates.length + excluded.length} explicit free variants, ${candidates.length} compatible zero-priced candidates.`);
  for (const { id, reason } of excluded) console.log(`  skipped ${id}: ${reason}`);

  const { usage, sources } = await usageFor(candidates.map((candidate) => candidate.id));
  const ranked = rankByUsage(candidates, usage, USAGE_DAYS, asOf);
  const known = ranked.filter((model) => model.tokens !== null).length;
  const citation = `Source: OpenRouter (openrouter.ai/rankings), as of ${window.endDate}.`;
  console.log(`\nFree-variant tokens, ${window.startDate} through ${window.endDate} UTC (${known}/${ranked.length} complete windows):`);
  ranked.forEach((model, index) => console.log(`  ${index + 1}. ${model.id}  tokens ${millions(model.tokens)}  requests ${model.requests ?? "unknown"}  coverage ${model.days}/${USAGE_DAYS}${model.expires ? `  expires ${model.expires}` : ""}`));
  console.log(`${citation}\nUsage measures popularity, not evidence-review accuracy.`);

  const key = process.env.OPENROUTER_API_KEY?.trim() ?? "";
  let blocked = !key ? "OPENROUTER_API_KEY is not configured." :
    known < 2 ? "Fewer than two candidates have complete observed usage." : "";
  if (!blocked) {
    const account = await get(`${BASE}/api/v1/key`, { authorization: `Bearer ${key}` });
    if (!account.ok) {
      await account.body?.cancel();
      blocked = `Key check returned HTTP ${account.status}.`;
    } else {
      const info = await account.json() as { data?: { free_model_daily_requests?: { used?: number; limit?: number } } };
      const daily = info.data?.free_model_daily_requests;
      const used = Number.isSafeInteger(daily?.used) && daily!.used! >= 0 ? daily!.used! : null;
      const limit = Number.isSafeInteger(daily?.limit) && daily!.limit! >= 0 ? daily!.limit! : null;
      console.log(`\nKey validated; API-reported free requests today: ${used ?? "unknown"} of ${limit ?? "unknown"}.`);
      if (used !== null && limit !== null && limit - used < 2) blocked = "The reported free-request allowance cannot cover two probes.";
    }
  }
  if (!blocked) console.log(`Checking images and JSON on at most ${MAX_PROBES} ranked free models; no paid fallback.`);
  const selection = blocked ? { picks: [], probes: [] } : await selectFreeModels(ranked, key);
  for (const probe of selection.probes) console.log(`  ${probe.model}: ${probe.ok ? `passed (${probe.returnedModel})` : probe.error}`);
  if (!blocked && selection.picks.length < 2) blocked = "Fewer than two distinct free models passed the image/JSON probe.";
  const picks = blocked ? [] : selection.picks.map((model) => model.id);
  await saveReport({
    asOf: asOf.toISOString(), status: blocked ? "blocked" : "ready", reason: blocked || null,
    usageDays: USAGE_DAYS, window, citation, picks, ranked, excluded, sources, probes: selection.probes,
  });
  if (blocked) {
    console.error(`\nBlocked: ${blocked} No model configuration was emitted.`);
    return 77;
  }
  console.log(`\nValidated configuration (not written to .env):\nOPENROUTER_MODELS=${picks.join(",")}`);
  return 0;
}

let code = 1;
try { code = await main(); }
catch {
  console.error("Model selection failed. No model configuration was emitted.");
  try { await saveReport({ asOf: new Date().toISOString(), status: "error", reason: "OpenRouter request or metadata validation failed.", picks: [] }); }
  catch { console.error("The selection report could not be written."); }
}
// Public fetches can leave pooled sockets alive; exit only after output has flushed.
process.stdout.write("", () => process.exit(code));
