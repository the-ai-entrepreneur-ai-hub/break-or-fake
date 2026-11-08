import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AppService } from "./app-service.js";
import { AppError, RateLimiter, SellerSessions } from "./app-security.js";
import { EMPTY_EVALUATION } from "./evaluation.js";
import type { ClaimView, EvaluationSummary } from "./app-types.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BODY_LIMIT = 17 * 1024 * 1024;
const image = z.object({ mimeType: z.enum(["image/jpeg", "image/png"]), data: z.string().max(5_592_408) }).strict();
// Reject oversized collections before the legacy validator walks every element.
const frames = z.preprocess(value => Array.isArray(value) && value.length > 3 ? undefined : value, z.array(image).length(3));
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ico": "image/x-icon",
};
interface HandlerOptions { service: AppService; sellerPassword: string; sellerViewerPassword?: string; origin?: string; distDirectory?: string }

function parseRequestJson(text: string): unknown {
  const syntax = /["[\]{}:,]/g;
  let tokens = 0, depth = 0, match: RegExpExecArray | null;
  while ((match = syntax.exec(text))) {
    if (++tokens > 256) throw new AppError(400, "This request has too much JSON structure.");
    const token = match[0];
    if (token === '"') {
      let end = syntax.lastIndex - 1, escaped: boolean;
      do {
        end = text.indexOf('"', end + 1);
        if (end < 0) throw new AppError(400, "Send a valid JSON object.");
        let slash = end - 1;
        while (text[slash] === "\\") slash--;
        escaped = (end - slash - 1) % 2 === 1;
      } while (escaped);
      syntax.lastIndex = end + 1;
    } else if (token === "[" || token === "{") {
      if (++depth > 16) throw new AppError(400, "This request is nested too deeply.");
    } else if (token === "]" || token === "}") depth--;
  }
  return JSON.parse(text);
}

export function makeAppHandler(options: HandlerOptions) {
  const { service } = options, sessions = new SellerSessions(options.sellerPassword, Date.now, options.sellerViewerPassword);
  const requests = new RateLimiter(240, 60_000), logins = new RateLimiter(5, 15 * 60_000), checkouts = new RateLimiter(12, 10 * 60_000);
  const dist = resolve(options.distDirectory ?? resolve(ROOT, "dist"));
  let activeMutations = 0, activeEvidenceTransfers = 0;
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let mutationCounted = false;
    const nonce = randomBytes(18).toString("base64");
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("permissions-policy", "camera=(self), microphone=(), geolocation=()");
    response.setHeader("cross-origin-opener-policy", "same-origin-allow-popups");
    response.setHeader("content-security-policy", `default-src 'self'; script-src 'self' 'nonce-${nonce}' https://*.paypal.com https://*.paypalobjects.com; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https://*.paypal.com https://*.paypalobjects.com; font-src 'self' data:; connect-src 'self' https://*.paypal.com https://*.paypalobjects.com; frame-src https://*.paypal.com; media-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self' https://*.paypal.com`);
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(value));
    };
    const cookie = /(?:^|;\s*)bof_seller=([A-Za-z0-9_-]+)/.exec(request.headers.cookie ?? "")?.[1] ?? "";
    const role = sessions.role(cookie), seller = role !== null;
    const claimView = (claim: ClaimView): ClaimView => ({ ...claim, canRefund: role === "seller" && claim.canRefund });
    const token = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(request.headers.authorization ?? "")?.[1];
    const requireSeller = () => { if (!seller) throw new AppError(401, "Sign in to the seller desk first."); };
    const json = async (): Promise<unknown> => {
      if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new AppError(415, "Send JSON for this request.");
      if (Number(request.headers["content-length"] ?? 0) > BODY_LIMIT) throw new AppError(413, "This request is too large.");
      const chunks: Buffer[] = []; let size = 0;
      for await (const part of request) {
        size += part.length;
        if (size > BODY_LIMIT) throw new AppError(413, "This request is too large.");
        chunks.push(Buffer.from(part));
      }
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        chunks.length = 0;
        return parseRequestJson(text);
      }
      catch { throw new AppError(400, "Send a valid JSON object."); }
    };
    try {
      const url = new URL(request.url ?? "/", "http://localhost"), path = url.pathname;
      const ip = request.socket.remoteAddress ?? "unknown";
      if (path.startsWith("/api/") && !requests.take(ip)) throw new AppError(429, "Too many requests. Wait a minute and try again.");
      if (!["GET", "HEAD", "POST"].includes(request.method ?? "")) throw new AppError(405, "Method not allowed.");
      if (request.method === "POST") {
        const expected = options.origin ? new URL(options.origin).origin : `http://${request.headers.host}`;
        if (!request.headers.origin || request.headers.origin !== expected) throw new AppError(403, "A same-origin request is required.");
        if (activeMutations >= 8) throw new AppError(429, "Too many uploads or updates are in progress. Try again shortly.");
        activeMutations++; mutationCounted = true;
      }
      if (request.method === "GET" && ["/health", "/ready"].includes(path)) {
        const config = service.config(sessions.configured);
        const ready = service.payments.ready && service.reviewer.ready && sessions.configured;
        send(path === "/ready" && !ready ? 503 : 200, {
          status: path === "/ready" && !ready ? "setup_required" : "ok", ready, mode: "sandbox",
          services: { storage: true, payments: service.payments.ready, reviewers: service.reviewer.ready, seller: config.sellerConfigured },
        }); return;
      }
      if (request.method === "GET" && path === "/api/config") { send(200, service.config(sessions.configured)); return; }
      if (request.method === "GET" && path === "/api/evaluation") {
        send(200, service.store.get<EvaluationSummary>("settings", "evaluation") ?? EMPTY_EVALUATION); return;
      }
      if (request.method === "GET" && path === "/api/seller/session") { send(200, { authenticated: seller, configured: sessions.configured || sessions.viewerConfigured, role, canRefund: role === "seller" }); return; }
      if (request.method === "POST" && path === "/api/seller/login") {
        if (!logins.take(ip)) throw new AppError(429, "Too many sign-in attempts. Try again in 15 minutes.");
        const body = z.object({ password: z.string().max(512) }).strict().parse(await json());
        const session = sessions.login(body.password);
        sessions.logout(cookie);
        response.setHeader("set-cookie", `bof_seller=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${options.origin?.startsWith("https:") ? "; Secure" : ""}`);
        send(200, { authenticated: true, role: sessions.role(session), canRefund: sessions.role(session) === "seller" }); return;
      }
      if (request.method === "POST" && path === "/api/seller/logout") {
        requireSeller(); await json(); sessions.logout(cookie);
        response.setHeader("set-cookie", `bof_seller=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${options.origin?.startsWith("https:") ? "; Secure" : ""}`);
        send(200, { authenticated: false }); return;
      }
      if (path.startsWith("/api/seller/claims")) requireSeller();
      if (request.method === "GET" && path === "/api/seller/claims") { send(200, { claims: service.listClaims().map(claimView) }); return; }
      if (request.method === "POST" && path === "/api/orders") {
        if (!checkouts.take(ip)) throw new AppError(429, "Too many checkout attempts. Try again shortly.");
        const body = z.object({ productId: z.string().max(64), image: image.optional() }).strict().parse(await json());
        send(201, await service.createOrder(body.productId, body.image)); return;
      }
      let match = /^\/api\/orders\/([a-f0-9-]{36})$/.exec(path);
      if (request.method === "GET" && match) { send(200, { order: service.getOrder(match[1], token, seller) }); return; }
      match = /^\/api\/orders\/([a-f0-9-]{36})\/capture$/.exec(path);
      if (request.method === "POST" && match) {
        z.object({}).strict().parse(await json());
        send(200, { order: await service.captureOrder(match[1], token ?? "") }); return;
      }
      match = /^\/api\/orders\/([a-f0-9-]{36})\/claims$/.exec(path);
      if (request.method === "POST" && match) {
        const body = z.object({ message: z.string().min(1).max(2000), image: image.optional(), help: z.boolean().optional() }).strict().parse(await json());
        send(201, { claim: await service.createClaim(match[1], token ?? "", body) }); return;
      }
      match = /^\/api\/claims\/([a-f0-9-]{36})$/.exec(path);
      if (request.method === "GET" && match) { send(200, { claim: claimView(service.getClaim(match[1], token, seller)) }); return; }
      match = /^\/api\/claims\/([a-f0-9-]{36})\/refresh$/.exec(path);
      if (request.method === "POST" && match) {
        z.object({}).strict().parse(await json());
        send(200, { claim: claimView(await service.refreshClaim(match[1], token, seller)) }); return;
      }
      match = /^\/api\/claims\/([a-f0-9-]{36})\/capture-sessions$/.exec(path);
      if (request.method === "POST" && match) {
        z.object({}).strict().parse(await json()); send(201, service.issueCapture(match[1], token ?? "")); return;
      }
      match = /^\/api\/claims\/([a-f0-9-]{36})\/capture-sessions\/([a-f0-9-]{36})\/frames$/.exec(path);
      if (request.method === "POST" && match) {
        const body = z.object({ orderId: z.string().max(128), nonce: z.string().max(128), frames, cameraLabel: z.string().max(200).optional() }).strict().parse(await json());
        send(201, { claim: await service.submitCapture(match[1], match[2], token ?? "", body) }); return;
      }
      match = /^\/api\/seller\/claims\/([a-f0-9-]{36})\/refund$/.exec(path);
      if (request.method === "POST" && match) {
        requireSeller();
        if (role !== "seller") throw new AppError(403, "Viewer access cannot approve refunds.");
        const body = z.object({ amountCents: z.number().int().positive().safe() }).strict().parse(await json());
        send(200, { claim: await service.refundClaim(match[1], body.amountCents, "seller") }); return;
      }
      match = /^\/api\/evidence\/([a-f0-9-]{36})$/.exec(path);
      if (request.method === "GET" && match) {
        if (activeEvidenceTransfers >= 8) throw new AppError(429, "Too many original downloads are in progress. Try again shortly.");
        activeEvidenceTransfers++;
        let active = true;
        const release = () => { if (active) { active = false; activeEvidenceTransfers--; } };
        response.once("finish", release);
        response.once("close", release);
        const original = await service.readImage(match[1], token, seller);
        response.writeHead(200, { "content-type": original.mimeType, "content-disposition": "inline" });
        response.end(original.bytes); return;
      }
      if (path.startsWith("/api/")) throw new AppError(404, "This endpoint was not found.");
      if (request.method !== "GET" && request.method !== "HEAD") throw new AppError(404, "This page was not found.");
      if (path === "/capture" || path === "/capture.js" || path === "/capture.css") {
        const file = path === "/capture" ? "capture.html" : path.slice(1);
        response.writeHead(200, { "content-type": types[extname(file)] });
        response.end(request.method === "HEAD" ? undefined : await readFile(resolve(ROOT, "public", file))); return;
      }
      if (path === "/") { response.writeHead(302, { location: "/shop" }); response.end(); return; }
      const spa = path === "/shop" || path === "/seller" || /^\/claim\/[a-f0-9-]{36}$/.test(path);
      const decoded = decodeURIComponent(path);
      const file = spa ? resolve(dist, "index.html") : resolve(dist, `.${decoded}`);
      if (file !== dist && !file.startsWith(dist + sep)) throw new AppError(404, "This page was not found.");
      const extension = extname(file);
      if (!types[extension]) throw new AppError(404, "This asset was not found.");
      try {
        if (!(await stat(file)).isFile()) throw new Error("not a file");
        const body = request.method === "HEAD" ? undefined : await readFile(file);
        response.writeHead(200, { "content-type": types[extension], ...(path.startsWith("/assets/") ? { "cache-control": "public, max-age=3600" } : {}) });
        response.end(extension === ".html" && body ? body.toString("utf8").replace("</head>", `<meta name="csp-nonce" content="${nonce}"></head>`) : body);
      } catch {
        throw new AppError(spa ? 503 : 404, spa ? "Build the app first with npm run build." : "This asset was not found.");
      }
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof AppError) send(error.status, { error: error.message });
      else if (error instanceof z.ZodError) send(400, { error: "Check the request fields and supported image limits." });
      else send(500, { error: "This request could not finish safely. Please try again or ask the seller." });
    } finally { if (mutationCounted) activeMutations--; }
  };
}
