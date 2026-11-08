# Judge path

Live shop: https://breakorfake.trykioko.com/shop. No Cloudflare account, email
code, or identity-provider approval is needed. The seller desk still requires
the separate private viewer password.

## Five-minute paper-cup test

Use a paper cup, a pen, a small piece of paper, a laptop, and a phone. Do not
break glass or ceramic for this demo.

1. Open `/shop`. Expand the paper-cup judge instructions.
2. Photograph your intact cup. The original image becomes this order's listing.
   Keep faces and personal information outside the frame.
3. Complete the $25 sandbox purchase with PayPal's published test card. Click the black card button, choose United States, and enter 4005 5192 0000 0004, any future date, CVV 123, and any US address, phone and email. Pay as a guest, without creating an account. Never use a real card or payment account.
4. Save the private order/claim link from the confirmation. Do not post it publicly.
5. Tear the cup and describe the damage. An upload alone cannot receive a policy
   refund above $15.
6. Open live capture on the phone using the private handoff link. Write the fresh
   three-digit code on paper beside the cup.
7. Capture three views within two minutes, keeping the code and damage visible.
8. Return to the claim for the actual review result. A failed or uncertain review
   goes to the seller. A completed refund shows its real sandbox refund ID.

Open `/seller` and use the viewer password from the Devpost submission to
inspect claims, evidence, checks, and receipts. Viewer access cannot approve
refunds. Sellers use their own password for that action.

## What is real here

| Part | Status |
| --- | --- |
| Real application logic | Listing hash, session nonce, expiry, original image hashes, private access, policy gate, and case history |
| PayPal sandbox operations | Orders, captures, tracking, and confirmed refunds; no real money |
| Simulated delivery eligibility | Judge delivery eligibility is simulated; SHIPPED is not relabeled DELIVERED |
| Reviewer inference | Configured vision models review submitted photos; this is not a guarantee of authenticity or physical liveness |
| Shop pictures | Synthetic catalog art. Not photos of real stock, and never used as evidence. |

## Evaluation

```sh
npm run eval
npm run eval -- --live --inputs .notes/eval-inputs.json --run judge-live-1
```

The manifest is `eval/cases.json`: five honest and five adversarial cases.
The default command checks scripted policy inputs, not photo accuracy. Live
evaluation needs the owner's original evidence and configured reviewers.
The stripped-edit case deliberately exposes the low-value policy's limitation.
Do not turn its false refund into a successful catch.

The private input file has ten case entries using the exact manifest IDs.
An upload entry supplies `listingPath` and `uploadPath`. A live entry supplies
`listingPath`, `captureRoot`, and `captureId` for a saved standalone capture.
Alternatively, `claimId` loads original evidence and capture facts from the
local application's private database. Labels must be assigned before review.

Example shape for one entry (supply all ten real case entries):

```json
{
  "id": "honest-live-cup",
  "claimId": "the-real-local-claim-uuid"
}
```

Use a new run ID when original hashes or model settings change. Resume preserves
previous results, including failures. Reports stay in the private data directory.
No evaluation command can move money.

## Known limits

A staged scene, look-alike object, virtual camera, or carefully edited image can
still fool the reviewers. Missing Content Credentials do not mean authentic.
Free endpoints may retain prompts and photos, so this demo accepts only the
operator's own test photos. Ten cases are a demonstration, not certification.
No timing claim is valid until a fresh complete run has been measured.
Known virtual camera apps are held for the seller, but a modified page can still report a fake camera name.
