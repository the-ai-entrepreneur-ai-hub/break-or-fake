import assert from "node:assert/strict";
import { test } from "node:test";
import { gate, PolicyError, toCents, type ClaimDecision, type MoneyCall } from "../lib/policy.js";

const decision: ClaimDecision = { claimId: "claim-test", approvedBy: "policy", evidence: "upload" };
const call: MoneyCall = { action: "refund", amountCents: 1200, capturedCents: 3200, refundedCents: 0 };

test("each money action requires approval", () => {
  for (const action of ["refund", "make_offer", "accept_claim"] as const) {
    assert.throws(() => gate({ ...decision, approvedBy: null }, { ...call, action, disputeStage: "INQUIRY" }), PolicyError);
    assert.doesNotThrow(() => gate(decision, { ...call, action, disputeStage: "INQUIRY" }));
  }
});

test("policy caps include their boundary, and seller approval bypasses only the cap", () => {
  for (const [evidence, ceiling] of [["upload", 1500], ["live", 6000]] as const) {
    const payment = { ...call, capturedCents: 10000, amountCents: ceiling };
    assert.doesNotThrow(() => gate({ ...decision, evidence }, payment));
    assert.throws(() => gate({ ...decision, evidence }, { ...payment, amountCents: ceiling + 1 }), /person decides/);
    assert.doesNotThrow(() => gate({ ...decision, approvedBy: "seller", evidence }, { ...payment, amountCents: ceiling + 1 }));
  }
});

test("refund cannot exceed the unrefunded capture, even with seller approval", () => {
  const payment = { ...call, refundedCents: 2000 };
  assert.doesNotThrow(() => gate(decision, payment));
  assert.throws(() => gate({ ...decision, approvedBy: "seller" }, { ...payment, amountCents: 1201 }), /still refundable/);
});

test("amount and capture balances must be safe nonnegative whole cents", () => {
  for (const amountCents of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => gate(decision, { ...call, amountCents }), PolicyError);
  }
  for (const field of ["capturedCents", "refundedCents"] as const) {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => gate(decision, { ...call, [field]: value }), PolicyError, `${field}=${value}`);
    }
  }
  assert.throws(() => gate(decision, { ...call, capturedCents: 1000, refundedCents: 1001 }), PolicyError);
});

test("invalid runtime approvals, evidence, actions and claim ids fail closed", () => {
  for (const invalid of [
    { ...decision, approvedBy: undefined },
    { ...decision, approvedBy: "buyer" },
    { ...decision, evidence: "unknown" },
    { ...decision, claimId: "" },
    { ...decision, claimId: "   " },
  ]) assert.throws(() => gate(invalid as ClaimDecision, call), PolicyError);
  assert.throws(() => gate(decision, { ...call, action: "new_action" } as unknown as MoneyCall), PolicyError);
});

test("offers require INQUIRY for both policy and seller approvals", () => {
  for (const approvedBy of ["policy", "seller"] as const) {
    for (const disputeStage of [undefined, "CLAIM", "CHARGEBACK", "inquiry"]) {
      assert.throws(() => gate({ ...decision, approvedBy }, { ...call, action: "make_offer", disputeStage }), /INQUIRY/);
    }
  }
});

test("decimal amounts parse exactly without rounding malformed values", () => {
  for (const [value, expected] of [["0", 0], ["0.01", 1], ["12.30", 1230], ["32.00", 3200], ["6000.1", 600010]] as const) {
    assert.equal(toCents(value), expected);
  }
  for (const value of ["", " ", "-1", "1.005", "1e2", "Infinity", "NaN", " 12", "1.", "0x10", "900719925474099.00"]) {
    assert.throws(() => toCents(value), PolicyError, value);
  }
});
