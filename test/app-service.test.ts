import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, truncate, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { AppStore } from "../lib/app-store.js";
import { AppService } from "../lib/app-service.js";
import type { PaymentProvider, PaymentFacts, RefundFacts } from "../lib/app-payments.js";
import type { ImageInput } from "../lib/app-types.js";
import type { EvidenceReviewer } from "../lib/app-review.js";

class FakePayments implements PaymentProvider {
  ready = true; clientId = "test-public-client";
  orders = new Map<string, PaymentFacts>();
  refunds = new Map<string, RefundFacts>();
  refundCalls: string[] = [];
  timeoutOnce = false;
  reads = 0;
  async createOrder(input: { title: string; amountCents: number; listingHash: string; requestId: string }) {
    const id = `TEST-ORDER-${this.orders.size + 1}`;
    this.orders.set(id, { orderId: id, status: "CREATED", amountCents: input.amountCents, currency: "USD", listingHash: input.listingHash, refundedCents: 0, refunds: [], payerId: "test-payer" });
    return { id, status: "CREATED" };
  }
  async captureOrder(id: string) {
    const order = this.orders.get(id)!;
    order.status = "COMPLETED"; order.captureId = `TEST-CAPTURE-${id}`;
    return structuredClone(order);
  }
  async getOrder(id: string) { this.reads++; return structuredClone(this.orders.get(id)!); }
  async refund(captureId: string, amountCents: number, requestId: string) {
    this.refundCalls.push(requestId);
    if (!this.refunds.has(requestId)) {
      const result: RefundFacts = { id: `TEST-REFUND-${this.refunds.size + 1}`, status: "COMPLETED", amountCents, currency: "USD" };
      this.refunds.set(requestId, result);
      const order = [...this.orders.values()].find((row) => row.captureId === captureId)!;
      order.refundedCents += amountCents;
      order.refunds.push(result);
    }
    if (this.timeoutOnce) { this.timeoutOnce = false; throw new Error("accepted, response lost"); }
    return this.refunds.get(requestId)!;
  }
  async getRefund(id: string) { return [...this.refunds.values()].find((r) => r.id === id)!; }
}
const reviewer: EvidenceReviewer = {
  ready: true, models: ["test/a", "test/b"],
  async review() { return { clear: true, checks: [{ id: "damage", label: "Visible damage", status: "pass", detail: "Synthetic test reviewer." }], reviews: [] }; },
};
async function image(color: string): Promise<ImageInput> {
  return { mimeType: "image/png", data: (await sharp({ create: { width: 120, height: 120, channels: 3, background: color } }).png().toBuffer()).toString("base64") };
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "refund-service-"));
  const store = new AppStore(directory), payments = new FakePayments();
  let now = Date.now();
  const options = { store, payments, reviewer, now: () => now, readCredentials: async () => ({ status: "missing" as const, generated: false }) };
  const service = new AppService(options);
  const original = await image("#eeeedd");
  const order = await service.createOrder("judge-cup", original);
  await service.captureOrder(order.order.id, order.token);
  return { directory, store, payments, service, options, order, original, advance: (ms: number) => { now += ms; }, async close() { await service.idle(); store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("judge checkout binds original bytes and never trusts another capability", async () => {
  const ctx = await setup();
  try {
    const order = ctx.service.getOrder(ctx.order.order.id, ctx.order.token);
    assert.equal(order.amountCents, 2500);
    assert.equal(order.isJudge, true);
    assert.equal(order.simulatedDelivery, true);
    assert.equal(order.status, "captured");
    assert.equal(order.listingHash, ctx.payments.orders.get(order.paypalOrderId)!.listingHash);
    assert.throws(() => ctx.service.getOrder(order.id, "wrong"), /access/i);
    assert.equal((await ctx.service.captureOrder(order.id, ctx.order.token)).captureId, order.captureId);
    await assert.rejects(ctx.service.createOrder("unknown", ctx.original), /product/i);
    await assert.rejects(ctx.service.createOrder("judge-cup", { mimeType: "image/png", data: "aW52YWxpZA==" }), /image/i);
  } finally { await ctx.close(); }
});

test("a failed image batch removes partial files and records and releases admission", async (context) => {
  const ctx = await setup();
  try {
    const beforeFiles = (await readdir(join(ctx.directory, "evidence"))).sort();
    const beforeImages = ctx.store.all("images");
    const claim = await ctx.service.createClaim(ctx.order.order.id, ctx.order.token, { message: "Synthetic batch rollback test." });
    const session = ctx.service.issueCapture(claim.id, ctx.order.token);
    const frames = await Promise.all(["#112233", "#223344", "#334455"].map(image));
    const originalPut = ctx.store.put.bind(ctx.store);
    let writes = 0;
    const put = context.mock.method(ctx.store, "put", (kind: string, id: string, value: unknown) => {
      if (kind === "images" && ++writes === 2) throw Error("Synthetic second image write failure");
      originalPut(kind, id, value);
    });
    await assert.rejects(ctx.service.submitCapture(claim.id, session.id, ctx.order.token, { orderId: session.orderId, nonce: session.nonce, frames }), /second image/);
    assert.deepEqual((await readdir(join(ctx.directory, "evidence"))).sort(), beforeFiles);
    assert.deepEqual(ctx.store.all("images"), beforeImages);
    put.mock.restore();
    const next = ctx.service.issueCapture(claim.id, ctx.order.token);
    await ctx.service.submitCapture(claim.id, next.id, ctx.order.token, { orderId: next.orderId, nonce: next.nonce, frames });
    await ctx.service.idle();
    assert.equal(ctx.store.all("images").length, beforeImages.length + 3);
  } finally { await ctx.close(); }
});

test("private-store capacity blocks unpaid photo admissions before provider writes", async () => {
  const ctx = await setup();
  try {
    const file = join(ctx.directory, "evidence", "capacity-test");
    await writeFile(file, "");
    await truncate(file, 512 * 1024 * 1024);
    const orders = ctx.store.all("orders").length, images = ctx.store.all("images").length;
    await assert.rejects(ctx.service.createOrder("judge-cup", ctx.original), /capacity|storage/i);
    assert.equal(ctx.store.all("orders").length, orders);
    assert.equal(ctx.store.all("images").length, images);
    assert.equal(ctx.payments.orders.size, 1, "Capacity must be checked before another provider operation");
  } finally { await ctx.close(); }
});

test("concurrent unpaid orders cannot overbook private-store capacity", async () => {
  const ctx = await setup();
  try {
    let used = 0;
    for (const directory of [ctx.directory, join(ctx.directory, "evidence")]) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isFile()) used += (await stat(join(directory, entry.name))).size;
      }
    }
    const file = join(ctx.directory, "evidence", "capacity-test");
    await writeFile(file, "");
    await truncate(file, 512 * 1024 * 1024 - used - 6 * 1024 * 1024);
    const original = Buffer.from(ctx.original.data, "base64");
    const large = { mimeType: "image/png" as const, data: Buffer.concat([original, Buffer.alloc(4 * 1024 * 1024 - original.length)]).toString("base64") };
    const results = await Promise.allSettled([ctx.service.createOrder("judge-cup", large), ctx.service.createOrder("judge-cup", large)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(ctx.payments.orders.size, 2);
    assert.equal(ctx.store.all("images").length, 2);
  } finally { await ctx.close(); }
});

test("storage capacity preserves existing evidence and seller refund reconciliation", async () => {
  const ctx = await setup();
  try {
    const claim = await ctx.service.createClaim(ctx.order.order.id, ctx.order.token, { message: "The physical cup arrived torn." });
    const file = join(ctx.directory, "evidence", "capacity-test");
    await writeFile(file, "");
    await truncate(file, 512 * 1024 * 1024);
    const existing = await ctx.service.readImage(ctx.service.getOrder(ctx.order.order.id, ctx.order.token).listingImageUrl.split("/").pop()!, ctx.order.token);
    assert.deepEqual(existing.bytes, Buffer.from(ctx.original.data, "base64"));
    const refund = await ctx.service.refundClaim(claim.id, 2500, "seller");
    assert.equal(refund.status, "refunded");
    assert.equal(ctx.payments.refundCalls.length, 1);
  } finally { await ctx.close(); }
});

test("concurrent orders respect the record bound even when existing orders are unpaid", async () => {
  const ctx = await setup();
  try {
    for (let index = 1; index < 4999; index++) ctx.store.put("orders", `unused-${index}`, { status: "failed" });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => ctx.service.createOrder("judge-cup", ctx.original)));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(ctx.store.all("orders").length, 5000);
    assert.equal(ctx.payments.orders.size, 2);
  } finally { await ctx.close(); }
});
test("duplicate claim submissions resume one case and upload above the line asks for capture", async () => {
  const ctx = await setup();
  try {
    const claim = await ctx.service.createClaim(ctx.order.order.id, ctx.order.token, { message: "The cup arrived torn.", image: await image("#eeddcc") });
    const duplicate = await ctx.service.createClaim(ctx.order.order.id, ctx.order.token, { message: "Same claim." });
    assert.equal(duplicate.id, claim.id);
    assert.equal(claim.status, "awaiting_live");
    assert.equal(ctx.payments.refundCalls.length, 0);
    assert.throws(() => ctx.service.getClaim(claim.id, "wrong"), /access/i);
  } finally { await ctx.close(); }
});
test("live judge evidence reviews and refunds once through the policy gate", async () => {
  const ctx = await setup();
  try {
    const claim = await ctx.service.createClaim(ctx.order.order.id, ctx.order.token, { message: "The cup is torn." });
    const session = ctx.service.issueCapture(claim.id, ctx.order.token);
    const frames = await Promise.all(["#aabbcc", "#bbccdd", "#ccddee"].map(image));
    await ctx.service.submitCapture(claim.id, session.id, ctx.order.token, { orderId: session.orderId, nonce: session.nonce, frames, cameraLabel: "Back Camera" });
    await ctx.service.idle();
    const result = ctx.service.getClaim(claim.id, ctx.order.token);
    assert.equal(result.status, "refunded");
    assert.equal(result.refund?.amountCents, 2500);
    assert.equal(result.refund?.id, "TEST-REFUND-1");
    await assert.rejects(ctx.service.submitCapture(claim.id, session.id, ctx.order.token, { orderId: session.orderId, nonce: session.nonce, frames }), /session|already|complete/i);
    assert.equal(ctx.payments.refunds.size, 1);
  } finally { await ctx.close(); }
});
test("live camera labels persist and hold without skipping reviews, then allow a physical-camera retry", async (context) => {
  const ctx = await setup();
  const reviews = ["test/a", "test/b"].map((model) => ({ model, returnedModel: model, ok: true, durationMs: 1 }));
  const review = context.mock.method(ctx.service.reviewer, "review", async () => ({
    clear: true, checks: [{ id: "damage", label: "Visible damage", status: "pass" as const, detail: "Synthetic test reviewer." }], reviews,
  }));
  try {
    const claim = await ctx.service.createClaim(ctx.order.order.id, ctx.order.token, { message: "The cup is torn." });
    const frames = await Promise.all(["#aabbcc", "#bbccdd", "#ccddee"].map(image));
    for (const [index, cameraLabel] of [undefined, "OBS Virtual Camera", "Back Camera"].entries()) {
      const session = ctx.service.issueCapture(claim.id, ctx.order.token);
      await ctx.service.submitCapture(claim.id, session.id, ctx.order.token, {
        orderId: session.orderId, nonce: session.nonce, frames, cameraLabel,
      });
      await ctx.service.idle();
      const result = ctx.service.getClaim(claim.id, undefined, true);
      assert.equal(review.mock.callCount(), index + 1);
      assert.equal(result.status, index < 2 ? "held" : "refunded");
      assert.equal(result.cameraLabel, cameraLabel);
      assert.equal(ctx.store.get<{ cameraLabel?: string }>("claims", claim.id)!.cameraLabel, cameraLabel);
      assert.deepEqual(result.reviews, reviews);
      assert.ok(result.checks.some(check => check.id === "damage" && check.status === "pass"));
      assert.deepEqual(result.checks.filter(check => check.id === "camera"), [{
        id: "camera", label: "Camera source", status: index < 2 ? "hold" : "pass",
        detail: "Browser-reported camera name. A modified page can lie about this.",
      }]);
      assert.equal(ctx.payments.refundCalls.length, index < 2 ? 0 : 1);
      if (index < 2) assert.equal(result.reason, "The camera source needs seller review.");
    }
  } finally { await ctx.close(); }
});
test("seller refunds reject invalid balances and overlapping requests share one operation", async () => {
  const ctx = await setup();
  try {
    const claim = await ctx.service.createClaim(ctx.order.order.id, ctx.order.token, { message: "Please take a look.", help: true });
    await assert.rejects(ctx.service.refundClaim(claim.id, 2501, "seller"), /refundable|more than/i);
    await assert.rejects(ctx.service.refundClaim(claim.id, 1.5, "seller"), /amount|whole/i);
    await Promise.all([ctx.service.refundClaim(claim.id, 2500, "seller"), ctx.service.refundClaim(claim.id, 2500, "seller")]);
    assert.equal(ctx.payments.refunds.size, 1);
    assert.equal(ctx.payments.refundCalls.length, 1);
  } finally { await ctx.close(); }
});
test("accepted-but-timed-out refund is reconciled across a service restart", async () => {
  const ctx = await setup();
  try {
    const claim = await ctx.service.createClaim(ctx.order.order.id, ctx.order.token, { message: "Please review.", help: true });
    ctx.payments.timeoutOnce = true;
    const pending = await ctx.service.refundClaim(claim.id, 2500, "seller");
    assert.equal(pending.status, "refund_pending");
    const key = pending.refund!.requestId;
    const restarted = new AppService(ctx.options);
    ctx.advance(61_000);
    await restarted.refreshClaim(claim.id, ctx.order.token);
    const result = restarted.getClaim(claim.id, ctx.order.token);
    assert.equal(result.status, "refunded");
    assert.equal(result.refund?.requestId, key);
    assert.equal(ctx.payments.refunds.size, 1);
    assert.equal(ctx.payments.refundCalls.length, 1);
    await restarted.idle();
  } finally { await ctx.close(); }
});
test("provider polling coalesces requests and respects the one-minute interval", async () => {
  const ctx = await setup();
  try {
    const claim = await ctx.service.createClaim(ctx.order.order.id, ctx.order.token, { message: "Please review.", help: true });
    const before = ctx.payments.reads;
    await Promise.all([ctx.service.refreshClaim(claim.id, ctx.order.token), ctx.service.refreshClaim(claim.id, ctx.order.token)]);
    const once = ctx.payments.reads;
    assert.equal(once - before, 1);
    await ctx.service.refreshClaim(claim.id, ctx.order.token);
    assert.equal(ctx.payments.reads, once);
    ctx.advance(60_000);
    await ctx.service.refreshClaim(claim.id, ctx.order.token);
    assert.equal(ctx.payments.reads, once + 1);
  } finally { await ctx.close(); }
});

