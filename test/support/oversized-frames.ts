import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { AppStore } from "../../lib/app-store.js";
import { AppService } from "../../lib/app-service.js";
import { makeAppHandler } from "../../lib/app-server.js";
import type { PaymentProvider } from "../../lib/app-payments.js";

const store = new AppStore(process.argv[2]);
const count = Number(process.argv[3] ?? 1_000_000);
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
const path = "/api/claims/00000000-0000-0000-0000-000000000001/capture-sessions/00000000-0000-0000-0000-000000000002/frames";
const send = (frames: unknown) => fetch(base + path, {
  method: "POST", headers: { origin: base, "content-type": "application/json" },
  body: JSON.stringify({ orderId: "test-order", nonce: "123", frames }),
});
try {
  const started = performance.now();
  const response = await send(Array(count).fill(0));
  const oversizedStatus = response.status;
  await response.text();
  const valid = await send(Array(3).fill({ mimeType: "image/png", data: "Zg==" }));
  const validShapeStatus = valid.status;
  await valid.text();
  const health = await fetch(base + "/health");
  await health.text();
  console.log(JSON.stringify({
    count, oversizedStatus, validShapeStatus, healthStatus: health.status, providerCalls,
    elapsedMs: Math.round(performance.now() - started), maxRssBytes: process.resourceUsage().maxRSS * 1024,
  }));
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
}
