import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { makeCaptureHandler } from "../lib/capture-server.js";
import type { CaptureSession } from "../lib/capture.js";

test("capture server persists original frames and server facts, not client outcomes", async () => {
  const directory = await mkdtemp(resolve(".notes/capture-test-"));
  const server = createServer(makeCaptureHandler(directory));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown, origin = base) => fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await post("/sessions", { orderId: "order-test" }, "https://other.invalid")).status, 403);
    assert.equal((await post("/sessions", { orderId: "../outside" })).status, 400);
    const issued = await post("/sessions", { orderId: "order-test" });
    assert.equal(issued.status, 201);
    const session = await issued.json() as CaptureSession;
    const frames = ["1", "2", "3"].map((text) => ({ mimeType: "image/png", data: Buffer.from(`original-${text}`).toString("base64") }));
    const body = { orderId: session.orderId, nonce: session.nonce, frames, approved: true, code: "000" };
    const captured = await post(`/sessions/${session.id}/frames`, body);
    assert.equal(captured.status, 201);
    const metadata = JSON.parse(await readFile(resolve(directory, session.id, "capture.json"), "utf8"));
    assert.equal(metadata.session.code, session.code);
    assert.equal(metadata.approved, undefined);
    assert.equal(metadata.mode, "spike");
    assert.ok(Number.isFinite(metadata.receivedAt));
    assert.equal(await readFile(resolve(directory, session.id, "frame-1.png"), "utf8"), "original-1");
    assert.equal((await post(`/sessions/${session.id}/frames`, body)).status, 400);
    assert.equal((await fetch(`${base}/captures/${session.id}/frame-1.png`)).status, 404);
    assert.equal((await readdir(directory)).length, 1);
  } finally {
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    await rm(directory, { recursive: true, force: true });
  }
});
