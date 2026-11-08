import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppStore } from "../lib/app-store.js";
import { AppService } from "../lib/app-service.js";
import { makeAppHandler } from "../lib/app-server.js";
import type { PaymentProvider } from "../lib/app-payments.js";
import type { StoredClaim, StoredImage, StoredOrder } from "../lib/app-records.js";
import { tokenDigest } from "../lib/app-security.js";
import { existsSync } from "node:fs";
import sharp from "sharp";
import { validateImage } from "../lib/app-images.js";

async function serve(sellerPassword = "a-long-test-seller-password") {
  const directory = await mkdtemp(join(tmpdir(), "refund-http-"));
  const store = new AppStore(directory);
  await writeFile(join(directory, "index.html"), "<!doctype html><html><head><title>QA</title></head><body></body></html>");
  let writes = 0;
  const unavailable = async (): Promise<never> => { writes++; throw new Error("Must not call provider"); };
  const payments: PaymentProvider = {
    ready: false, clientId: null, createOrder: unavailable, captureOrder: unavailable, refund: unavailable, getRefund: unavailable,
    async getOrder(id) {
      const order = store.all<StoredOrder>("orders").find((row) => row.paypalOrderId === id);
      if (!order) throw new Error("Unknown test order");
      return { orderId: id, status: "COMPLETED", captureId: order.captureId, amountCents: order.amountCents, currency: "USD", listingHash: order.listingHash, refundedCents: order.refundedCents, refunds: [] };
    },
  };
  const service = new AppService({ store, payments, reviewer: { ready: false, models: [], review: unavailable } });
  const server = createServer(makeAppHandler({ service, sellerPassword, sellerViewerPassword: "a-long-test-viewer-password", distDirectory: directory }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  const base = `http://127.0.0.1:${address.port}`;
  return { base, server, service, store, directory, writes: () => writes, async close() { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); await rm(directory, { recursive: true, force: true }); } };
}
test("health differs from readiness and configuration never invents payment access", async () => {
  const ctx = await serve();
  try {
    assert.equal((await fetch(`${ctx.base}/health`)).status, 200);
    assert.equal((await fetch(`${ctx.base}/ready`)).status, 503);
    const response = await fetch(`${ctx.base}/api/config`), config = await response.json();
    assert.equal(config.mode, "sandbox");
    assert.equal(config.paypalClientId, null);
    assert.equal(config.catalog.length, 3);
    for (const [index, file] of ["linen", "mug", "cup"].entries()) {
      const asset = `/assets/${file}.jpg`;
      const exists = existsSync(new URL(`../public${asset}`, import.meta.url)) || existsSync(new URL(`../dist${asset}`, import.meta.url));
      assert.equal(config.catalog[index].image, exists ? asset : "", "Missing owner photos must use neutral placeholders");
    }
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.equal(ctx.writes(), 0);
  } finally { await ctx.close(); }
});
test("HTML gives PayPal a fresh CSP nonce without allowing arbitrary inline scripts", async () => {
  const ctx = await serve();
  try {
    const first = await fetch(`${ctx.base}/shop`), second = await fetch(`${ctx.base}/shop`);
    const policy = first.headers.get("content-security-policy")!;
    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
    assert.ok(nonce);
    assert.ok((await first.text()).includes(`name="csp-nonce" content="${nonce}"`));
    assert.notEqual(second.headers.get("content-security-policy"), policy);
    assert.equal(policy.split("script-src")[1].split(";")[0].includes("'unsafe-inline'"), false);
    assert.equal(first.headers.get("cross-origin-opener-policy"), "same-origin-allow-popups");
  } finally { await ctx.close(); }
});
test("the removed public sample endpoint does not expose claims", async () => {
  const ctx = await serve();
  try {
    assert.equal((await fetch(`${ctx.base}/api/demo/claims`)).status, 404);
    assert.equal(ctx.writes(), 0);
  } finally { await ctx.close(); }
});
test("app camera labels are optional strings bounded at 200 characters in a strict request", async (context) => {
  const ctx = await serve();
  const submit = context.mock.method(ctx.service, "submitCapture", async () => ({}));
  try {
    const path = "/api/claims/00000000-0000-0000-0000-000000000001/capture-sessions/00000000-0000-0000-0000-000000000002/frames";
    const body = { orderId: "test-order", nonce: "test-nonce", frames: ["YQ==", "Yg==", "Yw=="].map(data => ({ mimeType: "image/png", data })) };
    for (const metadata of [{}, { cameraLabel: "" }, { cameraLabel: "x".repeat(200) }]) {
      const response = await fetch(ctx.base + path, {
        method: "POST", headers: { origin: ctx.base, "content-type": "application/json" },
        body: JSON.stringify({ ...body, ...metadata }),
      });
      assert.equal(response.status, 201);
    }
    assert.equal(submit.mock.callCount(), 3);
    for (const metadata of [{ cameraLabel: "x".repeat(201) }, { cameraLabel: 1 }, { cameraLabel: null }, { cameraLabel: "Back Camera", unknown: true }]) {
      const response = await fetch(ctx.base + path, {
        method: "POST", headers: { origin: ctx.base, "content-type": "application/json" },
        body: JSON.stringify({ ...body, ...metadata }),
      });
      assert.equal(response.status, 400);
    }
    assert.equal(submit.mock.callCount(), 3);
    assert.equal(ctx.writes(), 0);
  } finally { await ctx.close(); }
});
test("seller queue and refund writes require authentication and same origin", async () => {
  const ctx = await serve();
  try {
    assert.equal((await fetch(`${ctx.base}/api/seller/claims`)).status, 401);
    assert.equal((await fetch(`${ctx.base}/api/seller/claims/unknown/refund`, { method: "POST", headers: { origin: ctx.base, "content-type": "application/json" }, body: '{"amountCents":2500}' })).status, 401);
    const evil = await fetch(`${ctx.base}/api/seller/login`, { method: "POST", headers: { origin: "https://not-this-shop.example", "content-type": "application/json" }, body: '{"password":"a-long-test-seller-password"}' });
    assert.equal(evil.status, 403);
    const login = await fetch(`${ctx.base}/api/seller/login`, { method: "POST", headers: { origin: ctx.base, "content-type": "application/json" }, body: '{"password":"a-long-test-seller-password"}' });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, /a-long-test/);
    const actual = await fetch(`${ctx.base}/api/seller/claims`, { headers: { cookie: cookie.split(";")[0] } });
    assert.equal(actual.status, 200);
    assert.deepEqual(await actual.json(), { claims: [] });
    const session = await (await fetch(`${ctx.base}/api/seller/session`, { headers: { cookie: cookie.split(";")[0] } })).json();
    assert.equal(session.role, "seller");
    assert.equal(session.canRefund, true);
    assert.equal(ctx.writes(), 0);
  } finally { await ctx.close(); }
});

