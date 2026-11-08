import assert from "node:assert/strict";
import { test } from "node:test";
import { makePayPalClient, makePayPalTools, makePayPalToolsFor } from "../lib/paypal.js";
import { READ_ONLY_TOOLS } from "../lib/policy.js";
import { record, reviewerTools, type StepRecord } from "../lib/tools.js";

delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;

test("reviewer exposes exactly the three lookups and no other installed tool", () => {
  const tools = reviewerTools([]);
  assert.deepEqual(Object.keys(tools).sort(), ["get_dispute", "get_order", "list_disputes"]);
  for (const name of Object.keys(makePayPalToolsFor("unset", "unset"))) {
    assert.equal(name in tools, READ_ONLY_TOOLS.has(name), name);
  }
});

test("toolkit leaves shipment tracking unavailable", () => {
  const tools = makePayPalToolsFor("unset", "unset");
  assert.equal("create_shipment_tracking" in tools, false);
  assert.equal("get_shipment_tracking" in tools, false);
});

test("every stub lookup records its result without a network call", async () => {
  const steps: StepRecord[] = [];
  const tools = reviewerTools(steps);
  for (const [name, tool] of Object.entries(tools)) {
    assert.ok(tool.execute);
    const input = { id: "stub-id" };
    const output = await tool.execute(input, { toolCallId: name, messages: [] });
    assert.deepEqual(output, { stub: true, note: "PayPal sandbox credentials unset" });
    assert.equal(steps.at(-1)?.tool, name);
    assert.deepEqual(steps.at(-1)?.input, input);
    assert.deepEqual(steps.at(-1)?.output, output);
  }
  for (const step of steps) {
    assert.ok(Number.isFinite(step.durationMs) && step.durationMs >= 0);
    assert.ok(Number.isFinite(Date.parse(step.at)));
    assert.ok(step.id);
  }
});

test("timeline preserves thrown failures and successful undefined returns", async () => {
  const steps: StepRecord[] = [];
  const error = new Error("read failed");
  await assert.rejects(record(steps, "get_order", {}, async () => { throw error; }), (caught) => caught === error);
  assert.equal(steps[0]?.error, "read failed");
  assert.equal(steps[0]?.output, undefined);
  assert.equal(await record(steps, "get_order", {}, async () => undefined), undefined);
  assert.equal(steps.length, 2);
});

test("partial or absent credentials keep both clients in stub mode", () => {
  assert.equal(makePayPalClient(), null);
  assert.equal(makePayPalTools(), null);
  process.env.PAYPAL_CLIENT_ID = "test-only";
  try {
    assert.equal(makePayPalClient(), null);
    assert.equal(makePayPalTools(), null);
  } finally {
    delete process.env.PAYPAL_CLIENT_ID;
  }
});