test("capture audit records receipt time before potentially slow provenance processing", async () => {
  const ctx = await setup();
  try {
    const service = new AppService({ ...ctx.options, readCredentials: async () => {
      ctx.advance(121_000);
      return { status: "missing", generated: false };
    } });
    const claim = await service.createClaim(ctx.order.order.id, ctx.order.token, { message: "Synthetic delayed provenance test." });
    const session = service.issueCapture(claim.id, ctx.order.token);
    await service.submitCapture(claim.id, session.id, ctx.order.token, {
      orderId: session.orderId, nonce: session.nonce,
      frames: await Promise.all(["#102030", "#203040", "#304050"].map(image)),
    });
    await service.idle();
    const stored = ctx.store.get<{ captureSession: { receivedAt: number } }>("claims", claim.id)!;
    assert.equal(stored.captureSession.receivedAt, session.issuedAt);
    assert.ok(stored.captureSession.receivedAt < session.expiresAt);
  } finally { await ctx.close(); }
});

test("exhausted daily review budget holds evidence without calling reviewers or refunds", async () => {
  const ctx = await setup();
  let reviews = 0;
  try {
    const service = new AppService({ ...ctx.options, dailyBudget: 0, reviewer: {
      ...reviewer, async review(input) { reviews++; return reviewer.review(input); },
    } });
    const claim = await service.createClaim(ctx.order.order.id, ctx.order.token, { message: "Synthetic exhausted-budget test." });
    const session = service.issueCapture(claim.id, ctx.order.token);
    await service.submitCapture(claim.id, session.id, ctx.order.token, {
      orderId: session.orderId, nonce: session.nonce,
      frames: await Promise.all(["#405060", "#506070", "#607080"].map(image)),
    });
    await service.idle();
    const result = service.getClaim(claim.id, ctx.order.token);
    assert.equal(result.status, "held");
    assert.match(result.reason, /budget/i);
    assert.equal(reviews, 0);
    assert.equal(ctx.payments.refundCalls.length, 0);
  } finally { await ctx.close(); }
});