test("a viewer can read private cases and evidence and refresh, but refund POST is forbidden", async () => {
  const ctx = await serve();
  try {
    const orderId = "00000000-0000-0000-0000-000000000001";
    const claimId = "00000000-0000-0000-0000-000000000002";
    const imageId = "00000000-0000-0000-0000-000000000003";
    const at = new Date().toISOString(), original = Buffer.from("private original test bytes");
    ctx.store.put("orders", orderId, {
      id: orderId, tokenHash: tokenDigest("buyer-only"), productId: "judge-cup", title: "Test cup", amountCents: 2500,
      listingHash: "a".repeat(64), listingImageId: imageId, isJudge: true, createdAt: at, status: "captured",
      paypalOrderId: "TEST-ORDER", captureId: "TEST-CAPTURE", refundedCents: 0, tracking: null,
      simulatedDelivery: true, claimId,
    } satisfies StoredOrder);
    ctx.store.put("images", imageId, {
      id: imageId, orderId, mimeType: "image/png", sha256: "b".repeat(64), createdAt: at,
      label: "Original damage evidence", credentials: { status: "missing", generated: false },
    } satisfies StoredImage);
    await writeFile(join(ctx.directory, "evidence", imageId), original);
    ctx.store.put("claims", claimId, {
      id: claimId, orderId, status: "held", createdAt: at, updatedAt: at, message: "Arrived torn.", amountCents: 2500,
      evidenceKind: "upload", imageIds: [imageId], reason: "Seller review.", checks: [], timeline: [], reviews: [],
      approvedBy: null, refund: null, lastSyncedAt: at, lastSyncAttempt: 0, syncError: null, reviewAttempt: 0,
    } satisfies StoredClaim);
    for (const path of [`/api/claims/${claimId}`, `/api/orders/${orderId}`, `/api/evidence/${imageId}`]) {
      assert.equal((await fetch(ctx.base + path)).status, 403);
    }
    const post = (path: string, body: unknown, cookie = "") => fetch(ctx.base + path, {
      method: "POST", headers: { origin: ctx.base, "content-type": "application/json", cookie }, body: JSON.stringify(body),
    });
    const login = await post("/api/seller/login", { password: "a-long-test-viewer-password" });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0], headers = { cookie };
    const session = await (await fetch(`${ctx.base}/api/seller/session`, { headers })).json();
    assert.equal(session.role, "viewer");
    assert.equal(session.authenticated, true);
    assert.equal(session.canRefund, false);
    const queue = await (await fetch(`${ctx.base}/api/seller/claims`, { headers })).json();
    assert.equal(queue.claims.length, 1);
    assert.equal(queue.claims[0].canRefund, false);
    const opened = await (await fetch(`${ctx.base}/api/claims/${claimId}`, { headers })).json();
    assert.equal(opened.claim.message, "Arrived torn.");
    assert.equal(opened.claim.canRefund, false);
    assert.equal((await fetch(`${ctx.base}/api/orders/${orderId}`, { headers })).status, 200);
    const evidence = await fetch(`${ctx.base}/api/evidence/${imageId}`, { headers });
    assert.equal(evidence.status, 200);
    assert.equal(evidence.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await evidence.arrayBuffer()), original);
    const refreshed = await post(`/api/claims/${claimId}/refresh`, {}, cookie);
    assert.equal(refreshed.status, 200);
    const refreshedClaim = (await refreshed.json()).claim;
    assert.equal(refreshedClaim.canRefund, false);
    assert.equal(refreshedClaim.syncError, null);
    assert.ok(refreshedClaim.lastSyncedAt);
    assert.equal(ctx.writes(), 0);
    const callsBeforeRefund = ctx.writes();
    assert.equal((await post(`/api/seller/claims/${claimId}/refund`, { amountCents: 2500 }, cookie)).status, 403);
    assert.equal(ctx.writes(), callsBeforeRefund);
    assert.equal(ctx.store.get<StoredClaim>("claims", claimId)!.refund, null);
    assert.equal((await post("/api/seller/logout", {}, cookie)).status, 200);
    assert.equal((await fetch(`${ctx.base}/api/seller/claims`, { headers })).status, 401);
    assert.equal((await fetch(`${ctx.base}/api/evidence/${imageId}`, { headers })).status, 403);
  } finally { await ctx.close(); }
});

