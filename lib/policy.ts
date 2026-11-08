// PayPal toolkit tools that only read. The claim reviewer gets these and nothing else, so no money tool reaches the model.
// New toolkit tools stay unavailable until explicitly reviewed.
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["get_order", "list_disputes", "get_dispute"]);

// The seller's policy numbers, in cents.
export const UPLOAD_LINE_CENTS = 1500; // at or under this, an uploaded photo is enough for the policy to refund
export const LIVE_CEILING_CENTS = 6000; // above this, a person decides even with a live photo

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export interface ClaimDecision {
  claimId: string;
  approvedBy: "policy" | "seller" | null; // null: nobody approved moving money
  evidence: "upload" | "live"; // how the claim photo was taken
}

export interface MoneyCall {
  action: "refund" | "make_offer" | "acknowledge_return" | "accept_claim";
  amountCents: number;
  capturedCents: number; // what the buyer paid on this capture
  refundedCents: number; // what has already gone back to them
  disputeStage?: string; // PayPal's dispute_life_cycle_stage, needed for make_offer
}

export function toCents(value: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new PolicyError("invalid decimal amount");
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new PolicyError("amount exceeds safe whole cents");
  return cents;
}
const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

// Runs before every refund, offer, return acknowledgement and accept-claim call. It decides on facts, never on the model's reasons.
export function gate(decision: ClaimDecision, call: MoneyCall): void {
  const refuse = (why: string): never => {
    throw new PolicyError(`refusing ${call.action} on claim ${decision.claimId}: ${why}`);
  };
  if (typeof decision.claimId !== "string" || !decision.claimId.trim()) refuse("missing claim id");
  if (decision.approvedBy !== "policy" && decision.approvedBy !== "seller") refuse("nobody approved it");
  if (decision.evidence !== "upload" && decision.evidence !== "live") refuse("unknown evidence");
  if (!["refund", "make_offer", "acknowledge_return", "accept_claim"].includes(call.action)) refuse("unknown money action");
  if (!Number.isSafeInteger(call.amountCents) || call.amountCents <= 0) refuse(`${call.amountCents} cents is not a positive whole amount`);
  for (const value of [call.capturedCents, call.refundedCents]) {
    if (!Number.isSafeInteger(value) || value < 0) refuse("capture balances must be nonnegative safe whole cents");
  }
  if (call.refundedCents > call.capturedCents) refuse("refunded balance exceeds capture");
  const refundableCents = call.capturedCents - call.refundedCents;
  if (!(call.amountCents <= refundableCents)) {
    refuse(`${dollars(call.amountCents)} is more than the ${dollars(refundableCents)} still refundable`);
  }
  if (decision.approvedBy === "policy") {
    const ceiling = decision.evidence === "live" ? LIVE_CEILING_CENTS : UPLOAD_LINE_CENTS;
    if (call.amountCents > ceiling) {
      refuse(`${dollars(call.amountCents)} is above the ${dollars(ceiling)} the policy may refund on ${decision.evidence} evidence, so a person decides`);
    }
  }
  if (call.action === "make_offer" && call.disputeStage !== "INQUIRY") {
    refuse(`PayPal takes offers only at INQUIRY, and this dispute is at ${call.disputeStage ?? "an unknown stage"}`);
  }
}