test("overlapping capture submissions cannot replace each other's review evidence", async () => {
  const ctx = await setup();
  try {
    const claim = await ctx.service.createClaim(ctx.order.order.id, ctx.order.token, { message: "The cup is torn." });
    const a = ctx.service.issueCapture(claim.id, ctx.order.token), b = ctx.service.issueCapture(claim.id, ctx.order.token);
    const frames = await Promise.all(["#112233", "#223344", "#334455"].map(image));
    const results = await Promise.allSettled([a, b].map((session) =>
      ctx.service.submitCapture(claim.id, session.id, ctx.order.token, { orderId: session.orderId, nonce: session.nonce, frames, cameraLabel: "Back Camera" })));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    await ctx.service.idle();
    assert.equal(ctx.payments.refunds.size, 1);
  } finally { await ctx.close(); }
});

test("camera-help fallback updates an existing claim rather than opening another case", async () => {
  const ctx = await setup();
  try {
    const claim = await ctx.service.createClaim(ctx.order.order.id, ctx.order.token, { message: "The cup is torn." });
    assert.equal(claim.status, "awaiting_live");
    const held = await ctx.service.createClaim(ctx.order.order.id, ctx.order.token, { message: "I cannot use my camera.", help: true });
    assert.equal(held.id, claim.id);
    assert.equal(held.status, "held");
    assert.equal(ctx.payments.refunds.size, 0);
  } finally { await ctx.close(); }
});