test("successful role changes revoke the previous cookie; viewer-only access does not enable readiness", async () => {
  const ctx = await serve();
  const viewerOnly = await serve("");
  try {
    const login = (password: string, cookie = "") => fetch(`${ctx.base}/api/seller/login`, {
      method: "POST", headers: { origin: ctx.base, "content-type": "application/json", cookie }, body: JSON.stringify({ password }),
    });
    const seller = await login("a-long-test-seller-password");
    const sellerCookie = seller.headers.get("set-cookie")!.split(";")[0];
    const viewer = await login("a-long-test-viewer-password", sellerCookie);
    assert.equal(viewer.status, 200);
    const viewerCookie = viewer.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await fetch(`${ctx.base}/api/seller/claims`, { headers: { cookie: sellerCookie } })).status, 401);
    assert.equal((await (await fetch(`${ctx.base}/api/seller/session`, { headers: { cookie: viewerCookie } })).json()).canRefund, false);
    const ownerAgain = await login("a-long-test-seller-password", viewerCookie);
    assert.equal(ownerAgain.status, 200);
    assert.equal((await fetch(`${ctx.base}/api/seller/claims`, { headers: { cookie: viewerCookie } })).status, 401);
    const ownerCookie = ownerAgain.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await (await fetch(`${ctx.base}/api/seller/session`, { headers: { cookie: ownerCookie } })).json()).canRefund, true);
    const readiness = await (await fetch(`${viewerOnly.base}/ready`)).json();
    assert.equal(readiness.services.seller, false);
    assert.equal((await (await fetch(`${viewerOnly.base}/api/seller/session`)).json()).configured, true);
  } finally { await ctx.close(); await viewerOnly.close(); }
});
test("mutation validation refuses missing origins, arbitrary approval fields, and unsupported content types", async () => {
  const ctx = await serve();
  try {
    assert.equal((await fetch(`${ctx.base}/api/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"productId":"judge-cup"}' })).status, 403);
    assert.equal((await fetch(`${ctx.base}/api/orders`, { method: "POST", headers: { origin: ctx.base, "content-type": "text/plain" }, body: "{}" })).status, 415);
    const result = await fetch(`${ctx.base}/api/orders`, { method: "POST", headers: { origin: ctx.base, "content-type": "application/json" }, body: '{"productId":"judge-cup","approvedBy":"policy","priceCents":1}' });
    assert.equal(result.status, 400);
    assert.equal(ctx.writes(), 0);
  } finally { await ctx.close(); }
});

test("in-flight mutations are bounded before reading more large request bodies", async () => {
  const ctx = await serve();
  const pending: ReturnType<typeof httpRequest>[] = [];
  try {
    for (let index = 0; index < 8; index++) {
      const received = new Promise<void>((resolve) => ctx.server.once("request", () => resolve()));
      const request = httpRequest(`${ctx.base}/api/orders`, {
        method: "POST", headers: { origin: ctx.base, "content-type": "application/json" },
      });
      request.on("error", () => {});
      request.write("{"); pending.push(request);
      await received;
    }
    const ninth = await fetch(`${ctx.base}/api/seller/login`, {
      method: "POST", headers: { origin: ctx.base, "content-type": "application/json" },
      body: '{"password":"a-long-test-seller-password"}',
    });
    assert.equal(ninth.status, 429);
    assert.equal(ctx.writes(), 0);
  } finally { pending.forEach((request) => request.destroy()); await ctx.close(); }
});

test("slow original downloads stay bounded until the response drains or closes", async (context) => {
  const ctx = await serve(), pending: ReturnType<typeof httpRequest>[] = [];
  const original = Buffer.alloc(4 * 1024 * 1024, 42);
  let reads = 0;
  context.mock.method(ctx.service, "readImage", async () => {
    reads++;
    return { mimeType: "image/png", bytes: Buffer.from(original) };
  });
  const path = "/api/evidence/00000000-0000-0000-0000-000000000003";
  const closed: Promise<void>[] = [], finish: (() => void)[] = [];
  let transfers = 0;
  ctx.server.on("request", (request, response) => {
    if (request.url !== path) return;
    closed.push(new Promise(resolve => response.once("close", resolve)));
    if (++transfers > 8) return;
    // Hold responses explicitly: Linux loopback can buffer a whole 4 MiB download.
    const end = response.end.bind(response);
    context.mock.method(response, "end", (...args: Parameters<typeof response.end>) => {
      finish.push(() => end(...args));
      return response;
    });
  });
  try {
    for (let index = 0; index < 8; index++) {
      await new Promise<void>((resolve, reject) => {
        ctx.server.once("request", () => resolve());
        const request = httpRequest(ctx.base + path, (response) => response.pause());
        request.on("error", reject); pending.push(request); request.end();
      });
    }
    const ninth = await fetch(ctx.base + path);
    assert.equal(ninth.status, 429);
    await ninth.text();
    assert.equal(reads, 8, "Reject before allocating another original buffer");
    assert.equal((await fetch(ctx.base + "/health")).status, 200);
    assert.equal(finish.length, 8);
    for (const request of pending) request.destroy();
    await Promise.all(closed);
    const response = await fetch(ctx.base + path);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
  } finally { for (const request of pending) request.destroy(); for (const end of finish) end(); await ctx.close(); }
});

test("failed original reads release transfer admission", async () => {
  const ctx = await serve();
  try {
    for (let index = 0; index < 12; index++) {
      const response = await fetch(ctx.base + "/api/evidence/00000000-0000-0000-0000-000000000003");
      assert.equal(response.status, 404);
      await response.text();
    }
  } finally { await ctx.close(); }
});

test("JSON scanning skips escaped quotes, backslashes, and structural punctuation inside strings", async () => {
  const ctx = await serve();
  try {
    for (const password of ["{}[]:,".repeat(70), String.raw`before \" after`, "\\".repeat(100) + '"', "é日本語" + "\\\\\""]) {
      const response = await fetch(ctx.base + "/api/seller/login", {
        method: "POST", headers: { origin: ctx.base, "content-type": "application/json" }, body: JSON.stringify({ password }),
      });
      assert.equal(response.status, 401, "Valid JSON must reach password validation");
      await response.text();
    }
  } finally { await ctx.close(); }
});

test("JSON structure boundaries reject 257 tokens and depth 17 before schema validation", async () => {
  const ctx = await serve();
  const send = async (body: string) => {
    const response = await fetch(ctx.base + "/api/orders", {
      method: "POST", headers: { origin: ctx.base, "content-type": "application/json" }, body,
    });
    assert.equal(response.status, 400);
    return (await response.json()).error as string;
  };
  try {
    assert.match(await send(JSON.stringify({ productId: "judge-cup", padding: Array(247).fill(0) })), /request fields/);
    assert.match(await send(JSON.stringify({ productId: "judge-cup", padding: Array(248).fill(0) })), /valid JSON/);
    assert.match(await send('{"padding":' + "[".repeat(15) + "0" + "]".repeat(15) + "}"), /request fields/);
    assert.match(await send('{"padding":' + "[".repeat(16) + "0" + "]".repeat(16) + "}"), /valid JSON/);
    assert.match(await send('{"productId":"unterminated\\\\\\"'), /valid JSON/);
    assert.equal(ctx.writes(), 0);
  } finally { await ctx.close(); }
});

test("three valid maximum-size original images reach normal capture lookup unchanged", async () => {
  const ctx = await serve();
  try {
    const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#abcdef" } }).png().toBuffer();
    const bytes = Buffer.alloc(4 * 1024 * 1024); png.copy(bytes);
    const image = { mimeType: "image/png" as const, data: bytes.toString("base64") };
    assert.deepEqual((await validateImage(image)).bytes, bytes);
    const body = JSON.stringify({ orderId: "test-order", nonce: 'punctuation []{}:, \\"', frames: [image, image, image] });
    assert.ok(Buffer.byteLength(body) < 17 * 1024 * 1024);
    const response = await fetch(ctx.base + "/api/claims/00000000-0000-0000-0000-000000000001/capture-sessions/00000000-0000-0000-0000-000000000002/frames", {
      method: "POST", headers: { origin: ctx.base, "content-type": "application/json" }, body,
    });
    assert.equal(response.status, 404, "The valid envelope must reach the missing-claim lookup");
    assert.equal(ctx.writes(), 0);
  } finally { await ctx.close(); }
});
