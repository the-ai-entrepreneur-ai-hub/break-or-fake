import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

interface Schema {
  $ref?: string;
  type?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}
const spec: { components: { schemas: Record<string, Schema> } } = JSON.parse(readFileSync(new URL("./support/paypal/disputes-v1-schema.json", import.meta.url), "utf8"));

function validate(value: unknown, schema: Schema): void {
  if (schema.$ref) return validate(value, spec.components.schemas[schema.$ref.split("/").pop()!]);
  if (schema.enum) assert.ok(schema.enum.includes(value), `invalid enum ${String(value)}`);
  if (schema.type === "string") {
    assert.equal(typeof value, "string");
    const text = String(value);
    if (schema.minLength !== undefined) assert.ok(text.length >= schema.minLength);
    if (schema.maxLength !== undefined) assert.ok(text.length <= schema.maxLength);
    if (schema.pattern) assert.match(text, new RegExp(schema.pattern));
  }
  if (schema.type === "object") {
    assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
    for (const key of schema.required ?? []) assert.ok(key in value, `missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      assert.ok(schema.properties?.[key], `unknown field ${key}`);
      validate(item, schema.properties[key]);
    }
  }
}

const dispute = {
  dispute_id: "PP-D-TEST",
  create_time: "2026-10-17T09:00:00Z",
  dispute_life_cycle_stage: "INQUIRY",
  status: "WAITING_FOR_SELLER_RESPONSE",
  reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
  dispute_amount: { currency_code: "EUR", value: "20.00" },
  disputed_transactions: [{ seller_transaction_id: "CAPTURE-TEST", transaction_status: "COMPLETED", gross_amount: { currency_code: "EUR", value: "32.00" } }],
  refund_details: { allowed_refund_amount: { currency_code: "EUR", value: "30.00" } },
  offer: { seller_offered_amount: { currency_code: "EUR", value: "20.00" } },
  links: [{ href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-TEST", rel: "self", method: "GET" }],
};

interface Request { url: string; method: string; headers: Record<string, string>; body: string | null; timeout: number | null }
function run(args: string[], response: unknown = dispute, failure?: "token" | "action" | "non-json" | "not-found") {
  const root = mkdtempSync(join(tmpdir(), "sandbox-disputes-"));
  try {
    mkdirSync(join(root, "scripts"));
    copyFileSync(new URL("../scripts/sandbox.ts", import.meta.url), join(root, "scripts/sandbox.ts"));
    copyFileSync(new URL("../package.json", import.meta.url), join(root, "package.json"));
    for (const directory of ["lib", "node_modules"]) symlinkSync(new URL(`../${directory}`, import.meta.url), join(root, directory), "dir");
    const script = `
      import { appendFileSync } from "node:fs";
      import { Socket } from "node:net";
      Socket.prototype.connect = () => { throw new Error("network forbidden"); };
      const timeout = AbortSignal.timeout;
      const timeouts = new WeakMap();
      AbortSignal.timeout = (milliseconds) => {
        const signal = timeout(milliseconds);
        timeouts.set(signal, milliseconds);
        return signal;
      };
      globalThis.fetch = async (url, init = {}) => {
        appendFileSync("requests.jsonl", JSON.stringify({ url: String(url), method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers)), body: init.body ?? null, timeout: timeouts.get(init.signal) ?? null }) + "\\n");
        if (String(url) === "https://api-m.sandbox.paypal.com/v1/oauth2/token") {
          return Response.json(${failure === "token" ? '{ error: "invalid_client", error_description: "Client authentication failed. " + new Headers(init.headers).get("authorization") + " " + init.body }' : '{ access_token: "mock-token", token_type: "Bearer" }'}, { status: ${failure === "token" ? 401 : 200} });
        }
        if (String(url) === "https://api-m.sandbox.paypal.com/v1/customer/disputes?page_size=10") return Response.json({ items: [${JSON.stringify(response)}], links: ${JSON.stringify(dispute.links)} });
        if (String(url) === "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-TEST" && (init.method ?? "GET") === "GET") return Response.json(${JSON.stringify(response)});
        if (init.method === "POST" && /^https:\\/\\/api-m\\.sandbox\\.paypal\\.com\\/v1\\/customer\\/disputes\\/PP-D-TEST\\/(make-offer|accept-claim|acknowledge-return-item)$/.test(String(url))) {
          if (${failure === "non-json"}) return new Response("private-error-body", { status: 502 });
          if (${failure === "not-found"}) return Response.json({ name: "RESOURCE_NOT_FOUND", message: "RESOURCE_NOT_FOUND", details: [{ issue: "RESOURCE_NOT_FOUND", description: "The dispute was not found." }, { issue: "RESOURCE_NOT_FOUND", description: "The dispute was not found." }] }, { status: 404 });
          return Response.json(${failure === "action" ? '{ name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed. mock-token test-secret " + new Headers(init.headers).get("authorization") + " " + init.body, details: [{ issue: "INVALID_RETURN_SHIPPING_ADDRESS", field: "/return_shipping_address_info/address", description: "The return address is invalid. test-secret", value: "private-request-value" }, { issue: "INVALID_DISPUTE_STATE", description: "The dispute is not eligible for this action. mock-token" }], debug_id: "debug-test", access_token: "mock-token" }' : JSON.stringify({ links: dispute.links })}, { status: ${failure === "action" ? 422 : 200} });
        }
        throw new Error("unexpected request " + url);
      };
      process.argv = [process.execPath, "scripts/sandbox.ts", ...${JSON.stringify(args)}];
      await import("./scripts/sandbox.ts");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: root, encoding: "utf8", timeout: 15000,
      env: { ...process.env, PAYPAL_CLIENT_ID: " test-id ", PAYPAL_CLIENT_SECRET: " test-secret " },
    });
    const readLines = (file: string): unknown[] => existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    return { result, requests: readLines("requests.jsonl") as Request[], entries: readLines("sandbox-ids.jsonl") as Array<Record<string, unknown>> };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("REST non-JSON errors retain the HTTP status without exposing the body", () => {
  const { result } = run(["offer", "PP-D-TEST"], dispute, "non-json");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PayPal .* answered 502/);
  assert.doesNotMatch(result.stderr, /private-error-body|mock-token/);
});

