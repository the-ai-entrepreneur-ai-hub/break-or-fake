import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ApiError,
  CheckoutPaymentIntent,
  OrdersController,
  OrderStatus,
  PaymentsController,
  PaypalExperienceUserAction,
  ShipmentCarrier,
} from "@paypal/paypal-server-sdk";
import { z } from "zod";
import { makePayPalClient, makePayPalRest } from "../lib/paypal.js";
import { gate, toCents } from "../lib/policy.js";
import { listingHash } from "../lib/listing.js";

// npm run sandbox                     order, buyer approval, capture, tracking, partial refund
// npm run sandbox -- --no-refund      the same without the refund, to leave an order to dispute
// npm run sandbox -- dispute [id]     list disputes, or one dispute's stage and allowed responses
// npm run sandbox -- offer <id>       offer a full refund with return at INQUIRY
// npm run sandbox -- ack-return <id>  acknowledge receipt of the returned item
// npm run sandbox -- accept <id>      accept the claim as the fallback refund

const SKIPPED_EXIT = 77;
const LOG_FILE = "sandbox-ids.jsonl";
const APPROVAL_WAIT_MS = 10 * 60_000;
const REFUND_CENTS = 1200;
const TRACKING_NUMBER = "9400111899223197428490";
const RETURN_SHIPPING_ADDRESS = { address_line_1: "123 Main Street", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" };
const moneySchema = z.object({ currency_code: z.string().length(3), value: z.string() });
const linksSchema = z.array(z.object({ href: z.string(), rel: z.string(), method: z.string().optional() })).default([]);
const disputeSchema = z.object({
  dispute_id: z.string(),
  create_time: z.string().optional(),
  status: z.string().optional(),
  dispute_life_cycle_stage: z.string().optional(),
  reason: z.string().optional(),
  allowed_response_options: z.unknown().optional(),
  links: linksSchema,
  dispute_amount: moneySchema.optional(),
  disputed_transactions: z.array(z.object({ gross_amount: moneySchema.optional(), transaction_status: z.string().optional() })).optional(),
  refund_details: z.object({ allowed_refund_amount: moneySchema.optional() }).optional(),
  offer: z.object({ seller_offered_amount: moneySchema.optional(), history: z.array(z.object({})).optional() }).optional(),
});

// The listing the buyer sees. Its hash goes into custom_id, so a later claim can prove which listing was bought.
const LISTING = { title: "White ceramic mug, 12 oz", price: "32.00", image: "mug-white-12oz.jpg" };

// Every sandbox object id goes to a local log with a timestamp, so real ids exist even if the sandbox misbehaves later.
function logIds(step: string, ids: Record<string, unknown>): void {
  const at = new Date().toISOString();
  appendFileSync(LOG_FILE, `${JSON.stringify({ at, step, ...ids })}\n`);
  const shown = Object.entries(ids).map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  console.log(`${at}  ${step.padEnd(16)} ${shown.join("  ")}`);
}

async function moneyPath(orders: OrdersController, payments: PaymentsController, refund: boolean): Promise<void> {
  const runId = randomUUID();
  const image = readFileSync(process.env.LISTING_IMAGE_PATH || `.notes/${LISTING.image}`);
  const hash = listingHash(image, LISTING.title, LISTING.price);

  const { result: created } = await orders.createOrder({
    body: {
      intent: CheckoutPaymentIntent.Capture,
      purchaseUnits: [{ amount: { currencyCode: "USD", value: LISTING.price }, customId: hash, description: LISTING.title }],
      paymentSource: {
        paypal: {
          experienceContext: {
            returnUrl: "https://example.com/approved",
            cancelUrl: "https://example.com/cancelled",
            userAction: PaypalExperienceUserAction.PayNow,
          },
        },
      },
    },
    paypalRequestId: `order_${runId}`,
    prefer: "return=representation",
  });
  const orderId = created.id;
  if (orderId === undefined) throw new Error("PayPal returned an order without an id");
  logIds("order created", { order_id: orderId, status: created.status, custom_id: hash });

  const approveUrl = created.links?.find((link) => link.rel === "payer-action" || link.rel === "approve")?.href;
  console.log(`\nApprove it in a browser, logged in as a sandbox personal account (not the business one):\n  ${approveUrl}\n`);

  const deadline = Date.now() + APPROVAL_WAIT_MS;
  for (let status = created.status; status !== OrderStatus.Approved; ) {
    if (Date.now() > deadline) throw new Error(`order ${orderId} was not approved within 10 minutes`);
    await sleep(3000);
    ({ status } = (await orders.getOrder({ id: orderId })).result);
  }
  logIds("order approved", { order_id: orderId });

  const { result: completed } = await orders.captureOrder({ id: orderId, paypalRequestId: `capture_${runId}`, prefer: "return=representation" });
  const capture = completed.purchaseUnits?.[0]?.payments?.captures?.[0];
  if (capture?.id === undefined || capture.amount === undefined) throw new Error(`order ${orderId} captured without a capture id`);
  logIds("order captured", { order_id: orderId, capture_id: capture.id, status: capture.status, amount: capture.amount.value });

  const { result: tracked } = await orders.createOrderTracking({
    id: orderId,
    body: { captureId: capture.id, trackingNumber: TRACKING_NUMBER, carrier: ShipmentCarrier.Usps, notifyPayer: false },
  });
  const tracker = tracked.purchaseUnits?.[0]?.shipping?.trackers?.[0];
  if (tracker?.id === undefined) throw new Error(`order ${orderId} returned without a tracker id`);
  logIds("tracking posted", { capture_id: capture.id, tracking_number: TRACKING_NUMBER, tracker_id: tracker.id, status: tracker.status });

  if (!refund) {
    console.log(`\nLeft unrefunded. Open a "not as described" dispute on order ${orderId} from the same sandbox personal account,`);
    console.log("then run: npm run sandbox -- dispute");
    return;
  }

  const claimId = `claim_${runId}`;
  // PayPal-Request-Id is the claim id, so a retried refund returns the first one instead of paying twice.
  const refundOnce = async () => {
    gate(
      { claimId, approvedBy: "seller", evidence: "upload" },
      { action: "refund", amountCents: REFUND_CENTS, capturedCents: toCents(capture.amount!.value), refundedCents: 0 },
    );
    return (
      await payments.refundCapturedPayment({
        captureId: capture.id as string,
        paypalRequestId: claimId,
        prefer: "return=representation",
        body: { amount: { currencyCode: "USD", value: (REFUND_CENTS / 100).toFixed(2) }, noteToPayer: "Partial refund for the damaged mug." },
      })
    ).result;
  };
  const refunded = await refundOnce();
  logIds("refund sent", { refund_id: refunded.id, status: refunded.status, paypal_request_id: claimId });
  const retried = await refundOnce();
  if (!refunded.id || retried.id !== refunded.id) throw new Error("refund retry did not return the original refund id");
  logIds("refund retried", { refund_id: retried.id, same_refund: retried.id === refunded.id });

  if (refunded.id === undefined) throw new Error("PayPal returned a refund without an id");
  const { result: readBack } = await payments.getRefund({ refundId: refunded.id });
  logIds("refund read", { refund_id: readBack.id, status: readBack.status, amount: readBack.amount?.value });
}

async function disputes(rest: NonNullable<ReturnType<typeof makePayPalRest>>, disputeId: string | undefined, command: "dispute" | "offer" | "ack-return" | "accept"): Promise<void> {
  if (disputeId === undefined) {
    if (command !== "dispute") throw new Error(`${command} requires a dispute id`);
    const listed = z.object({ items: z.array(disputeSchema).default([]), links: linksSchema }).parse(await rest("/v1/customer/disputes?page_size=10"));
    if (listed.items.length === 0) console.log("no disputes yet; they can take a few minutes to show up after the buyer opens one");
    logIds("disputes listed", { links: listed.links });
    for (const item of listed.items) {
      logIds("dispute listed", { dispute_id: item.dispute_id, create_time: item.create_time, status: item.status, stage: item.dispute_life_cycle_stage, reason: item.reason, links: item.links });
    }
    return;
  }
  if (!/^[A-Za-z0-9-]{1,255}$/.test(disputeId)) throw new Error("invalid dispute id");
  const path = `/v1/customer/disputes/${disputeId}` as const;
  const dispute = disputeSchema.parse(await rest(path));
  if (dispute.dispute_id !== disputeId) throw new Error("PayPal returned a different dispute id");
  logIds("dispute read", {
    dispute_id: dispute.dispute_id,
    status: dispute.status,
    stage: dispute.dispute_life_cycle_stage,
    reason: dispute.reason,
    allowed_response_options: dispute.allowed_response_options ?? null,
    links: dispute.links,
  });
  if (command === "dispute") return;

  const sellerOffer = dispute.offer?.seller_offered_amount;
  if (command === "ack-return" && sellerOffer === undefined) throw new Error("ack-return requires a seller offer");
  const amount = moneySchema.parse(command === "ack-return" ? sellerOffer : dispute.dispute_amount);
  const allowed = dispute.refund_details?.allowed_refund_amount;
  const transaction = dispute.disputed_transactions?.[0];
  if (allowed === undefined && transaction?.transaction_status !== "COMPLETED") throw new Error("missing allowed_refund_amount requires a COMPLETED transaction");
  const gross = moneySchema.parse(transaction?.gross_amount ?? allowed);
  if (gross.currency_code !== amount.currency_code || (allowed && allowed.currency_code !== amount.currency_code)) throw new Error("dispute balance currency mismatch");
  const capturedCents = toCents(gross.value);
  // A COMPLETED transaction permits the gross fallback when no refund allowance is supplied.
  const refundedCents = allowed ? capturedCents - toCents(allowed.value) : 0;
  gate(
    { claimId: `dispute_${disputeId}`, approvedBy: "seller", evidence: "upload" },
    { action: command === "offer" ? "make_offer" : command === "ack-return" ? "acknowledge_return" : "accept_claim", amountCents: toCents(amount.value), capturedCents, refundedCents, disputeStage: dispute.dispute_life_cycle_stage },
  );
  let endpoint: string;
  let body: Record<string, unknown>;
  let requestId: string | undefined;
  if (command === "ack-return") {
    // Acknowledging the return can release the offered refund.
    endpoint = "acknowledge-return-item";
    body = { acknowledgement_type: "ITEM_RECEIVED", note: "Returned item received." };
  } else if (command === "offer") {
    endpoint = "make-offer";
    body = { offer_type: "REFUND_WITH_RETURN", offer_amount: amount, return_shipping_address_info: { address: RETURN_SHIPPING_ADDRESS }, note: "Full refund after the damaged item is returned." };
    // Keep one attempt per offer round.
    requestId = `offer_${disputeId}_${dispute.offer?.history?.length ?? 0}`;
  } else {
    endpoint = "accept-claim";
    body = { accept_claim_type: "REFUND", note: "Full refund for the damaged item." };
    requestId = `accept_${disputeId}`;
  }
  const response = z.object({ links: linksSchema }).parse(await rest(`${path}/${endpoint}`, body, requestId));
  logIds(`dispute ${command}`, { dispute_id: disputeId, links: response.links, ...(requestId ? { paypal_request_id: requestId } : {}) });
}

async function main(argv: string[]): Promise<number> {
  const client = makePayPalClient();
  const rest = makePayPalRest();
  if (client === null || rest === null) {
    console.log("sandbox run skipped: sandbox credentials are unset, so no PayPal call was made");
    return SKIPPED_EXIT;
  }
  try {
    const command = argv[0];
    if (command === "dispute" || command === "offer" || command === "ack-return" || command === "accept") await disputes(rest, argv[1], command);
    else if (command === undefined || command === "--no-refund") await moneyPath(new OrdersController(client), new PaymentsController(client), !argv.includes("--no-refund"));
    else throw new Error(`unknown sandbox command ${command}`);
    return 0;
  } catch (error) {
    if (error instanceof ApiError) {
      console.error(`\nPayPal answered ${error.statusCode}: ${typeof error.body === "string" ? error.body : JSON.stringify(error.result)}`);
    } else {
      console.error(`\nrun failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    }
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
