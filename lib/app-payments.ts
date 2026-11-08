import { Client, Environment, OrdersController, PaymentsController, CheckoutPaymentIntent, ShipmentCarrier } from "@paypal/paypal-server-sdk";
import { z } from "zod";
import { toCents } from "./policy.js";

export interface RefundFacts { id: string; status: string; amountCents: number; currency: string }
export interface PaymentFacts {
  orderId: string; status: string; amountCents: number; currency: string; listingHash: string;
  captureId?: string; payerId?: string; refundedCents: number; refunds: RefundFacts[];
  tracking?: string; deliveredAt?: string;
}
export interface PaymentProvider {
  ready: boolean; clientId: string | null;
  createOrder(input: { title: string; amountCents: number; listingHash: string; requestId: string }): Promise<{ id: string; status: string }>;
  captureOrder(orderId: string, requestId: string): Promise<PaymentFacts>;
  getOrder(orderId: string): Promise<PaymentFacts>;
  refund(captureId: string, amountCents: number, requestId: string): Promise<RefundFacts>;
  getRefund(refundId: string): Promise<RefundFacts>;
  track?(orderId: string, captureId: string): Promise<string>;
}
const money = z.object({ currencyCode: z.literal("USD"), value: z.string() });
const refundSchema = z.object({ id: z.string().min(1), status: z.string(), amount: money });
const factsSchema = z.object({
  id: z.string(), status: z.string(), payer: z.object({ payerId: z.string().optional() }).optional(),
  purchaseUnits: z.array(z.object({
    customId: z.string(), amount: money,
    payments: z.object({
      captures: z.array(z.object({ id: z.string(), status: z.string(), amount: money })).max(1).optional(),
      refunds: z.array(refundSchema).max(100).optional(),
    }).optional(),
    shipping: z.object({ trackers: z.array(z.object({ status: z.string().optional(), updateTime: z.string().optional() })).optional() }).optional(),
  })).length(1),
});
function refundFacts(raw: unknown): RefundFacts {
  const value = refundSchema.parse(raw);
  return { id: value.id, status: value.status, amountCents: toCents(value.amount.value), currency: "USD" };
}
export function paymentFacts(raw: unknown): PaymentFacts {
  const value = factsSchema.parse(raw), unit = value.purchaseUnits[0], capture = unit.payments?.captures?.[0];
  const refunds = (unit.payments?.refunds ?? []).map(refundFacts);
  const amountCents = toCents(capture?.amount.value ?? unit.amount.value);
  let refundedCents = refunds.filter((r) => ["COMPLETED", "PENDING"].includes(r.status)).reduce((sum, r) => sum + r.amountCents, 0);
  if (capture?.status === "REFUNDED") refundedCents = amountCents;
  if (capture?.status === "PARTIALLY_REFUNDED" && refundedCents === 0) throw new Error("The current refundable balance is unknown.");
  if (refundedCents > amountCents) throw new Error("The current refundable balance is inconsistent.");
  const tracker = unit.shipping?.trackers?.[0];
  return {
    orderId: value.id, status: capture?.status ?? value.status, amountCents, currency: "USD",
    listingHash: unit.customId, captureId: capture?.id, payerId: value.payer?.payerId,
    refundedCents, refunds, tracking: tracker?.status,
    deliveredAt: tracker?.status === "DELIVERED" ? tracker.updateTime : undefined,
  };
}

export function makeSandboxPayments(clientId: string, clientSecret: string): PaymentProvider {
  const ready = !!clientId.trim() && !!clientSecret.trim();
  const client = new Client({
    clientCredentialsAuthCredentials: { oAuthClientId: clientId || "unset", oAuthClientSecret: clientSecret || "unset" },
    environment: Environment.Sandbox, timeout: 30_000,
  });
  const orders = new OrdersController(client), payments = new PaymentsController(client);
  const requireReady = () => { if (!ready) throw new Error("Sandbox checkout is not configured."); };
  const getOrder = async (id: string) => {
    requireReady();
    const result = paymentFacts((await orders.getOrder({ id })).result);
    if (result.orderId !== id) throw new Error("PayPal returned a different order.");
    return result;
  };
  return {
    ready, clientId: ready ? clientId : null,
    async createOrder(input) {
      requireReady();
      const { result } = await orders.createOrder({
        paypalRequestId: input.requestId, prefer: "return=representation",
        body: { intent: CheckoutPaymentIntent.Capture, purchaseUnits: [{
          customId: input.listingHash, description: input.title,
          amount: { currencyCode: "USD", value: (input.amountCents / 100).toFixed(2) },
        }] },
      });
      if (!result.id) throw new Error("PayPal did not return an order identifier.");
      return { id: result.id, status: String(result.status ?? "CREATED") };
    },
    async captureOrder(id, requestId) {
      requireReady();
      await orders.captureOrder({ id, paypalRequestId: requestId, prefer: "return=representation" });
      return getOrder(id);
    },
    getOrder,
    async refund(captureId, amountCents, requestId) {
      requireReady();
      return refundFacts((await payments.refundCapturedPayment({
        captureId, paypalRequestId: requestId, prefer: "return=representation",
        body: { amount: { currencyCode: "USD", value: (amountCents / 100).toFixed(2) }, noteToPayer: "Refund for the damaged item." },
      })).result);
    },
    async getRefund(refundId) {
      requireReady();
      const result = refundFacts((await payments.getRefund({ refundId })).result);
      if (result.id !== refundId) throw new Error("PayPal returned a different refund.");
      return result;
    },
    async track(id, captureId) {
      requireReady();
      const { result } = await orders.createOrderTracking({
        id, body: { captureId, trackingNumber: `BOF-${captureId}`, carrier: ShipmentCarrier.Other, carrierNameOther: "Sandbox demo", notifyPayer: false },
      });
      return String(result.purchaseUnits?.[0]?.shipping?.trackers?.[0]?.status ?? "UNKNOWN");
    },
  };
}
