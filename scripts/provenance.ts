import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { readCredentials } from "../lib/provenance.js";

const root = new URL("../", import.meta.url).pathname;
const schema = z.array(z.object({
  id: z.string().min(1), kind: z.enum(["original", "screenshot"]),
  path: z.string(), mimeType: z.enum(["image/jpeg", "image/png"]),
})).min(2).refine((inputs) => [...new Set(inputs.map((input) => input.id))].every((id) => {
  const pair = inputs.filter((input) => input.id === id);
  return pair.length === 2 && new Set(pair.map((input) => input.kind)).size === 2;
}), "each pair needs exactly one original and one screenshot");

async function main() {
  let text: string;
  try { text = await readFile(resolve(root, ".notes/provenance-inputs.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    console.log("provenance spike skipped: no original and screenshot pairs supplied");
    return 77;
  }
  const inputs = schema.parse(JSON.parse(text));
  const generators = z.array(z.string().min(1)).min(1).parse(JSON.parse(await readFile(resolve(root, ".notes/generators.json"), "utf8")));
  const results = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const path = await realpath(resolve(root, input.path));
    if (!path.startsWith(`${root.replace(/\/$/, "")}${sep}`)) throw new Error("image must be inside this workspace");
    const pairPath = `${input.id}\0${path}`;
    if (seen.has(pairPath)) throw new Error("original and screenshot must be distinct files");
    seen.add(pairPath);
    const bytes = await readFile(path);
    results.push({ ...input, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
      ...await readCredentials(bytes, input.mimeType, generators) });
  }
  await writeFile(resolve(root, ".notes/provenance-results.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2), { flag: "wx", mode: 0o600 });
  console.log(`read ${results.length} original files without re-encoding; results saved in ignored notes`);
  return results.some((result) => result.status === "unreadable") ? 1 : 0;
}
try { process.exitCode = await main(); }
catch { console.error("provenance spike failed: check local inputs; existing results are never overwritten"); process.exitCode = 1; }
