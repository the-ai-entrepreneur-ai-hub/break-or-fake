import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

async function workspace(script: string) {
  const root = await mkdtemp(resolve(".notes/command-test-"));
  await mkdir(resolve(root, "scripts"));
  await mkdir(resolve(root, ".notes"));
  await copyFile(resolve("scripts", script), resolve(root, "scripts", script));
  await symlink(resolve("lib"), resolve(root, "lib"), "dir");
  await symlink(resolve("node_modules"), resolve(root, "node_modules"), "dir");
  await writeFile(resolve(root, "no-network.mjs"), 'globalThis.fetch = async () => { console.error("unexpected network request"); throw new Error("network forbidden"); };');
  await writeFile(resolve(root, ".notes/generators.json"), '["Test Image Editor"]');
  return {
    root,
    run: (args: string[] = []) => spawnSync(process.execPath, ["--import", resolve(root, "no-network.mjs"), "--import", "tsx", resolve(root, "scripts", script), ...args], {
      cwd: root, encoding: "utf8", timeout: 15000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ANTHROPIC_API_KEY: "unused-test-placeholder" },
    }),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("resuming a preserved failed review still fails without making another request", async () => {
  const work = await workspace("spike-review.ts");
  const id = randomUUID();
  const resultPath = resolve(work.root, ".notes/spike-results", `${id}.json`);
  try {
    await mkdir(resolve(work.root, ".notes/spike-results"));
    await writeFile(resolve(work.root, ".notes/review-system.txt"), "test");
    await writeFile(resolve(work.root, ".notes/trials.json"), JSON.stringify([{
      id, group: "honest", device: "iphone", buyerMessage: "",
      listing: { path: ".notes/unused.png", mimeType: "image/png", title: "Cup", price: "32.00" },
    }]));
    const failed = JSON.stringify({
      id, group: "honest", device: "iphone", mode: "live", model: "not-run",
      at: "2026-10-16T00:00:00Z", codeRead: false, wouldRefund: false, error: "Review failed",
    });
    await writeFile(resultPath, failed);
    const result = work.run();
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /preserved existing result/);
    assert.doesNotMatch(result.stderr, /unexpected network request/);
    assert.equal(await readFile(resultPath, "utf8"), failed);
  } finally { await work.close(); }
});

test("provenance commands require an original and a distinct screenshot for every pair", async () => {
  const work = await workspace("provenance.ts");
  const original = { id: "edit-01", kind: "original", path: ".notes/original.png", mimeType: "image/png" };
  const screenshot = { ...original, kind: "screenshot", path: ".notes/screenshot.png" };
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  try {
    await writeFile(resolve(work.root, original.path), image);
    await writeFile(resolve(work.root, screenshot.path), image);
    for (const inputs of [
      [original],
      [screenshot],
      [original, { ...screenshot, id: "edit-02" }],
      [original, { ...screenshot, kind: "original" }],
      [original, { ...screenshot, path: ".notes/./original.png" }],
    ]) {
      await writeFile(resolve(work.root, ".notes/provenance-inputs.json"), JSON.stringify(inputs));
      const result = work.run();
      assert.equal(result.status, 1, `Accepted incomplete pair: ${JSON.stringify(inputs)}\n${result.stdout}\n${result.stderr}`);
      await assert.rejects(readFile(resolve(work.root, ".notes/provenance-results.json")), { code: "ENOENT" });
    }
    await writeFile(resolve(work.root, ".notes/provenance-inputs.json"), JSON.stringify([original, screenshot]));
    const result = work.run();
    assert.equal(result.status, 0, result.stderr);
    const saved = JSON.parse(await readFile(resolve(work.root, ".notes/provenance-results.json"), "utf8"));
    assert.equal(saved.results.length, 2);
    assert.ok(saved.results.every((value: { status: string }) => value.status === "missing"));
    assert.doesNotMatch(result.stderr, /unexpected network request/);
  } finally { await work.close(); }
});

test("comparison commands block without inputs and report offline without making requests", async () => {
  const work = await workspace("spike-compare.ts");
  try {
    assert.equal(work.run().status, 77);
    await writeFile(resolve(work.root, ".notes/comparison.json"), JSON.stringify({
      runId: "test-run",
      profiles: ["messages", "responses", "generate"].map((protocol) => ({ protocol, model: `test-${protocol}` })),
    }));
    for (const args of [[], ["--report-only"]]) {
      const result = work.run(args);
      assert.equal(result.status, 77, `${result.stdout}\n${result.stderr}`);
      assert.doesNotMatch(result.stderr, /unexpected network request/);
      const report = JSON.parse(await readFile(resolve(work.root, ".notes/comparisons/test-run/comparison.json"), "utf8"));
      assert.equal(report.status, "blocked");
      assert.equal(report.models.length, 3);
      assert.ok(report.models.every((model: { honest: { completed: number } }) => model.honest.completed === 0));
    }
    assert.equal(work.run(["--unknown"]).status, 1);
  } finally { await work.close(); }
});
