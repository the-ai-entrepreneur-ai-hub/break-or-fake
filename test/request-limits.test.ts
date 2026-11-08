import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("oversized live-frame arrays fail before per-element validation exhausts the heap", { timeout: 25_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "refund-request-limits-"));
  try {
    const child = spawnSync(process.execPath, [
      "--max-old-space-size=128", "--import", "tsx",
      fileURLToPath(new URL("./support/oversized-frames.ts", import.meta.url)), directory,
    ], { encoding: "utf8", timeout: 20_000 });
    assert.equal(child.status, 0, `Request process must survive: ${child.signal ?? child.error ?? ""}\n${child.stderr.slice(-1800)}`);
    const result = JSON.parse(child.stdout);
    assert.equal(result.count, 1_000_000);
    assert.equal(result.oversizedStatus, 400);
    assert.equal(result.validShapeStatus, 404, "Three image objects must reach normal claim lookup");
    assert.equal(result.healthStatus, 200, "Malformed input must leave the app usable");
    assert.equal(result.providerCalls, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("dense maximum-size JSON objects are rejected before parsing exhausts the heap", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "refund-dense-json-"));
  try {
    const body = ("{" + Array.from({ length: 1_200_000 }, (_, index) => `"k${index.toString(36)}":0`).join(",") + "}").padEnd(17 * 1024 * 1024, " ");
    assert.equal(Buffer.byteLength(body), 17 * 1024 * 1024);
    await writeFile(join(directory, "payload.json"), body);
    const child = spawnSync(process.execPath, [
      "--max-old-space-size=128", "--import", "tsx",
      fileURLToPath(new URL("./support/dense-json.ts", import.meta.url)), directory,
    ], { encoding: "utf8", timeout: 25_000 });
    assert.equal(child.status, 0, `Dense-request process must survive: ${child.signal ?? child.error ?? ""}\n${child.stderr.slice(-1800)}`);
    const result = JSON.parse(child.stdout);
    assert.equal(result.status, 400);
    assert.equal(result.health, 200);
    assert.equal(result.providerCalls, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
