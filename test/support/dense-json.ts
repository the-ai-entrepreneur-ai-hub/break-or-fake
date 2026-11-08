import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppStore } from "../../lib/app-store.js";
import { AppService } from "../../lib/app-service.js";
import { makeAppHandler } from "../../lib/app-server.js";
import type { PaymentProvider } from "../../lib/app-payments.js";

const store = new AppStore(process.argv[2]);
let providerCalls = 0;
const unavailable = async (): Promise<never> => { providerCalls++; throw Error("No external requests"); };
const payments: PaymentProvider = {
  ready: false, clientId: null, createOrder: unavailable, captureOrder: unavailable,
  getOrder: unavailable, refund: unavailable, getRefund: unavailable,
};
const service = new AppService({ store, payments, reviewer: { ready: false, models: [], review: unavailable } });
const server = createServer(makeAppHandler({ service, sellerPassword: "" }));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw Error("No HTTP address");
const base = `http://127.0.0.1:${address.port}`;
try {
  const body = readFileSync(join(process.argv[2], "payload.json"), "utf8");
  console.error("Sending dense JSON to the real public handler");
  const response = await fetch(base + "/api/orders", {
    method: "POST", headers: { origin: base, "content-type": "application/json" }, body,
  });
  await response.text();
  const health = await fetch(base + "/health");
  await health.text();
  console.log(JSON.stringify({ status: response.status, health: health.status, providerCalls }));
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
}
