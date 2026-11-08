import assert from "node:assert/strict";
import { test } from "node:test";
import { CaptureSessions, MAX_FRAME_BYTES, type CaptureSubmission } from "../lib/capture.js";

const frame = (suffix: string) => Buffer.from(`frame-${suffix}`).toString("base64");
const payload = (session: ReturnType<CaptureSessions["issue"]>): CaptureSubmission => ({
  orderId: session.orderId, nonce: session.nonce,
  frames: ["one", "two", "three"].map((value) => ({ mimeType: "image/jpeg", data: frame(value) })),
});

test("sessions issue unpredictable order-bound challenges expiring after two minutes", () => {
  const sessions = new CaptureSessions(() => 1000);
  const first = sessions.issue("order-1");
  const second = sessions.issue("order-1");
  assert.match(first.code, /^\d{3}$/);
  assert.equal(first.expiresAt, 121000);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.id, second.id);
  assert.ok(first.nonce.length >= 32);
});

test("submission validates order and nonce and consumes a session only once", () => {
  const sessions = new CaptureSessions(() => 1000);
  const session = sessions.issue("order-1");
  assert.throws(() => sessions.consume(session.id, { ...payload(session), orderId: "other" }), /session/);
  assert.throws(() => sessions.consume(session.id, { ...payload(session), nonce: "other" }), /session/);
  assert.equal(sessions.consume(session.id, payload(session)).session.code, session.code);
  assert.throws(() => sessions.consume(session.id, payload(session)), /session/);
});

test("expiry is enforced at the boundary, including after a slow capture", () => {
  let now = 0;
  const sessions = new CaptureSessions(() => now);
  const session = sessions.issue("order");
  now = session.expiresAt;
  assert.throws(() => sessions.consume(session.id, payload(session)), /expired/);
});

test("frames require three distinct bounded image buffers and strict base64", () => {
  const sessions = new CaptureSessions(() => 0);
  const session = sessions.issue("order");
  const good = payload(session);
  for (const frames of [[], good.frames.slice(0, 2), [...good.frames, good.frames[0]], Array(3).fill(good.frames[0])]) {
    assert.throws(() => sessions.consume(session.id, { ...good, frames }), /frames/);
  }
  assert.throws(() => sessions.consume(session.id, { ...good, frames: [{ mimeType: "image/jpeg", data: "!!!!" }, ...good.frames.slice(1)] }), /frame/);
  assert.throws(() => sessions.consume(session.id, { ...good, frames: [{ mimeType: "text/html", data: frame("x") }, ...good.frames.slice(1)] }), /frame/);
  assert.throws(() => sessions.consume(session.id, null as unknown as CaptureSubmission), /submission/);
  assert.doesNotThrow(() => sessions.consume(session.id, good));
});

test("order ids are bounded and session ids never become paths", () => {
  const sessions = new CaptureSessions();
  for (const id of ["", "../secret", "x".repeat(129)]) assert.throws(() => sessions.issue(id), /order/);
  assert.throws(() => sessions.consume("../../outside", {} as CaptureSubmission), /session/);
});

test("frames at the advertised size limit do not exhaust the validator", () => {
  const sessions = new CaptureSessions();
  const session = sessions.issue("large-frames");
  const frames = [1, 2, 3].map((value) => ({
    mimeType: "image/jpeg", data: Buffer.alloc(MAX_FRAME_BYTES, value).toString("base64"),
  }));
  assert.doesNotThrow(() => sessions.consume(session.id, { ...payload(session), frames }));
});

test("noncanonical base64 and oversized frames are refused", () => {
  const sessions = new CaptureSessions();
  const session = sessions.issue("invalid-frames");
  for (const data of ["A===", "YQ", "Y Q==", "YQ==\n", "YR==", "=YQ=", Buffer.alloc(MAX_FRAME_BYTES + 1).toString("base64")]) {
    const frames = [{ mimeType: "image/jpeg", data }, ...payload(session).frames.slice(1)];
    assert.throws(() => sessions.consume(session.id, { ...payload(session), frames }), /frame/);
  }
});
