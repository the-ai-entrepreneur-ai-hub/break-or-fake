import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { comparisonConfigSchema, runComparison, type ComparisonConfig } from "../lib/comparison.js";

const config: ComparisonConfig = {
  runId: "test-run",
  profiles: ["messages", "responses", "generate"].map((protocol) => ({
    protocol, model: `test-${protocol}`, rates: { input: 2, cachedInput: 1, output: 10 },
  })) as ComparisonConfig["profiles"],
};
const env = { ANTHROPIC_API_KEY: "test-only", REVIEW_RESPONSES_KEY: "test-only", REVIEW_GENERATE_KEY: "test-only" };
const raw = JSON.stringify({
  frames: [1, 2, 3].map((frame) => ({
    frame, codeRead: "471", handwritten: "yes", physicalScene: "yes", sameItem: "yes",
    plausibleDamage: "yes", otherText: [], reason: "test",
  })), tiltConsistent: "yes",
});
const usage = { input: 100, cachedInput: 20, cacheWrite: 0, output: 50 };
async function fixture() {
  const root = await mkdtemp(resolve(".notes/comparison-test-"));
  const id = randomUUID();
  const directory = resolve(root, ".notes/captures", id);
  await mkdir(directory, { recursive: true });
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  await writeFile(resolve(root, ".notes/listing.png"), image);
  const frames = [];
  for (let index = 1; index <= 3; index++) {
    const bytes = Buffer.concat([image, Buffer.from([index])]);
    const name = `frame-${index}.png`;
    await writeFile(resolve(directory, name), bytes);
    frames.push({ name, mimeType: "image/png", sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await writeFile(resolve(directory, "capture.json"), JSON.stringify({
    mode: "spike", session: { id, orderId: "test-order", nonce: "a".repeat(64), code: "471", issuedAt: 1000, expiresAt: 121000 },
    receivedAt: 2000, frames,
  }));
  await writeFile(resolve(root, ".notes/trials.json"), JSON.stringify([{
    id, group: "honest", device: "iphone", buyerMessage: "test",
    listing: { path: ".notes/listing.png", mimeType: "image/png", title: "Cup", price: "32.00" },
  }]));
  await writeFile(resolve(root, ".notes/review-system.txt"), "test");
  await writeFile(resolve(root, ".notes/generators.json"), '["Test Image Editor"]');
  return { root, id, close: () => rm(root, { recursive: true, force: true }) };
}

test("comparison configuration requires all three protocols without path escapes or secret fields", () => {
  assert.doesNotThrow(() => comparisonConfigSchema.parse(config));
  for (const invalid of [
    { ...config, runId: "../outside" },
    { ...config, profiles: config.profiles.slice(1) },
    { ...config, profiles: Array(3).fill(config.profiles[0]) },
    { ...config, secret: "test-only" },
  ]) assert.throws(() => comparisonConfigSchema.parse(invalid));
});

test("empty comparison reports are blocked with unknown rates, latency and cost", async () => {
  const work = await fixture();
  try {
    const report = await runComparison(work.root, config, { env: {}, reportOnly: true });
    assert.equal(report.status, "blocked");
    assert.equal(report.models.length, 3);
    for (const model of report.models) {
      assert.equal(model.honest.completed, 0);
      assert.equal(model.replay.completed, 0);
      assert.equal(model.honest.codeReadRate, null);
      assert.equal(model.latencyMs.mean, null);
      assert.equal(model.estimatedCostUSD, null);
    }
  } finally { await work.close(); }
});

test("models receive identical evidence and preserve separate write-once results on resume", async () => {
  const work = await fixture();
  const requests: unknown[] = [];
  try {
    const review: Parameters<typeof runComparison>[2]["review"] = async (_protocol, model, _key, request) => {
      requests.push(structuredClone(request));
      assert.ok(!request.task.includes("471"));
      return { model: `${model}-v1`, raw, usage };
    };
    const report = await runComparison(work.root, config, { env, review });
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[0], requests[1]);
    assert.deepEqual(requests[1], requests[2]);
    for (const model of report.models) {
      assert.equal(model.honest.completed, 1);
      assert.equal(model.honest.codesRead, 1);
      assert.equal(model.estimatedCostUSD, 0.00068);
      assert.equal(model.decision, "blocked");
      const saved = await readFile(resolve(work.root, ".notes/comparisons/test-run", model.protocol, `${work.id}.json`), "utf8");
      assert.doesNotMatch(saved, /test-only/);
    }
    await runComparison(work.root, config, { env, review });
    assert.equal(requests.length, 3);
    await writeFile(resolve(work.root, ".notes/review-system.txt"), "changed");
    await assert.rejects(runComparison(work.root, config, { env, review }), /changed.*new run/i);
    assert.equal(requests.length, 3);
  } finally { await work.close(); }
});

test("missing keys and failed model reviews cannot become completed observations on resume", async () => {
  const work = await fixture();
  let calls = 0;
  try {
    const review: Parameters<typeof runComparison>[2]["review"] = async () => { calls++; throw new Error("private-provider-error"); };
    const partialEnv = { ANTHROPIC_API_KEY: "test-only" };
    for (let attempt = 0; attempt < 2; attempt++) {
      const report = await runComparison(work.root, config, { env: partialEnv, review });
      assert.equal(report.status, "blocked");
      assert.equal(report.models[0].errors, 1);
      assert.equal(report.models[0].honest.completed, 0);
      assert.equal(report.models[0].estimatedCostUSD, null);
      assert.equal(report.models[1].honest.completed, 0);
      assert.equal(report.models[2].honest.completed, 0);
    }
    assert.equal(calls, 1);
    const failure = await readFile(resolve(work.root, ".notes/comparisons/test-run/messages", `${work.id}.json`), "utf8");
    assert.doesNotMatch(failure, /private-provider-error|test-only/);
  } finally { await work.close(); }
});

test("the 20/20 threshold is separate for each model and returned-version drift blocks only that model", async () => {
  const work = await fixture();
  try {
    const source = JSON.parse(await readFile(resolve(work.root, ".notes/trials.json"), "utf8"))[0];
    const trials = [];
    for (let index = 0; index < 40; index++) {
      const id = index === 0 ? work.id : randomUUID();
      if (index) {
        const folder = resolve(work.root, ".notes/captures", id);
        await cp(resolve(work.root, ".notes/captures", work.id), folder, { recursive: true });
        const metadata = JSON.parse(await readFile(resolve(folder, "capture.json"), "utf8"));
        metadata.session.id = id;
        await writeFile(resolve(folder, "capture.json"), JSON.stringify(metadata));
      }
      trials.push({ ...source, id, group: index < 20 ? "honest" : "replay", device: index % 2 ? "iphone" : "android" });
    }
    await writeFile(resolve(work.root, ".notes/trials.json"), JSON.stringify(trials));
    let calls = 0;
    const report = await runComparison(work.root, config, {
      env, review: async (_protocol, model) => {
        const index = Math.floor(calls++ / 3);
        const answer = JSON.parse(raw);
        for (const frame of answer.frames) {
          if (index === 18 || index === 19) frame.codeRead = null;
          if (index >= 20) frame.physicalScene = "no";
        }
        return { model: `${model}-v1`, raw: JSON.stringify(answer), usage };
      },
    });
    assert.equal(calls, 120);
    assert.equal(report.status, "complete");
    assert.equal(report.eligibleProtocols.length, 3);
    for (const model of report.models) {
      assert.equal(model.honest.codesRead, 18);
      assert.equal(model.honest.completed, 20);
      assert.equal(model.replay.completed, 20);
      assert.equal(model.replay.wouldRefund, 0);
      assert.equal(model.decision, "go");
    }
    const resultPath = resolve(work.root, ".notes/comparisons/test-run/messages", `${work.id}.json`);
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    await writeFile(resultPath, JSON.stringify({ ...result, model: "test-messages-v2" }));
    const drifted = await runComparison(work.root, config, { env: {}, reportOnly: true });
    assert.equal(drifted.status, "blocked");
    assert.equal(drifted.models[0].decision, "blocked");
    assert.equal(drifted.models[1].decision, "go");
    assert.equal(drifted.models[2].decision, "go");
  } finally { await work.close(); }
});
