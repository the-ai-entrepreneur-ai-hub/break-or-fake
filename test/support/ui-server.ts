import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { AppStore } from "../../lib/app-store.js";
import { AppService } from "../../lib/app-service.js";
import { makeAppHandler } from "../../lib/app-server.js";
import type { PaymentFacts, PaymentProvider, RefundFacts } from "../../lib/app-payments.js";
import type { ImageInput } from "../../lib/app-types.js";
import type { StoredClaim } from "../../lib/app-records.js";

const temporary = !process.env.QA_DATA_DIR;
const directory = temporary ? await mkdtemp(join(tmpdir(), "refund-ui-qa-")) : resolve(process.env.QA_DATA_DIR!);
const store = new AppStore(directory);
const emptyStore = new AppStore(join(directory, "empty"));
let clockOffset = store.get<number>("qa", "clock-offset") ?? 0;
const now = () => Date.now() + clockOffset;
const orders = new Map(store.all<PaymentFacts>("qa-orders").map(row => [row.orderId, row]));
const refunds = new Map(store.all<RefundFacts & { requestId: string }>("qa-refunds").map(row => [row.requestId, row]));
let refundCalls = store.get<number>("qa", "refund-calls") ?? 0;
let captureCalls = store.get<number>("qa", "capture-calls") ?? 0;
const saveOrder = (order: PaymentFacts) => store.put("qa-orders", order.orderId, order);
const payments: PaymentProvider = {
  ready: true, clientId: null,
  async createOrder(input) {
    const id = `QA-ORDER-${orders.size + 1}`;
    const order: PaymentFacts = {
      orderId: id, status: "CREATED", amountCents: input.amountCents, currency: "USD",
      listingHash: input.listingHash, refundedCents: 0, refunds: [], payerId: store.get<string>("qa", "payer-id") ?? `qa-payer-${id}`,
      tracking: "DELIVERED", deliveredAt: new Date(now() - 60_000).toISOString(),
    };
    orders.set(id, order); saveOrder(order);
    return { id, status: "CREATED" };
  },
  async captureOrder(id) {
    captureCalls++; store.put("qa", "capture-calls", captureCalls);
    const order = orders.get(id)!;
    order.status = "COMPLETED"; order.captureId = `QA-CAPTURE-${id}`; saveOrder(order);
    return structuredClone(order);
  },
  async getOrder(id) {
    const order = orders.get(id);
    if (!order) throw Error("Unknown isolated test order");
    return structuredClone(order);
  },
  async refund(captureId, amountCents, requestId) {
    refundCalls++; store.put("qa", "refund-calls", refundCalls);
    if (!refunds.has(requestId)) {
      const result = {
        id: `QA-REFUND-${refunds.size + 1}`, status: store.get("qa", "refund-mode") === "pending" ? "PENDING" : "COMPLETED",
        amountCents, currency: "USD", requestId,
      };
      refunds.set(requestId, result); store.put("qa-refunds", requestId, result);
      const order = [...orders.values()].find(row => row.captureId === captureId)!;
      order.refundedCents += amountCents; order.refunds.push(result); saveOrder(order);
    }
    return structuredClone(refunds.get(requestId)!);
  },
  async getRefund(id) {
    const result = [...refunds.values()].find(row => row.id === id);
    if (!result) throw Error("Unknown isolated test refund");
    return structuredClone(result);
  },
};
const image = async (color: string): Promise<ImageInput> => ({
  mimeType: "image/png",
  data: (await sharp({ create: { width: 120, height: 120, channels: 3, background: color } }).png().toBuffer()).toString("base64"),
});
const original = await image("#dddddd");
const linenPath = join(directory, "linen-test.png");
await writeFile(linenPath, Buffer.from(original.data, "base64"));
const service = new AppService({
  store, payments, now, reviewer: { ready: false, models: [], async review() { throw Error("No external requests in QA"); } },
  readCredentials: async () => ({ status: "missing", generated: false }),
});
const emptyService = new AppService({
  store: emptyStore, payments, now, listingPaths: { linen: linenPath, mug: linenPath },
  readCredentials: async () => ({ status: "missing", generated: false }),
  reviewer: {
    ready: true, models: ["test/model-a", "test/model-b"],
    async review() {
      return {
        clear: true,
        checks: [{ id: "test-review", label: "Isolated deterministic review", status: "pass", detail: "Test adapter, not measured inference." }],
        reviews: ["test/model-a", "test/model-b"].map(model => ({ model, returnedModel: model, ok: true, durationMs: 1 })),
      };
    },
  },
});
const cases = store.get<Record<string, { id: string; orderId: string; token: string }>>("qa", "cases") ?? {};
if (!cases.held) {
  for (const status of ["held", "awaiting_live", "refunded", "reviewing", "refund_pending"]) {
    const order = await service.createOrder("judge-cup", original);
    await service.captureOrder(order.order.id, order.token);
    const claim = await service.createClaim(order.order.id, order.token, {
      message: `Isolated QA ${status}: the cup arrived torn.`, image: await image("#bbaa99"),
      ...(status === "held" || status === "refunded" ? { help: true } : {}),
    });
    if (status === "refunded") await service.refundClaim(claim.id, 2500, "seller");
    const row = store.get<StoredClaim>("claims", claim.id)!;
    if (status === "reviewing") row.status = "reviewing";
    if (status === "refund_pending") {
      row.status = "refund_pending";
      row.refund = { status: "pending", amountCents: 2500, requestId: "QA-PENDING", approvedBy: "seller", createdAt: row.createdAt, baselineRefundIds: [], baselineRefundedCents: 0 };
    }
    row.lastSyncedAt = new Date(now()).toISOString(); row.lastSyncAttempt = now();
    row.checks = [{ id: "qa-check", label: "Original photo and listing binding", status: status === "held" ? "hold" : "pass", detail: "Isolated test result, not measured inference." }];
    row.reviews = [{ model: "test/independent-vision-model-with-a-long-readable-label", returnedModel: "test/independent-vision-model-with-a-long-readable-label", ok: true, durationMs: 1234 }];
    store.put("claims", claim.id, row);
    cases[status] = { id: claim.id, orderId: order.order.id, token: order.token };
  }
  const unclaimed = await service.createOrder("judge-cup", original);
  await service.captureOrder(unclaimed.order.id, unclaimed.token);
  cases.unclaimed = { id: unclaimed.order.id, orderId: unclaimed.order.id, token: unclaimed.token };
  store.put("qa", "cases", cases);
}
const options = { sellerPassword: "seller-password-for-tests", sellerViewerPassword: "viewer-password-for-tests" };
const handler = makeAppHandler({ service, ...options });
const emptyHandler = makeAppHandler({ service: emptyService, ...options });
function wrap(app: ReturnType<typeof makeAppHandler>) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.url === "/__qa/state" && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ isolated: true, refundCalls, captureCalls, refundOperations: refunds.size, requestIds: [...refunds.keys()], cases }));
      return;
    }
    if (request.method === "POST" && ["/__qa/refund-mode", "/__qa/advance", "/__qa/payer"].includes(request.url ?? "")) {
      let text = "";
      for await (const chunk of request) {
        text += chunk;
        if (text.length > 1024) { response.writeHead(413); response.end(); return; }
      }
      try {
        const body = JSON.parse(text);
        if (request.url === "/__qa/payer") {
          if (body.id !== null && (typeof body.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.id))) throw Error("Invalid test payer");
          if (body.id === null) store.remove("qa", "payer-id");
          else store.put("qa", "payer-id", body.id);
        } else if (request.url === "/__qa/advance") {
          if (!Number.isInteger(body.milliseconds) || body.milliseconds < 0 || body.milliseconds > 300_000) throw Error("Invalid test clock");
          clockOffset += body.milliseconds; store.put("qa", "clock-offset", clockOffset);
        } else {
          if (!["pending", "complete"].includes(body.mode)) throw Error("Invalid test mode");
          store.put("qa", "refund-mode", body.mode);
          if (body.mode === "complete") {
            for (const [key, refund] of refunds) if (refund.status === "PENDING") {
              refund.status = "COMPLETED"; store.put("qa-refunds", key, refund);
            }
            for (const order of orders.values()) {
              order.refunds = order.refunds.map(row => [...refunds.values()].find(value => value.id === row.id) ?? row);
              saveOrder(order);
            }
          }
        }
        response.writeHead(204); response.end();
      } catch { response.writeHead(400); response.end(); }
      return;
    }
    await app(request, response);
  };
}
const server = createServer(wrap(handler)), emptyServer = createServer(wrap(emptyHandler));
const host = process.env.QA_HOST ?? "127.0.0.1";
await Promise.all([
  new Promise<void>(resolve => server.listen(Number(process.env.QA_PORT ?? 0), host, resolve)),
  new Promise<void>(resolve => emptyServer.listen(Number(process.env.QA_EMPTY_PORT ?? 0), host, resolve)),
]);
const address = server.address(), emptyAddress = emptyServer.address();
if (!address || typeof address === "string" || !emptyAddress || typeof emptyAddress === "string") throw Error("No QA addresses");
const addresses = { baseURL: `http://127.0.0.1:${address.port}`, emptyURL: `http://127.0.0.1:${emptyAddress.port}` };
process.send?.(addresses);
console.log("Isolated UI QA ready", JSON.stringify(addresses));
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  void Promise.all([
    new Promise<void>(resolve => server.close(() => resolve())),
    new Promise<void>(resolve => emptyServer.close(() => resolve())),
  ]).then(async () => {
    await Promise.all([service.idle(), emptyService.idle()]);
    emptyStore.close(); store.close();
    if (temporary) await rm(directory, { recursive: true, force: true });
    process.exit(0);
  });
});
