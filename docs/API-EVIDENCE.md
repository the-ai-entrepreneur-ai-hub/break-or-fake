# PayPal API and evidence map

This map identifies implemented calls and their local tests. It is not a claim
that an external transaction occurred. All configured payment clients use the
PayPal sandbox. Never put credentials or private claim links in this document.

## Web purchase and refund

| Step | PayPal interface | Implementation and local evidence |
| --- | --- | --- |
| Buyer approval | PayPal JavaScript SDK Buttons | [`src/PayPalCheckout.tsx`](../src/PayPalCheckout.tsx). The buyer must approve manually in a real sandbox run. Browser automation replaces the SDK callbacks with a local test implementation. |
| Create order | Orders v2, `POST /v2/checkout/orders` | `OrdersController.createOrder` in [`lib/app-payments.ts`](../lib/app-payments.ts). Server price, original listing hash in `customId`, USD, and stable request key are checked in [`test/app-payments.test.ts`](../test/app-payments.test.ts). |
| Capture and read back | Orders v2, `POST /v2/checkout/orders/{id}/capture`, `GET /v2/checkout/orders/{id}` | `captureOrder` followed by `getOrder`. Validates order identity, binding, currency, capture count, balance, and payer facts. Buyer approval alone is not capture confirmation. |
| Refund | Payments v2, `POST /v2/payments/captures/{capture_id}/refund` | `PaymentsController.refundCapturedPayment`. [`lib/app-service.ts`](../lib/app-service.ts) persists the request identity before the write; [`lib/policy.ts`](../lib/policy.ts) checks authority and remaining balance. |
| Reconcile refund | Payments v2, `GET /v2/payments/refunds/{refund_id}`, plus order readback | Pending or unknown is not completed. Service tests and Docker restart/restore checks preserve the receipt and request identity without another refund operation. |
| Sandbox tracking | Orders v2, `POST /v2/checkout/orders/{id}/track` | `createOrderTracking` labels the carrier “Sandbox demo” and disables buyer notification. The judge path's delivery eligibility is simulated, not a real shipment. |

Official references:
[Orders v2](https://developer.paypal.com/docs/api/orders/v2/),
[Payments v2](https://developer.paypal.com/docs/api/payments/v2/), and
[JavaScript SDK](https://developer.paypal.com/sdk/js/reference/).

## AI and money separation

- [`lib/app-review.ts`](../lib/app-review.ts) and
  [`lib/ensemble.ts`](../lib/ensemble.ts) send structured evidence requests to
  configured vision models. They have no payment tools.
- At least two distinct returned model IDs and unanimous required checks are
  needed for policy approval. Uncertainty leads to seller review, not a decline.
- A full seller may explicitly approve an eligible held case. Viewer access
  cannot approve refunds, even with a direct HTTP request.
- Original image bytes, hashes, checks, history, and payment identities remain
  private. Provenance runs before re-encoding; missing credentials are not proof
  of authenticity.

## Preserved CLI integration, not a web claim

[`lib/paypal.ts`](../lib/paypal.ts) retains the sandbox agent toolkit for the
older lookup/CLI path. Its reviewer-facing tool set is restricted by
[`lib/tools.ts`](../lib/tools.ts). Dispute commands use the sandbox
`/v1/customer/disputes` API with separate policy checks. Their contract snapshot
and isolated HTTP tests live under `test/`, not private notes.

Those tools are not imported by the production web entry point. The web demo
uses the server SDK above. Do not imply a model invoked a refund, a dispute was
created by a browser claim, or an installed tool was exercised live.

## What remains owner-only

Local tests replace external payments and reviews with deterministic adapters.
They exercise the built UI and real HTTP/service/storage paths, not PayPal's
network availability, real account permissions, model accuracy, or camera
authenticity. No external purchase or refund was made during local verification.

Before claiming a working external integration, follow
[the judge path](JUDGE.md): approve an actual sandbox purchase,
confirm capture, submit owner evidence through the configured reviewers, and
independently confirm any completed refund in the matching sandbox account.
Film the actual outcome and state who approved it.
