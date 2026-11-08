import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateManifest, runRecordedEvaluation, summarizeEvaluation, assertFrozen, fingerprint } from "../lib/evaluation.js";
const manifest = JSON.parse(await readFile(new URL("../eval/cases.json", import.meta.url), "utf8"));

test("evaluation requires exactly ten unique cases with five labels in each group", () => {
  assert.equal(validateManifest(manifest).cases.length, 10);
  assert.throws(() => validateManifest({ ...manifest, cases: manifest.cases.slice(1) }));
  assert.throws(() => validateManifest({ ...manifest, cases: [...manifest.cases, manifest.cases[0]] }));
  const duplicate = structuredClone(manifest); duplicate.cases[1].id = duplicate.cases[0].id;
  assert.throws(() => validateManifest(duplicate));
  const wrongLabels = structuredClone(manifest); wrongLabels.cases[0].label = "adversarial";
  assert.throws(() => validateManifest(wrongLabels));
});
test("scripted policy replay reports its stripped fake as a false refund, never a catch", () => {
  const result = runRecordedEvaluation(validateManifest(manifest), "2026-11-06T12:00:00.000Z");
  assert.equal(result.mode, "recorded");
  assert.equal(result.completed, 10);
  assert.equal(result.policyChecks.passed, 10);
  assert.deepEqual(result.falseRefunds, { count: 1, total: 5, rate: 0.2 });
  assert.deepEqual(result.catches, { count: 4, total: 5, rate: 0.8 });
  assert.deepEqual(result.honestHolds, { count: 0, total: 5, rate: 0 });
  assert.match(result.notice, /not.*photo|scripted/i);
});
test("absent live observations are blocked, with unknown rates and no successful cases", () => {
  const report = summarizeEvaluation(validateManifest(manifest), [], "live", "2026-11-06T12:00:00.000Z");
  assert.equal(report.status, "blocked");
  assert.equal(report.completed, 0);
  assert.equal(report.honestHolds.rate, null);
  assert.equal(report.catches.rate, null);
  assert.equal(report.falseRefunds.rate, null);
});
test("frozen manifests reject changed labels or source hashes", () => {
  const original = fingerprint({ manifest, hashes: ["original"] });
  assert.doesNotThrow(() => assertFrozen(original, original));
  assert.throws(() => assertFrozen(original, fingerprint({ manifest, hashes: ["changed"] })), /changed|frozen/i);
});
