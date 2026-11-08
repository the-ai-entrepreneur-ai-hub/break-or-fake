import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppStore } from "../lib/app-store.js";
import { tokenDigest, newCapability, SellerSessions, RateLimiter } from "../lib/app-security.js";

test("application records survive a fresh database connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "refund-store-"));
  try {
    const first = new AppStore(directory);
    first.put("settings", "restart-check", { value: 7 });
    first.close();
    const second = new AppStore(directory);
    assert.deepEqual(second.get("settings", "restart-check"), { value: 7 });
    assert.equal(second.get("settings", "absent"), undefined);
    second.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("durable leases prevent overlapping workers and expire", async () => {
  const directory = await mkdtemp(join(tmpdir(), "refund-lease-"));
  const a = new AppStore(directory), b = new AppStore(directory);
  try {
    assert.equal(a.acquire("claim-1", "a", 100, 1000), true);
    assert.equal(b.acquire("claim-1", "b", 101, 1000), false);
    a.release("claim-1", "not-a");
    assert.equal(b.acquire("claim-1", "b", 102, 1000), false);
    assert.equal(b.acquire("claim-1", "b", 1100, 1000), true);
    b.release("claim-1", "b");
    assert.equal(a.acquire("claim-1", "a", 1101, 1000), true);
  } finally { a.close(); b.close(); await rm(directory, { recursive: true, force: true }); }
});

test("capabilities are unpredictable and sessions expire without exposing passwords", () => {
  const a = newCapability(), b = newCapability();
  assert.notEqual(a, b);
  assert.equal(a.length >= 40, true);
  assert.notEqual(tokenDigest(a), a);
  let now = 100;
  const sessions = new SellerSessions("a-long-local-test-password", () => now);
  assert.throws(() => sessions.login("wrong"), /password/i);
  const token = sessions.login("a-long-local-test-password");
  assert.equal(sessions.valid(token), true);
  assert.equal(sessions.valid("not-the-token"), false);
  now += 9 * 60 * 60_000;
  assert.equal(sessions.valid(token), false);
  assert.throws(() => new SellerSessions("").login(""), /configured/i);
});

test("rate limits bound requests and recover after the window", () => {
  let now = 0;
  const limit = new RateLimiter(2, 1000, () => now);
  assert.equal(limit.take("client"), true);
  assert.equal(limit.take("client"), true);
  assert.equal(limit.take("client"), false);
  assert.equal(limit.take("other"), true);
  now = 1000;
  assert.equal(limit.take("client"), true);
});

test("viewer sessions retain their role through reads, logout, and expiry", () => {
  let now = 100;
  const sessions = new SellerSessions("a-long-seller-password", () => now, "a-long-viewer-password");
  const viewer = sessions.login("a-long-viewer-password");
  const seller = sessions.login("a-long-seller-password");
  assert.equal(sessions.role(viewer), "viewer");
  assert.equal(sessions.role(seller), "seller");
  assert.equal(sessions.valid(viewer), true);
  assert.equal(sessions.role("unknown"), null);
  sessions.logout(seller);
  assert.equal(sessions.role(seller), null);
  assert.equal(sessions.role(viewer), "viewer");
  now += 8 * 60 * 60_000;
  assert.equal(sessions.role(viewer), null);
  assert.equal(sessions.valid(viewer), false);
});

test("viewer configuration cannot enable seller readiness or share the seller password", () => {
  const sessions = new SellerSessions("", Date.now, "a-long-viewer-password");
  assert.equal(sessions.configured, false);
  assert.equal(sessions.viewerConfigured, true);
  assert.equal(sessions.role(sessions.login("a-long-viewer-password")), "viewer");
  assert.throws(() => new SellerSessions("same-long-password", Date.now, "same-long-password"), /different/i);
  assert.throws(() => new SellerSessions("", Date.now, "short").login("short"), /configured/i);
});

test("order and image count admission enforce exact boundaries and release reservations once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "refund-count-capacity-"));
  const store = new AppStore(directory);
  try {
    for (let index = 0; index < 4997; index++) store.put("images", `test-${index}`, {});
    const release = store.reserveImages([1, 1, 1]);
    assert.throws(() => store.reserveImages([1, 1, 1]), /capacity/);
    release(); release();
    store.put("images", "extra", {});
    assert.throws(() => store.reserveImages([1, 1, 1]), /capacity/);
    const releaseTwo = store.reserveImages([1, 1]);
    assert.throws(() => store.reserveImages([1]), /capacity/);
    releaseTwo();
    for (let index = 0; index < 4999; index++) store.put("orders", `test-${index}`, {});
    const releaseOrder = store.reserveOrder();
    assert.throws(() => store.reserveOrder(), /capacity/);
    releaseOrder(); releaseOrder();
    store.put("orders", "extra", {});
    assert.throws(() => store.reserveOrder(), /capacity/);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
