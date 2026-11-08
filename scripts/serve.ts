import { createServer } from "node:http";
import { resolve } from "node:path";
import { AppStore } from "../lib/app-store.js";
import { AppService } from "../lib/app-service.js";
import { makeSandboxPayments } from "../lib/app-payments.js";
import { makeEvidenceReviewer } from "../lib/app-review.js";
import { makeAppHandler } from "../lib/app-server.js";

const host = process.env.APP_HOST ?? "127.0.0.1", port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535.");
if (process.env.NODE_ENV === "production" && !process.env.APP_ORIGIN?.startsWith("https://")) throw new Error("Production requires an HTTPS APP_ORIGIN.");
const store = new AppStore(resolve(process.env.DATA_DIR ?? ".data"));
const payments = makeSandboxPayments(process.env.PAYPAL_CLIENT_ID ?? "", process.env.PAYPAL_CLIENT_SECRET ?? "");
const models = (process.env.OPENROUTER_MODELS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const reviewer = makeEvidenceReviewer(process.env.OPENROUTER_API_KEY ?? "", models);
const budget = Number(process.env.DAILY_REVIEW_LIMIT ?? 100);
if (!Number.isSafeInteger(budget) || budget < 1 || budget > 1000) throw new Error("DAILY_REVIEW_LIMIT must be between 1 and 1000.");
const service = new AppService({
  store, payments, reviewer, dailyBudget: budget,
  listingPaths: { mug: process.env.LISTING_IMAGE_PATH ?? "", linen: process.env.UPLOAD_LISTING_IMAGE_PATH ?? "" },
});
const server = createServer(makeAppHandler({ service, sellerPassword: process.env.SELLER_PASSWORD ?? "", sellerViewerPassword: process.env.SELLER_VIEWER_PASSWORD, origin: process.env.APP_ORIGIN }));
let polling = false;
const poll = setInterval(() => {
  if (polling) return;
  polling = true;
  void service.pollActive().catch(() => {}).finally(() => { polling = false; });
}, 60_000);
poll.unref();
const retention = setInterval(() => { void service.cleanup().catch(() => {}); }, 24 * 60 * 60_000);
retention.unref();
await service.cleanup();
server.requestTimeout = 60_000;
server.headersTimeout = 15_000;
server.listen(port, host, () => {
  console.log(`Sunday Supply sandbox: http://${host}:${port}/shop`);
  console.log(`Setup: payments ${payments.ready ? "configured" : "missing"}, reviewers ${reviewer.ready ? "configured" : "missing"}, seller ${process.env.SELLER_PASSWORD && process.env.SELLER_PASSWORD.length >= 12 ? "configured" : "missing"}.`);
});
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true; clearInterval(poll); clearInterval(retention);
  server.close(() => { void service.idle().finally(() => { store.close(); process.exit(0); }); });
  setTimeout(() => process.exit(1), 100_000).unref();
});
