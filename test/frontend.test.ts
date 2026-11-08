import test from "node:test";
import assert from "node:assert/strict";
import type { ClaimView } from "../lib/app-types.js";
import { api, ApiError, buyerToken, originalImage, receiveCapability, rememberToken } from "../src/api.js";
import { capturePath, claimLabel, confirmedRefund, dateTime, isActiveClaim, money, pollDelay, refundableBalance, refundAmount, syncIsStale } from "../src/domain.js";

const result = (status: ClaimView["status"], refund: ClaimView["refund"]) => ({ status, refund });
const pending = { status: "pending" as const, amountCents: 2500, requestId: "stable-request" };
const completed = { ...pending, status: "completed" as const, id: "SANDBOX-REFUND" };

test("frontend only labels a provider-confirmed refund with an identifier as complete", () => {
  assert.equal(confirmedRefund(result("refund_pending", pending)), false);
  assert.equal(confirmedRefund(result("refunded", pending)), false);
  assert.equal(confirmedRefund(result("refunded", { ...completed, id: undefined })), false);
  assert.equal(confirmedRefund(result("refunded", null)), false);
  assert.equal(confirmedRefund(result("held", completed)), false);
  assert.equal(confirmedRefund(result("refunded", completed)), true);
  assert.equal(claimLabel(result("refunded", pending)), "Checking refund confirmation");
  assert.equal(claimLabel(result("held", null)), "With the seller");
});

test("frontend whole-cent validation rejects malformed and over-balance refund amounts", () => {
  for (const value of ["", "-1", "0", "0.00", "1e2", "Infinity", "1.001", "1.", "$2.00", "25.01", "999999999999999999999"]) {
    assert.equal(refundAmount(value, 2500), null, value);
  }
  assert.equal(refundAmount("25.00", 2500), 2500);
  assert.equal(refundAmount("0.01", 2500), 1);
  assert.equal(refundAmount(" 12.4 ", 2500), 1240);
  assert.equal(refundAmount("1", 0), null);
  assert.equal(refundableBalance({ amountCents: 2500, refundedCents: 500 }), 2000);
  assert.equal(refundableBalance({ amountCents: 2500, refundedCents: 2600 }), 0);
});

test("frontend live handoff puts the capability only in the fragment", () => {
  const url = new URL(capturePath("case/a?b", "private+token/value="), "https://shop.example");
  assert.equal(url.pathname, "/capture");
  assert.equal(url.searchParams.get("claim"), "case/a?b");
  assert.equal(url.searchParams.has("token"), false);
  assert.equal(new URLSearchParams(url.hash.slice(1)).get("token"), "private+token/value=");
  assert.equal(url.search.includes("private"), false);
});

test("frontend polls open seller-help, review, handoff, and payment states but stops completed refunds", () => {
  for (const status of ["draft", "awaiting_live", "reviewing", "held", "refund_pending"] as const) assert.equal(isActiveClaim(status), true);
  assert.equal(isActiveClaim("refunded"), false);
  assert.equal(pollDelay(0), 3000);
  assert.equal(pollDelay(1), 6000);
  assert.equal(pollDelay(2), 12000);
  assert.equal(pollDelay(3), 24000);
  assert.equal(pollDelay(4), 30000);
  assert.equal(pollDelay(50), 30000);
});

test("frontend capability intake removes the fragment and scopes stored access per order and case", () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const stored = new Map<string, string>();
  let replaced = "";
  const fakeWindow = {
    location: { hash: "#token=only-this-order", pathname: "/claim/frontend-case", search: "?handoff=1" },
    history: { state: { test: true }, replaceState(_state: unknown, _title: string, url: string) { replaced = url; fakeWindow.location.hash = ""; } },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) } });
  try {
    assert.equal(receiveCapability("frontend-case"), "only-this-order");
    assert.equal(replaced, "/claim/frontend-case?handoff=1");
    assert.equal(buyerToken("frontend-other-case"), "");
    rememberToken("only-this-order", "frontend-case", "frontend-order");
    assert.equal(buyerToken("frontend-order"), "only-this-order");
    assert.equal(receiveCapability("frontend-case"), "only-this-order");
    assert.equal([...stored.keys()].some((key) => key.includes("frontend-other-case")), false);
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor); else Reflect.deleteProperty(globalThis, "window");
    if (storageDescriptor) Object.defineProperty(globalThis, "sessionStorage", storageDescriptor); else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("frontend API sends buyer capabilities in headers and seller cookies same-origin", async (context) => {
  let request: RequestInit | undefined;
  context.mock.method(globalThis, "fetch", async (path: string, options: RequestInit) => {
    assert.equal(path, "/api/claims/test/refresh");
    request = options;
    return new Response(JSON.stringify({ claim: { id: "test" } }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const value = await api<{ claim: { id: string } }>("/api/claims/test/refresh", { method: "POST", body: {}, token: "private-buyer-token" });
  assert.equal(value.claim.id, "test");
  assert.equal(new Headers(request!.headers).get("Authorization"), "Bearer private-buyer-token");
  assert.equal(new Headers(request!.headers).get("Content-Type"), "application/json");
  assert.equal(request!.body, "{}");
  assert.equal(request!.credentials, "same-origin");
  assert.equal(request!.cache, "no-store");
  assert.equal(request!.referrerPolicy, "no-referrer");
});

test("frontend API returns useful service errors without treating failure as success", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "This case needs seller access." }), { status: 403 }));
  await assert.rejects(api("/api/seller/claims"), (error: unknown) => error instanceof ApiError && error.status === 403 && error.message === "This case needs seller access.");
});

test("frontend handles non-JSON service failure without showing raw response bodies", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response("private proxy diagnostic", { status: 503 }));
  await assert.rejects(api("/api/config"), (error: unknown) => error instanceof ApiError && !error.message.includes("private") && error.status === 503);
});

test("frontend original-image preflight rejects unsupported and excessive files before reading", async () => {
  await assert.rejects(originalImage(new File(["x"], "photo.heic", { type: "image/heic" })), /JPEG or PNG/);
  await assert.rejects(originalImage(new File([], "photo.jpg", { type: "image/jpeg" })), /4 MB/);
  await assert.rejects(originalImage(new File([new Uint8Array(4 * 1024 * 1024 + 1)], "photo.jpg", { type: "image/jpeg" })), /4 MB/);
});

test("frontend amounts and unknown sync times are truthful", () => {
  assert.equal(money(1200), "$12.00");
  assert.equal(money(2500), "$25.00");
  assert.equal(money(3200), "$32.00");
  assert.equal(dateTime(null), "Not yet synced");
  assert.equal(dateTime("not-a-date"), "Time unavailable");
});

test("frontend treats missing, failed, and old provider syncs as stale", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  assert.equal(syncIsStale(null, null, now), true);
  assert.equal(syncIsStale("invalid", null, now), true);
  assert.equal(syncIsStale("2026-11-06T12:00:00Z", "Provider unavailable", now), true);
  assert.equal(syncIsStale("2026-11-06T11:58:29Z", null, now), true);
  assert.equal(syncIsStale("2026-11-06T11:59:00Z", null, now), false);
});
