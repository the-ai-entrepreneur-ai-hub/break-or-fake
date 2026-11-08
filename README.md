# Break or Fake

Anyone can fake a damage photo with one prompt. Break or Fake checks an 'arrived damaged' claim before a PayPal refund moves.

Live demo: https://breakorfake.trykioko.com/shop

## Try it in five minutes

Use a paper cup, a pen, paper, a laptop, and a phone. Do not break glass or ceramic.

1. Open `/shop` and expand the paper-cup instructions. Add your intact cup photo as the listing. Keep personal information out of frame.
2. Complete the $25 sandbox purchase with PayPal's published test card. Click the black card button, choose United States, and enter 4005 5192 0000 0004, any future date, CVV 123, and any US address, phone and email. Pay as a guest, without creating an account. Never use a real card or payment account.
3. Save the private order/claim link. Tear the cup and describe the damage. An upload alone cannot authorize a policy refund above $15.
4. Open live capture on your phone from the private handoff link. Write the fresh three-digit code beside the cup. Capture three views within two minutes.
5. Return to the claim for the actual result. Uncertain reviews go to the seller. A completed refund shows its PayPal sandbox refund ID.
6. Open `/seller` with the viewer password from the Devpost testing notes. Viewer access shows evidence, checks, and receipts, but cannot approve refunds.

See the [judge path](docs/JUDGE.md) for the full steps.

## How it works

The listing hash is bound to the PayPal order's `custom_id`. Upload evidence can authorize up to $15. Live-code evidence can authorize up to $60.
Independent vision reviewers have no tools. Code decides about money. Anything uncertain goes to the seller. Never an automatic denial.

## PayPal integration

| Step | PayPal interface | Implementation and local evidence |
| --- | --- | --- |
| Buyer approval | PayPal JavaScript SDK Buttons | [`src/PayPalCheckout.tsx`](src/PayPalCheckout.tsx). The buyer must approve manually in a real sandbox run. Browser automation replaces the SDK callbacks with a local test implementation. |
| Create order | Orders v2, `POST /v2/checkout/orders` | `OrdersController.createOrder` in [`lib/app-payments.ts`](lib/app-payments.ts). Server price, original listing hash in `customId`, USD, and stable request key are checked in [`test/app-payments.test.ts`](test/app-payments.test.ts). |
| Capture and read back | Orders v2, `POST /v2/checkout/orders/{id}/capture`, `GET /v2/checkout/orders/{id}` | `captureOrder` followed by `getOrder` in [`lib/app-payments.ts`](lib/app-payments.ts). Validates order identity, binding, currency, capture count, balance, and payer facts. Buyer approval alone is not capture confirmation. |
| Refund | Payments v2, `POST /v2/payments/captures/{capture_id}/refund` | `PaymentsController.refundCapturedPayment` in [`lib/app-payments.ts`](lib/app-payments.ts). [`lib/app-service.ts`](lib/app-service.ts) persists the request identity before the write; [`lib/policy.ts`](lib/policy.ts) checks authority and remaining balance. |
| Reconcile refund | Payments v2, `GET /v2/payments/refunds/{refund_id}`, plus order readback | `getRefund` and `getOrder` in [`lib/app-payments.ts`](lib/app-payments.ts). Pending or unknown is not completed. Service tests and Docker restart/restore checks preserve the receipt and request identity without another refund operation. |
| Sandbox tracking | Orders v2, `POST /v2/checkout/orders/{id}/track` | `createOrderTracking` in [`lib/app-payments.ts`](lib/app-payments.ts) labels the carrier “Sandbox demo” and disables buyer notification. The judge path's delivery eligibility is simulated, not a real shipment. |

The [API evidence map](docs/API-EVIDENCE.md) separates implemented calls from external transaction evidence.
Command-line sandbox tools: `npm run sandbox` creates an order and waits for buyer approval; `npm run sandbox -- --no-refund` skips the refund. `npm run sandbox -- dispute`, `dispute <id>`, `offer <id>`, `ack-return <id>`, and `accept <id>` inspect or act on existing sandbox disputes through the policy gate.

## What is real

| Part | Status |
| --- | --- |
| Real application logic | Listing hash, session nonce, expiry, original image hashes, private access, policy gate, and case history |
| PayPal sandbox operations | Orders, captures, tracking, and confirmed refunds; no real money |
| Simulated delivery eligibility | Judge delivery eligibility is simulated; SHIPPED is not relabeled DELIVERED |
| Reviewer inference | Configured vision models review submitted photos; this is not a guarantee of authenticity or physical liveness |
| Shop pictures | Synthetic catalog art. Not photos of real stock, and never used as evidence. |

A real run on a local copy of this build used PayPal's sandbox with PayPal's published test card: purchase, capture, seller-approved refund, and the two live reviewers. A physical-phone capture has not been run yet. Local test adapters are not live measurements or external payment evidence.

## Limits

Staged scenes, look-alike items, and virtual cameras can fool the reviewers. Careful fakes under $15 get paid by design.
Missing Content Credentials prove nothing. Free endpoints may retain photos. Use only your own authorized test photos.
Known virtual camera apps are held for the seller, but a modified page can still report a fake camera name.

## Run it yourself

Requires Node 24+. `npm ci` downloads one native binary from GitHub releases.

```sh
npm ci
```

Copy `.env.example` to a private `.env`. Set these variables, one per line:

- `PAYPAL_CLIENT_ID`: sandbox merchant client ID.
- `PAYPAL_CLIENT_SECRET`: sandbox merchant client secret.
- `OPENROUTER_API_KEY`: reviewer endpoint key.
- `OPENROUTER_MODELS`: two or three distinct free vision reviewer IDs, comma-separated.
- `SELLER_PASSWORD`: full seller password, at least 12 characters.
- `SELLER_VIEWER_PASSWORD`: separate viewer password, at least 12 characters; must differ from the seller password.
- `LISTING_IMAGE_PATH`: authentic owner original for the mug; missing originals disable its checkout.
- `UPLOAD_LISTING_IMAGE_PATH`: authentic owner original for the linen; missing originals disable its checkout.
- `APP_ORIGIN`: application origin; HTTPS is required in production.
- `APP_HOST`: bind address; defaults to `127.0.0.1`.
- `PORT`: listener port; defaults to `3000`.
- `DATA_DIR`: private persistent data directory; defaults to `.data`. Keep it across restarts.
- `DAILY_REVIEW_LIMIT`: daily review budget from 1 to 1000; defaults to 100.

```sh
npm run build
npm start
```

Open `http://127.0.0.1:3000/shop` with the default host and port. The paper-cup path requires your own intact cup photo.

## Checks

```sh
npm test
npm run typecheck
npm run build
npm run eval
```

`npm run eval` runs ten scripted policy checks, not accuracy measurements.

## License

[MIT](LICENSE). Copyright (c) 2026 George Kioko.