test("offer uses sandbox REST, the dispute currency, a US return address and a request id for round zero", () => {
  const { result, requests, entries } = run(["offer", "PP-D-TEST"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(requests.map(({ url, method }) => ({ url, method })), [
    { url: "https://api-m.sandbox.paypal.com/v1/oauth2/token", method: "POST" },
    { url: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-TEST", method: "GET" },
    { url: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-TEST/make-offer", method: "POST" },
  ]);
  assert.equal(requests[0].headers.authorization, `Basic ${Buffer.from("test-id:test-secret").toString("base64")}`);
  assert.equal(requests[0].headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(requests[0].body, "grant_type=client_credentials");
  assert.equal(requests[2].headers.authorization, "Bearer mock-token");
  assert.equal(requests[2].headers["content-type"], "application/json");
  assert.equal(requests[2].headers["paypal-request-id"], "offer_PP-D-TEST_0");
  const body = JSON.parse(requests[2].body!);
  assert.deepEqual(body, {
    offer_type: "REFUND_WITH_RETURN", offer_amount: { currency_code: "EUR", value: "20.00" },
    return_shipping_address_info: { address: { address_line_1: "123 Main Street", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" } },
    note: "Full refund after the damaged item is returned.",
  });
  validate(body, spec.components.schemas.make_offer);
  assert.ok(entries.some((entry) => entry.dispute_id === "PP-D-TEST" && entry.stage === "INQUIRY" && entry.status === "WAITING_FOR_SELLER_RESPONSE"));
  assert.deepEqual(entries.at(-1)?.links, dispute.links);
  assert.doesNotMatch(result.stdout + result.stderr + JSON.stringify(entries), /test-secret|mock-token/);
});

test("offer keeps one attempt per offer round using the history length", () => {
  const history = [{ actor: "SELLER", event_type: "PROPOSED" }, { actor: "BUYER", event_type: "DENIED" }];
  for (const item of history) validate(item, spec.components.schemas.offer_history);
  const { result, requests } = run(["offer", "PP-D-TEST"], { ...dispute, offer: { ...dispute.offer, history } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.at(-1)?.headers["paypal-request-id"], "offer_PP-D-TEST_2");
});

test("REST fetches receive a 30-second timeout signal", () => {
  const { result, requests } = run(["offer", "PP-D-TEST"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(requests.map(({ timeout }) => timeout), [30_000, 30_000, 30_000]);
});

test("offer is refused outside INQUIRY before any dispute POST", () => {
  const { result, requests } = run(["offer", "PP-D-TEST"], { ...dispute, dispute_life_cycle_stage: "CHARGEBACK" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PolicyError.*only at INQUIRY/);
  assert.equal(requests.filter((request) => request.url.includes("/customer/") && request.method === "POST").length, 0);
});

for (const command of ["offer", "ack-return", "accept"]) {
  test(`${command} uses allowed refund amount even when gross is absent`, () => {
    const { disputed_transactions, ...withoutGross } = dispute;
    const { result, requests } = run([command, "PP-D-TEST"], withoutGross);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests.at(-1)?.method, "POST");
  });

  test(`${command} is gated against the allowed refundable amount`, () => {
    const { result, requests } = run([command, "PP-D-TEST"], { ...dispute, refund_details: { allowed_refund_amount: { currency_code: "EUR", value: "12.00" } } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PolicyError.*more than the \$12.00 still refundable/);
    assert.equal(requests.filter((request) => request.url.includes("/customer/") && request.method === "POST").length, 0);
  });

  test(`${command} falls back to gross for a COMPLETED transaction when allowed refund amount is absent`, () => {
    const { refund_details, ...withoutRefund } = dispute;
    const { result, requests } = run([command, "PP-D-TEST"], withoutRefund);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests.at(-1)?.method, "POST");
  });

  test(`${command} refuses a missing refund allowance unless the transaction is COMPLETED`, () => {
    const { refund_details, ...withoutRefund } = dispute;
    for (const transaction_status of ["PARTIALLY_REFUNDED", undefined]) {
      const { result, requests } = run([command, "PP-D-TEST"], { ...withoutRefund, disputed_transactions: [{ ...dispute.disputed_transactions[0], transaction_status }] });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /allowed_refund_amount.*COMPLETED/);
      assert.equal(requests.filter((request) => request.url.includes("/customer/") && request.method === "POST").length, 0);
    }
  });

  test(`${command} refuses an amount above the gross fallback`, () => {
    const { refund_details, ...withoutRefund } = dispute;
    const amount = { currency_code: "EUR", value: "40.00" };
    const { result, requests } = run([command, "PP-D-TEST"], { ...withoutRefund, dispute_amount: amount, offer: { seller_offered_amount: amount } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PolicyError.*more than the \$32.00 still refundable/);
    assert.equal(requests.length, 2);
  });
}

test("accept sends the requested REFUND body and stable request id after the gate", () => {
  const { result, requests, entries } = run(["accept", "PP-D-TEST"], { ...dispute, dispute_life_cycle_stage: "CHARGEBACK" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.at(-1)?.url, "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-TEST/accept-claim");
  assert.equal(requests.at(-1)?.headers["paypal-request-id"], "accept_PP-D-TEST");
  const body = JSON.parse(requests.at(-1)!.body!);
  assert.deepEqual(body, { accept_claim_type: "REFUND", note: "Full refund for the damaged item." });
  // The spec omits these actions' JSON body schemas, so check their fields against its components.
  validate(body.accept_claim_type, spec.components.schemas.accept_claim_type);
  validate(body.note, spec.components.schemas.make_offer.properties!.note);
  assert.deepEqual(entries.at(-1)?.links, dispute.links);
});

test("ack-return refuses without a seller offer before any dispute POST", () => {
  const { offer, ...withoutOffer } = dispute;
  for (const response of [withoutOffer, { ...withoutOffer, offer: { buyer_requested_amount: dispute.dispute_amount } }]) {
    const { result, requests } = run(["ack-return", "PP-D-TEST"], response);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /seller offer/);
    assert.equal(requests.filter((request) => request.url.includes("/customer/") && request.method === "POST").length, 0);
  }
});

test("ack-return gates the seller offer within the refundable amount and acknowledges ITEM_RECEIVED", () => {
  const amount = { currency_code: "EUR", value: "12.00" };
  const { result, requests, entries } = run(["ack-return", "PP-D-TEST"], { ...dispute, dispute_life_cycle_stage: "CHARGEBACK", dispute_amount: { currency_code: "EUR", value: "40.00" }, offer: { seller_offered_amount: amount }, refund_details: { allowed_refund_amount: amount } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.at(-1)?.url, "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-TEST/acknowledge-return-item");
  assert.equal(requests.at(-1)?.method, "POST");
  const body = JSON.parse(requests.at(-1)!.body!);
  assert.deepEqual(body, { acknowledgement_type: "ITEM_RECEIVED", note: "Returned item received." });
  validate(body.acknowledgement_type, spec.components.schemas.acknowledgement_type);
  validate(body.note, spec.components.schemas.make_offer.properties!.note);
  assert.deepEqual(entries.at(-1)?.links, dispute.links);
});

test("dispute list retains create_time for each dispute", () => {
  validate(dispute.create_time, spec.components.schemas.dispute.properties!.create_time);
  const { result, entries } = run(["dispute"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(entries.find((entry) => entry.step === "dispute listed")?.create_time, "2026-10-17T09:00:00Z");
});

for (const args of [["dispute", "PP-D-TEST"], ["dispute"]]) {
  test(`${args.join(" ")} still reads disputes and logs ids, stages, statuses and links`, () => {
    const { result, entries } = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(entries.some((entry) => entry.dispute_id === "PP-D-TEST" && entry.stage === "INQUIRY" && entry.status === dispute.status));
    assert.ok(entries.some((entry) => JSON.stringify(entry.links) === JSON.stringify(dispute.links)));
  });
}

test("missing or invalid action ids fail before any fetch", () => {
  for (const args of [["offer"], ["accept"], ["ack-return"], ["offer", "../live"]]) {
    const { result, requests } = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dispute id/i);
    assert.equal(requests.length, 0);
  }
});

test("currency mismatch fails before any dispute POST", () => {
  const { result, requests } = run(["offer", "PP-D-TEST"], { ...dispute, refund_details: { allowed_refund_amount: { currency_code: "USD", value: "30.00" } } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /currency/i);
  assert.equal(requests.length, 2);
});

for (const failure of ["token", "action"] as const) {
  test(`REST ${failure} errors stop the command without logging credentials`, () => {
    const { result, requests } = run(["offer", "PP-D-TEST"], dispute, failure);
    assert.equal(result.status, 1);
    assert.match(result.stderr, failure === "token" ? /401/ : /422/);
    for (const detail of failure === "token"
      ? ["invalid_client", "Client authentication failed."]
      : ["UNPROCESSABLE_ENTITY", "The requested action could not be performed.", "INVALID_RETURN_SHIPPING_ADDRESS", "/return_shipping_address_info/address", "The return address is invalid.", "INVALID_DISPUTE_STATE", "The dispute is not eligible for this action.", "debug-test"]) {
      assert.ok(result.stderr.includes(detail), `missing ${detail} in ${result.stderr}`);
    }
    assert.equal(requests.length, failure === "token" ? 1 : 3);
    assert.doesNotMatch(result.stdout + result.stderr, /test-secret|mock-token/);
    assert.doesNotMatch(result.stderr, /mock-token/);
    assert.doesNotMatch(result.stderr, new RegExp(Buffer.from("test-id:test-secret").toString("base64")));
    assert.doesNotMatch(result.stderr, /private-request-value|Authorization|offer_type|grant_type=client_credentials/);
  });
}

test("REST errors omit exactly repeated parts", () => {
  const { result } = run(["offer", "PP-D-TEST"], dispute, "not-found");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /answered 404/);
  assert.equal(result.stderr.match(/RESOURCE_NOT_FOUND/g)?.length, 1);
  assert.equal(result.stderr.match(/The dispute was not found\./g)?.length, 1);
});