test("private evidence is inaccessible to another buyer and expires after closure", async () => {
  const ctx = await setup();
  try {
    const claim = await ctx.service.createClaim(ctx.order.order.id, ctx.order.token, { message: "Please review.", help: true, image: await image("#8899aa") });
    await assert.rejects(ctx.service.readImage(claim.evidence[0].id, "wrong"), /access/i);
    const original = await ctx.service.readImage(claim.evidence[0].id, ctx.order.token);
    assert.equal(original.mimeType, "image/png");
    await ctx.service.refundClaim(claim.id, 2500, "seller");
    ctx.advance(30 * 24 * 60 * 60_000 - 1);
    assert.equal(await ctx.service.cleanup(), 0);
    ctx.advance(1);
    assert.equal(await ctx.service.cleanup(), 2);
    await assert.rejects(ctx.service.readImage(claim.evidence[0].id, ctx.order.token), /not found/i);
  } finally { await ctx.close(); }
});

test("a buyer can add an upload to an open case without duplicating it on retry", async () => {
  const ctx = await setup();
  try {
    const claim = await ctx.service.createClaim(ctx.order.order.id, ctx.order.token, { message: "The cup is torn." });
    const upload = await image("#998877");
    const updated = await ctx.service.createClaim(ctx.order.order.id, ctx.order.token, { message: "Here is the damage.", image: upload });
    assert.equal(updated.id, claim.id);
    assert.equal(updated.evidence.length, 1);
    const repeated = await ctx.service.createClaim(ctx.order.order.id, ctx.order.token, { message: "Here is the damage.", image: upload });
    assert.equal(repeated.evidence[0].id, updated.evidence[0].id);
    assert.equal(ctx.payments.refunds.size, 0);
  } finally { await ctx.close(); }
});
