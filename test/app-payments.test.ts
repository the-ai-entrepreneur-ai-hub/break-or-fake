import assert from "node:assert/strict";
import test from "node:test";
import { OrdersController, PaymentsController, ShipmentCarrier } from "@paypal/paypal-server-sdk";
import { makeSandboxPayments, paymentFacts } from "../lib/app-payments.js";

const amount = (value = "25.00") => ({ currencyCode: "USD", value });
function raw(status = "COMPLETED") {
  return { id: "QA-ORDER", status: "COMPLETED", payer: { payerId: "QA-PAYER" },
    purchaseUnits: [{ customId: "frozen-listing-hash", amount: amount(),
      payments: { captures: [{ id: "QA-CAPTURE", status, amount: amount() }], refunds: [] as unknown[] } }] };
}
test("payment facts preserve the binding, capture, amount, and payer", () => {
  const facts = paymentFacts(raw());
  assert.equal(facts.listingHash, "frozen-listing-hash");
  assert.equal(facts.captureId, "QA-CAPTURE");
  assert.equal(facts.amountCents, 2500);
  assert.equal(facts.payerId, "QA-PAYER");
});
test("payment facts reject unsupported currency, ambiguous captures, and malformed amounts", () => {
  const currency = raw(); currency.purchaseUnits[0].amount.currencyCode = "EUR";
  assert.throws(() => paymentFacts(currency));
  const multiple = raw(); multiple.purchaseUnits[0].payments.captures.push(multiple.purchaseUnits[0].payments.captures[0]);
  assert.throws(() => paymentFacts(multiple));
  const fractional = raw(); fractional.purchaseUnits[0].payments.captures[0].amount.value = "25.001";
  assert.throws(() => paymentFacts(fractional));
});
test("unknown partial balances hold, while completed and pending refunds reserve balance", () => {
  assert.throws(() => paymentFacts(raw("PARTIALLY_REFUNDED")), /unknown/);
  const order = raw("PARTIALLY_REFUNDED");
  order.purchaseUnits[0].payments.refunds = [
    { id: "R1", status: "COMPLETED", amount: amount("5.00") },
    { id: "R2", status: "PENDING", amount: amount("3.00") },
    { id: "R3", status: "FAILED", amount: amount("2.00") },
  ];
  assert.equal(paymentFacts(order).refundedCents, 800);
  order.purchaseUnits[0].payments.refunds.push({ id: "R4", status: "COMPLETED", amount: amount("20.00") });
  assert.throws(() => paymentFacts(order), /inconsistent/);
  assert.equal(paymentFacts(raw("REFUNDED")).refundedCents, 2500);
});
test("missing sandbox credentials refuse all payment writes before SDK calls", async () => {
  const provider = makeSandboxPayments("", "");
  assert.equal(provider.ready, false);
  assert.equal(provider.clientId, null);
  await assert.rejects(provider.createOrder({ title: "QA", amountCents: 2500, listingHash: "hash", requestId: "stable" }), /not configured/);
  await assert.rejects(provider.refund("capture", 2500, "stable"), /not configured/);
});
test("SDK checkout sends only the server price, binding, and stable operation keys", async (context) => {
  let create: unknown, capture: unknown;
  context.mock.method(OrdersController.prototype, "createOrder", async (input: unknown) => {
    create = input; return { result: { id: "QA-ORDER", status: "CREATED" } };
  });
  context.mock.method(OrdersController.prototype, "captureOrder", async (input: unknown) => {
    capture = input; return { result: raw() };
  });
  context.mock.method(OrdersController.prototype, "getOrder", async () => ({ result: raw() }));
  const provider = makeSandboxPayments("test-public-client", "not-a-real-secret");
  await provider.createOrder({ title: "QA cup", amountCents: 2500, listingHash: "hash", requestId: "stable-create" });
  const input = create as { paypalRequestId: string; body: { purchaseUnits: { customId: string; amount: unknown }[] } };
  assert.equal(input.paypalRequestId, "stable-create");
  assert.equal(input.body.purchaseUnits[0].customId, "hash");
  assert.deepEqual(input.body.purchaseUnits[0].amount, amount());
  assert.equal((await provider.captureOrder("QA-ORDER", "stable-capture")).captureId, "QA-CAPTURE");
  assert.equal((capture as { paypalRequestId: string }).paypalRequestId, "stable-capture");
});
test("SDK refund and tracking adapters preserve USD, idempotency, and honest carrier labels", async (context) => {
  let refund: unknown, tracking: unknown;
  context.mock.method(PaymentsController.prototype, "refundCapturedPayment", async (input: unknown) => {
    refund = input; return { result: { id: "QA-REFUND", status: "COMPLETED", amount: amount("5.00") } };
  });
  context.mock.method(PaymentsController.prototype, "getRefund", async () => ({ result: { id: "OTHER", status: "COMPLETED", amount: amount("5.00") } }));
  context.mock.method(OrdersController.prototype, "createOrderTracking", async (input: unknown) => {
    tracking = input; return { result: { purchaseUnits: [{ shipping: { trackers: [{ status: "SHIPPED" }] } }] } };
  });
  const provider = makeSandboxPayments("test-public-client", "not-a-real-secret");
  assert.equal((await provider.refund("QA-CAPTURE", 500, "stable-refund")).amountCents, 500);
  assert.deepEqual(refund, { captureId: "QA-CAPTURE", paypalRequestId: "stable-refund", prefer: "return=representation",
    body: { amount: amount("5.00"), noteToPayer: "Refund for the damaged item." } });
  await assert.rejects(provider.getRefund("QA-REFUND"), /different refund/);
  assert.equal(await provider.track!("QA-ORDER", "QA-CAPTURE"), "SHIPPED");
  assert.equal((tracking as { body: { carrier: string } }).body.carrier, ShipmentCarrier.Other);
  assert.equal((tracking as { body: { carrierNameOther: string } }).body.carrierNameOther, "Sandbox demo");
  assert.equal((tracking as { body: { notifyPayer: boolean } }).body.notifyPayer, false);
});
