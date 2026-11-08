import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { comparisonConfigSchema, runComparison } from "../lib/comparison.js";

const root = fileURLToPath(new URL("../", import.meta.url));
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--report-only") || args.length > 1) throw new Error("invalid arguments");
  let source: string;
  try { source = await readFile(resolve(root, ".notes/comparison.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    console.log("comparison skipped: .notes/comparison.json is absent");
    return 77;
  }
  const config = comparisonConfigSchema.parse(JSON.parse(source));
  const report = await runComparison(root, config, { reportOnly: args.includes("--report-only") });
  console.log(JSON.stringify(report, null, 2));
  console.log(`Report: .notes/comparisons/${config.runId}/comparison.md`);
  if (report.models.some((model) => model.errors)) return 1;
  if (report.status === "blocked") {
    console.log("comparison blocked: each model needs the full capture set and a completed review for every trial; check the local inputs and keys");
    return 77;
  }
  return report.eligibleProtocols.length ? 0 : 1;
}
try { process.exitCode = await main(); }
catch { console.error("comparison failed: check local configuration, unchanged evidence, existing results and the run lock"); process.exitCode = 1; }
