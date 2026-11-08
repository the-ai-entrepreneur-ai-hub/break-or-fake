import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { loadCapture } from "../lib/capture-artifacts.js";

test("review loads saved originals and refuses edited hashes or expired metadata", async () => {
  const root = await mkdtemp(resolve(".notes/artifact-test-"));
  const id = randomUUID();
  const directory = resolve(root, id);
  await mkdir(directory);
  const frame = Buffer.from("original-frame");
  const metadata = {
    mode: "spike", session: { id, orderId: "order-test", nonce: "a".repeat(64), code: "471", issuedAt: 1000, expiresAt: 121000 },
    receivedAt: 2000,
    frames: [1, 2, 3].map((number) => ({ name: `frame-${number}.jpg`, mimeType: "image/jpeg", sha256: createHash("sha256").update(Buffer.concat([frame, Buffer.from([number])])).digest("hex") })),
  };
  try {
    for (const [index, entry] of metadata.frames.entries()) await writeFile(resolve(directory, entry.name), Buffer.concat([frame, Buffer.from([index + 1])]));
    const save = () => writeFile(resolve(directory, "capture.json"), JSON.stringify(metadata));
    await save();
    assert.equal((await loadCapture(root, id)).metadata.session.code, "471");
    await writeFile(resolve(directory, "frame-1.jpg"), "changed");
    await assert.rejects(loadCapture(root, id), /hash/);
    await writeFile(resolve(directory, "frame-1.jpg"), Buffer.concat([frame, Buffer.from([1])]));
    metadata.receivedAt = metadata.session.expiresAt;
    await save();
    await assert.rejects(loadCapture(root, id), /expired/);
    await assert.rejects(loadCapture(root, "../outside"), /id/);
    assert.ok((await readFile(resolve(directory, "capture.json"))).length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
