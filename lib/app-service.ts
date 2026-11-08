import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CaptureSubmission } from "./capture.js";
import { CaptureSessions } from "./capture.js";
import type { ClaimView, ConfigView, ImageInput, OrderView, ProductView, TimelineView } from "./app-types.js";
import type { StoredClaim, StoredImage, StoredOrder, StoredRefund } from "./app-records.js";
import { AppStore } from "./app-store.js";
import { AppError, equalSecret, newCapability, tokenDigest } from "./app-security.js";
import { validateImage } from "./app-images.js";
import type { PaymentFacts, PaymentProvider, RefundFacts } from "./app-payments.js";
import { cameraSuspect, decideEvidence, type EvidenceReviewer } from "./app-review.js";
import { readCredentials as readOriginalCredentials, type Credentials } from "./provenance.js";
import { listingHash } from "./listing.js";
import { gate, UPLOAD_LINE_CENTS } from "./policy.js";
import { instructionLike } from "./spike.js";

const GENERATORS = ["OpenAI", "DALL-E", "Adobe Firefly", "Midjourney", "Stable Diffusion", "Qwen-Image"];
const CATALOG = [
  { id: "linen", title: "Everyday linen", subtitle: "Upload path. Under $15, one photo is enough.", priceCents: 1200, image: "/assets/linen.jpg", kind: "upload" },
  { id: "mug", title: "The everyday mug", subtitle: "Live path. Above $15, three live photos with a handwritten code.", priceCents: 3200, image: "/assets/mug.jpg", kind: "live" },
  { id: "judge-cup", title: "The paper-cup test", subtitle: "Judge path. Your own cup photo becomes the listing. Buy it, tear it, claim it.", priceCents: 2500, image: "/assets/cup.jpg", kind: "judge" },
] as const;
interface Options {
  store: AppStore; payments: PaymentProvider; reviewer: EvidenceReviewer;
  listingPaths?: Record<string, string>; dailyBudget?: number; now?: () => number;
  readCredentials?: (bytes: Buffer, mimeType: string) => Promise<Credentials>;
}

export class AppService {
  readonly store: AppStore;
  readonly payments: PaymentProvider;
  readonly reviewer: EvidenceReviewer;
  private readonly now: () => number;
  private readonly provenance: (bytes: Buffer, mimeType: string) => Promise<Credentials>;
  private readonly sessions: CaptureSessions;
  private readonly sessionClaims = new Map<string, { claimId: string; expires: number }>();
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly captures = new Map<string, Promise<OrderView>>();
  private readonly creations = new Map<string, Promise<ClaimView>>();
  private readonly refunds = new Map<string, Promise<ClaimView>>();
  private readonly refreshes = new Map<string, Promise<ClaimView>>();
  private readonly owner = randomUUID();

  constructor(private readonly options: Options) {
    this.store = options.store; this.payments = options.payments; this.reviewer = options.reviewer;
    this.now = options.now ?? Date.now;
    this.provenance = options.readCredentials ?? ((bytes, mime) => readOriginalCredentials(bytes, mime, GENERATORS));
    this.sessions = new CaptureSessions(this.now);
    for (const claim of this.store.all<StoredClaim>("claims")) {
      if (claim.status === "reviewing") {
        claim.status = "held"; claim.reason = "The review was interrupted. The seller will take a look.";
        this.event(claim, "Review interrupted", "failed", "No automatic approval was recovered after restart.");
      }
    }
  }
  private date(): string { return new Date(this.now()).toISOString(); }
  private required<T>(kind: string, id: string): T {
    const value = this.store.get<T>(kind, id);
    if (!value) throw new AppError(404, "This record was not found.");
    return value;
  }
  private order(id: string): StoredOrder { return this.required("orders", id); }
  private claim(id: string): StoredClaim { return this.required("claims", id); }
  private access(order: StoredOrder, token?: string, seller = false): void {
    if (!seller && (!token || token.length > 128 || !equalSecret(order.tokenHash, tokenDigest(token)))) throw new AppError(403, "This order needs its private access link.");
  }
  private event(claim: StoredClaim, name: string, status: TimelineView["status"], detail: string): void {
    claim.updatedAt = this.date();
    claim.timeline.push({ id: randomUUID(), at: this.date(), name, status, detail });
    claim.timeline = claim.timeline.slice(-200);
    this.store.put("claims", claim.id, claim);
  }
  private trackJob(promise: Promise<unknown>): void {
    this.jobs.add(promise);
    void promise.finally(() => this.jobs.delete(promise)).catch(() => {});
  }
  async idle(): Promise<void> {
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }

  config(sellerConfigured = false): ConfigView {
    const catalog: ProductView[] = CATALOG.map((item) => {
      const photo = item.kind === "judge" || !!(this.options.listingPaths?.[item.id] && existsSync(this.options.listingPaths[item.id]));
      const available = this.payments.ready && photo;
      const pagePhoto = existsSync(new URL(`../dist${item.image}`, import.meta.url)) || existsSync(new URL(`../public${item.image}`, import.meta.url));
      return { ...item, image: pagePhoto ? item.image : "", available, ...(!available ? { unavailableReason: !this.payments.ready ? "PayPal sandbox checkout is not configured." : "The seller's original listing photo is not configured yet." } : {}) };
    });
    return { shopName: "Sunday Supply", mode: "sandbox", paypalClientId: this.payments.clientId, catalog, reviewReady: this.reviewer.ready, sellerConfigured };
  }
  private orderView(order: StoredOrder): OrderView {
    const { tokenHash, payerId, listingImageId, deliveredAt, ...publicOrder } = order;
    return { ...publicOrder, listingImageUrl: `/api/evidence/${listingImageId}` };
  }
  getOrder(id: string, token?: string, seller = false): OrderView {
    const order = this.order(id); this.access(order, token, seller);
    return this.orderView(order);
  }
  getClaim(id: string, token?: string, seller = false): ClaimView {
    const claim = this.claim(id), order = this.order(claim.orderId); this.access(order, token, seller);
    return {
      id: claim.id, orderId: claim.orderId, status: claim.status, createdAt: claim.createdAt,
      updatedAt: claim.updatedAt, message: claim.message, amountCents: claim.amountCents,
      evidenceKind: claim.evidenceKind, cameraLabel: claim.cameraLabel, reason: claim.reason, checks: claim.checks, timeline: claim.timeline,
      order: this.orderView(order), evidence: claim.imageIds.flatMap((id) => {
        const image = this.store.get<StoredImage>("images", id);
        return image ? [{ id, url: `/api/evidence/${id}`, label: image.label, mimeType: image.mimeType, sha256: image.sha256 }] : [];
      }), reviews: claim.reviews,
      refund: claim.refund ? { id: claim.refund.id, status: claim.refund.status, amountCents: claim.refund.amountCents, requestId: claim.refund.requestId } : null,
      lastSyncedAt: claim.lastSyncedAt, syncError: claim.syncError, recorded: false,
      canRefund: seller && ["held", "draft", "awaiting_live"].includes(claim.status) && !claim.refund && order.refundedCents < order.amountCents,
    };
  }
  listClaims(): ClaimView[] {
    return this.store.all<StoredClaim>("claims").reverse().map((claim) => this.getClaim(claim.id, undefined, true));
  }
  private async saveImage(orderId: string, input: ImageInput, label: string): Promise<StoredImage> {
    return (await this.saveImages(orderId, [{ input, label }]))[0];
  }
  private async saveImages(orderId: string, inputs: { input: ImageInput; label: string }[]): Promise<StoredImage[]> {
    const validated = await Promise.all(inputs.map(({ input }) => validateImage(input)));
    const images = await Promise.all(validated.map(async (value, index): Promise<StoredImage> => {
      const credentials = await this.provenance(value.bytes, value.mimeType);
      return { id: randomUUID(), orderId, mimeType: value.mimeType, sha256: value.sha256,
        createdAt: this.date(), label: inputs[index].label, credentials: { status: credentials.status, generated: credentials.generated } };
    }));
    const release = this.store.reserveImages(validated.map((value) => value.bytes.length));
    try {
      for (const [index, image] of images.entries()) {
        await writeFile(join(this.store.directory, "evidence", image.id), validated[index].bytes, { flag: "wx", mode: 0o600 });
        this.store.put("images", image.id, image);
      }
      return images;
    } catch (error) {
      for (const image of images) {
        await unlink(join(this.store.directory, "evidence", image.id)).catch((failure: NodeJS.ErrnoException) => { if (failure.code !== "ENOENT") throw failure; });
        this.store.remove("images", image.id);
      }
      throw error;
    } finally { release(); }
  }
  async readImage(id: string, token?: string, seller = false) {
    const image = this.required<StoredImage>("images", id), order = this.order(image.orderId);
    this.access(order, token, seller);
    return { bytes: await readFile(join(this.store.directory, "evidence", image.id)), mimeType: image.mimeType };
  }
  private async imageInput(id: string): Promise<ImageInput> {
    const image = this.required<StoredImage>("images", id);
    return { mimeType: image.mimeType, data: (await readFile(join(this.store.directory, "evidence", image.id))).toString("base64") };
  }
  async createOrder(productId: string, image?: ImageInput): Promise<{ order: OrderView; token: string; paypalOrderId: string }> {
    const release = this.store.reserveOrder();
    try { return await this.newOrder(productId, image); }
    finally { release(); }
  }
  private async newOrder(productId: string, image?: ImageInput): Promise<{ order: OrderView; token: string; paypalOrderId: string }> {
    const product = CATALOG.find((item) => item.id === productId);
    if (!product) throw new AppError(400, "Unknown product.");
    if (!this.payments.ready) throw new AppError(503, "PayPal sandbox checkout is not configured.");
    if (product.kind !== "judge") {
      const path = this.options.listingPaths?.[product.id];
      if (!path || !existsSync(path)) throw new AppError(503, "The seller's original listing photo is not configured.");
      const bytes = await readFile(path);
      image = { mimeType: bytes[0] === 0x89 ? "image/png" : "image/jpeg", data: bytes.toString("base64") };
    }
    if (!image) throw new AppError(400, "Add an original photo of your intact paper cup first.");
    const id = randomUUID(), token = newCapability();
    const listing = await this.saveImage(id, image, "Original listing");
    const bytes = await readFile(join(this.store.directory, "evidence", listing.id));
    const order: StoredOrder = {
      id, tokenHash: tokenDigest(token), productId, title: product.title, amountCents: product.priceCents,
      listingHash: listingHash(bytes, product.title, (product.priceCents / 100).toFixed(2)), listingImageId: listing.id,
      isJudge: product.kind === "judge", createdAt: this.date(), status: "created", paypalOrderId: "",
      refundedCents: 0, tracking: null, simulatedDelivery: false,
    };
    this.store.put("orders", id, order);
    try {
      const created = await this.payments.createOrder({ title: order.title, amountCents: order.amountCents, listingHash: order.listingHash, requestId: `order_${id}` });
      order.paypalOrderId = created.id; this.store.put("orders", id, order);
      return { order: this.orderView(order), token, paypalOrderId: created.id };
    } catch {
      order.status = "failed"; this.store.put("orders", id, order);
      throw new AppError(502, "PayPal could not create the sandbox order. No purchase has been confirmed.");
    }
  }
  private verifyFacts(order: StoredOrder, facts: PaymentFacts): void {
    if (facts.orderId !== order.paypalOrderId || facts.listingHash !== order.listingHash ||
        facts.currency !== "USD" || facts.amountCents !== order.amountCents ||
        (order.captureId && facts.captureId !== order.captureId)) throw new AppError(409, "PayPal order facts do not match the original listing.");
  }
  private applyFacts(order: StoredOrder, facts: PaymentFacts): void {
    this.verifyFacts(order, facts);
    order.captureId = facts.captureId; order.payerId = facts.payerId;
    order.refundedCents = facts.refundedCents;
    if (facts.tracking) order.tracking = facts.tracking;
    if (facts.deliveredAt) order.deliveredAt = facts.deliveredAt;
    if (facts.captureId && ["COMPLETED", "REFUNDED", "PARTIALLY_REFUNDED"].includes(facts.status)) {
      order.status = "captured";
      if (order.isJudge) { order.simulatedDelivery = true; order.deliveredAt ??= this.date(); }
    } else order.status = "pending";
    this.store.put("orders", order.id, order);
  }
  async captureOrder(id: string, token: string): Promise<OrderView> {
    const order = this.order(id); this.access(order, token);
    if (order.status === "captured") return this.orderView(order);
    const existing = this.captures.get(id);
    if (existing) return existing;
    const promise = (async () => {
      try {
        let facts = await this.payments.getOrder(order.paypalOrderId);
        if (!facts.captureId) facts = await this.payments.captureOrder(order.paypalOrderId, `capture_${id}`);
        this.applyFacts(order, facts);
        if (order.status === "captured" && this.payments.track && !order.tracking) {
          this.trackJob(this.payments.track(order.paypalOrderId, order.captureId!).then((tracking) => {
            const current = this.order(id); current.tracking = tracking; this.store.put("orders", id, current);
          }).catch(() => {}));
        }
        return this.orderView(order);
      } catch (error) {
        order.status = "pending"; this.store.put("orders", id, order);
        if (error instanceof AppError) throw error;
        throw new AppError(502, "PayPal capture is not confirmed yet. Retry this order, not a new checkout.");
      } finally { this.captures.delete(id); }
    })();
    this.captures.set(id, promise); return promise;
  }
  async createClaim(orderId: string, token: string, input: { message: string; image?: ImageInput; help?: boolean }): Promise<ClaimView> {
    const order = this.order(orderId); this.access(order, token);
    if (order.status !== "captured" || !order.captureId) throw new AppError(409, "A completed sandbox purchase is required.");
    if (this.creations.has(orderId)) return this.creations.get(orderId)!;
    if (order.claimId) {
      const promise = this.updateOpenClaim(order.claimId, token, input).finally(() => this.creations.delete(orderId));
      this.creations.set(orderId, promise); return promise;
    }
    const promise = this.newClaim(order, token, input).finally(() => this.creations.delete(orderId));
    this.creations.set(orderId, promise); return promise;
  }
  private async updateOpenClaim(id: string, token: string, input: { message: string; image?: ImageInput; help?: boolean }): Promise<ClaimView> {
    const claim = this.claim(id);
    if (claim.refund || !["draft", "held", "awaiting_live"].includes(claim.status) || (!input.image && !input.help)) return this.getClaim(id, token);
    if (!this.store.acquire(`evidence:${id}`, this.owner, this.now(), 120_000)) throw new AppError(409, "This claim is already receiving evidence.");
    try {
      if (input.help) {
        claim.status = "held"; claim.approvedBy = null; claim.reason = "The seller will take a look. No camera is required.";
        this.event(claim, "Seller help requested", "info", "The buyer asked for help with an existing claim.");
      } else if (input.image) {
        if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 2000) throw new AppError(400, "Describe the damage in up to 2,000 characters.");
        const validated = await validateImage(input.image);
        if (claim.imageIds.some((imageId) => this.store.get<StoredImage>("images", imageId)?.sha256 === validated.sha256)) return this.getClaim(id, token);
        const image = await this.saveImage(claim.orderId, input.image, "Uploaded damage photo");
        claim.imageIds = [image.id]; claim.evidenceKind = "upload"; claim.message = input.message.trim();
        claim.approvedBy = null; claim.checks = []; claim.reviews = [];
        if (instructionLike(claim.message) || image.credentials.generated || !["missing", "present"].includes(image.credentials.status)) {
          claim.status = "held"; claim.reason = "This evidence needs a seller review.";
        } else if (claim.amountCents > UPLOAD_LINE_CENTS) {
          claim.status = "awaiting_live"; claim.reason = "One more step: take a fresh live photo with your handwritten code.";
        } else { claim.status = "reviewing"; claim.reason = "Your photo is being reviewed."; }
        this.event(claim, "New evidence received", "complete", "The existing claim was updated without creating another refundable case.");
        if (claim.status === "reviewing") this.trackJob(this.reviewClaim(id));
      }
      return this.getClaim(id, token);
    } finally { this.store.release(`evidence:${id}`, this.owner); }
  }
  private async newClaim(order: StoredOrder, token: string, input: { message: string; image?: ImageInput; help?: boolean }): Promise<ClaimView> {
    if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 2000) throw new AppError(400, "Describe the damage in one or two sentences (up to 2,000 characters).");
    if (order.refundedCents >= order.amountCents) throw new AppError(409, "This purchase has already been refunded.");
    const image = input.image ? await this.saveImage(order.id, input.image, "Uploaded damage photo") : undefined;
    const claim: StoredClaim = {
      id: randomUUID(), orderId: order.id, status: "draft", createdAt: this.date(), updatedAt: this.date(),
      message: input.message.trim(), amountCents: order.amountCents - order.refundedCents, evidenceKind: "upload",
      imageIds: image ? [image.id] : [], reason: "Add a photo or ask the seller for help.", checks: [], timeline: [],
      reviews: [], approvedBy: null, refund: null, lastSyncedAt: null, lastSyncAttempt: 0, syncError: null, reviewAttempt: 0,
    };
    order.claimId = claim.id; this.store.put("orders", order.id, order);
    if (input.help) { claim.status = "held"; claim.reason = "The seller will take a look. No camera is required."; }
    else if (instructionLike(claim.message) || (image && (image.credentials.generated || !["missing", "present"].includes(image.credentials.status)))) {
      claim.status = "held"; claim.reason = "This evidence needs a seller review.";
    } else if (claim.amountCents > UPLOAD_LINE_CENTS) {
      claim.status = "awaiting_live"; claim.reason = "One more step: take a fresh live photo with your handwritten code.";
    } else if (image) claim.status = "reviewing";
    this.event(claim, "Claim received", "complete", "The buyer opened a damage claim. No automatic denial.");
    if (claim.status === "reviewing") this.trackJob(this.reviewClaim(claim.id));
    return this.getClaim(claim.id, token);
  }
  issueCapture(claimId: string, token: string) {
    const claim = this.claim(claimId), order = this.order(claim.orderId); this.access(order, token);
    if (!["draft", "held", "awaiting_live"].includes(claim.status) || claim.refund) throw new AppError(409, "This claim is already being reviewed or is complete.");
    for (const [id, session] of this.sessionClaims) if (session.expires <= this.now()) this.sessionClaims.delete(id);
    const session = this.sessions.issue(order.id);
    this.sessionClaims.set(session.id, { claimId: claim.id, expires: session.expiresAt });
    return session;
  }
  async submitCapture(claimId: string, sessionId: string, token: string, submission: CaptureSubmission & { cameraLabel?: string }): Promise<ClaimView> {
    const claim = this.claim(claimId), order = this.order(claim.orderId); this.access(order, token);
    if (!["draft", "held", "awaiting_live"].includes(claim.status) || claim.refund) throw new AppError(409, "This claim is already being reviewed or is complete.");
    if (this.sessionClaims.get(sessionId)?.claimId !== claimId) throw new AppError(400, "Unknown capture session for this claim.");
    if (!this.store.acquire(`evidence:${claimId}`, this.owner, this.now(), 120_000)) throw new AppError(409, "This claim is already receiving capture evidence.");
    try {
      const receivedAt = this.now();
      let captured: ReturnType<CaptureSessions["consume"]>;
      try { captured = this.sessions.consume(sessionId, submission); }
      catch (error) { throw new AppError(400, error instanceof Error ? error.message : "Invalid capture session."); }
      this.sessionClaims.delete(sessionId);
      const images = await this.saveImages(order.id, submission.frames.map((frame, index) =>
        ({ input: frame as ImageInput, label: `Live frame ${index + 1}` })));
      claim.imageIds = images.map((image) => image.id); claim.evidenceKind = "live";
      claim.captureCode = captured.session.code; claim.status = "reviewing"; claim.reason = "Your three frames are being reviewed.";
      claim.cameraLabel = submission.cameraLabel;
      claim.checks = [{ id: "camera", label: "Camera source", status: cameraSuspect(claim.cameraLabel) ? "hold" : "pass",
        detail: "Browser-reported camera name. A modified page can lie about this." }];
      claim.captureSession = { ...captured.session, receivedAt, hashes: captured.hashes };
      this.event(claim, "Live capture received", "complete", "Fresh order-bound session; three distinct frames received before expiry.");
      this.trackJob(this.reviewClaim(claim.id));
      return this.getClaim(claim.id, token);
    } finally { this.store.release(`evidence:${claimId}`, this.owner); }
  }
  private async reviewClaim(id: string): Promise<void> {
    let claim = this.claim(id);
    if (!this.store.acquire(`review:${id}`, this.owner, this.now(), 180_000)) return;
    try {
      const budgetId = this.date().slice(0, 10), used = this.store.get<number>("review-budget", budgetId) ?? 0;
      if (!this.reviewer.ready) throw new Error("Photo reviewers are not configured. The seller will take a look.");
      if (used >= (this.options.dailyBudget ?? 100)) throw new Error("Today's review budget is used. The seller will take a look.");
      this.store.put("review-budget", budgetId, used + 1);
      claim.reviewAttempt++; this.event(claim, "Review started", "pending", "Independent photo reviewers have no payment tools.");
      const order = this.order(claim.orderId);
      const facts = await this.payments.getOrder(order.paypalOrderId);
      this.applyFacts(order, facts);
      const listing = this.required<StoredImage>("images", order.listingImageId);
      const originals = claim.imageIds.map((imageId) => this.required<StoredImage>("images", imageId));
      const credentials = [listing.credentials, ...originals.map((image) => image.credentials)];
      const result = await this.reviewer.review({
        listing: await this.imageInput(order.listingImageId), images: await Promise.all(claim.imageIds.map((imageId) => this.imageInput(imageId))),
        kind: claim.evidenceKind, code: claim.captureCode, message: claim.message, title: order.title, credentials,
        facts: { captureStatus: facts.status, amountCents: facts.amountCents, currency: facts.currency,
          tracking: order.tracking, simulatedDelivery: order.simulatedDelivery, listingBound: facts.listingHash === order.listingHash },
      });
      claim = this.claim(id); claim.checks = [...claim.checks.filter(check => check.id === "camera"), ...result.checks]; claim.reviews = result.reviews;
      const payerRefunds90d = this.store.all<StoredClaim>("claims").filter((previous) => {
        if (previous.id === id || previous.refund?.status !== "completed" || previous.refund.approvedBy !== "policy" ||
            Date.parse(previous.refund.createdAt) < this.now() - 90 * 24 * 60 * 60_000) return false;
        return !!order.payerId && this.order(previous.orderId).payerId === order.payerId;
      }).length;
      const eligible = !!order.deliveredAt && Date.parse(order.deliveredAt) <= this.now() &&
        this.now() - Date.parse(order.deliveredAt) <= 30 * 24 * 60 * 60_000 && (!!order.payerId || order.isJudge);
      const decision = decideEvidence({ amountCents: claim.amountCents, evidence: claim.evidenceKind,
        message: claim.message, credentials, clear: result.clear, listingBound: facts.listingHash === order.listingHash,
        eligible, payerRefunds90d, judge: order.isJudge, cameraSuspect: claim.evidenceKind === "live" && cameraSuspect(claim.cameraLabel) });
      claim.checks.unshift(
        { id: "binding", label: "Order-bound listing", status: "pass", detail: "The original photo, title, and price match PayPal custom_id." },
        { id: "provenance", label: "Original-file credentials", status: credentials.some((c) => c.generated || !["missing", "present"].includes(c.status)) ? "hold" : "info",
          detail: credentials.every((c) => c.status === "missing") ? "No Content Credentials. This is not proof of authenticity." : "Original bytes checked locally before rendering." },
        { id: "eligibility", label: "Claim eligibility", status: eligible ? "pass" : "hold", detail: order.isJudge ? "Simulated judge delivery; sandbox demo only." : "Based on merchant-reported delivery and the claim window." },
      );
      claim.approvedBy = decision.approvedBy; claim.reason = decision.reason;
      claim.status = decision.status === "approved" ? "held" : decision.status;
      this.event(claim, "Review complete", decision.approvedBy ? "complete" : "info", decision.reason);
      if (decision.approvedBy) await this.refundClaim(id, claim.amountCents, "policy");
    } catch (error) {
      claim = this.claim(id);
      if (!claim.refund) {
        claim.status = "held"; claim.approvedBy = null;
        claim.reason = error instanceof Error && /not configured|budget/.test(error.message) ? error.message : "The review could not finish safely. The seller will take a look.";
        this.event(claim, "Review held", "failed", claim.reason);
      }
    } finally { this.store.release(`review:${id}`, this.owner); }
  }
  async refundClaim(id: string, amountCents: number, approvedBy: "policy" | "seller"): Promise<ClaimView> {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new AppError(400, "Refund amount must be positive whole cents.");
    const existing = this.refunds.get(id);
    if (existing) return existing;
    const promise = this.runRefund(id, amountCents, approvedBy).finally(() => this.refunds.delete(id));
    this.refunds.set(id, promise); return promise;
  }
  private async runRefund(id: string, amountCents: number, approvedBy: "policy" | "seller"): Promise<ClaimView> {
    let claim = this.claim(id);
    if (claim.refund && claim.refund.amountCents !== amountCents) throw new AppError(409, "An existing refund must be reconciled before changing its amount.");
    if (claim.refund?.status === "completed") return this.getClaim(id, undefined, true);
    if (claim.status === "reviewing") throw new AppError(409, "Wait for the active review before authorizing a refund.");
    if (approvedBy === "policy" && claim.approvedBy !== "policy") throw new AppError(403, "Policy has not approved this claim.");
    if (!this.store.acquire(`refund:${id}`, this.owner, this.now(), 120_000)) return this.getClaim(id, undefined, true);
    try {
      const order = this.order(claim.orderId), facts = await this.payments.getOrder(order.paypalOrderId);
      this.applyFacts(order, facts);
      if (claim.refund) { await this.reconcileRefund(claim, order, facts); return this.getClaim(id, undefined, true); }
      try {
        gate({ claimId: id, approvedBy, evidence: claim.evidenceKind }, { action: "refund", amountCents, capturedCents: facts.amountCents, refundedCents: facts.refundedCents });
      } catch (error) {
        this.event(claim, "Refund gate refused", "failed", error instanceof Error ? error.message : "Policy refused the refund.");
        throw new AppError(409, error instanceof Error ? error.message : "Policy refused the refund.");
      }
      if (!facts.captureId || !["COMPLETED", "PARTIALLY_REFUNDED"].includes(facts.status)) throw new AppError(409, "PayPal has not confirmed a refundable capture.");
      const refund: StoredRefund = {
        requestId: `refund_${id}`, status: "pending", amountCents, approvedBy, createdAt: this.date(),
        baselineRefundIds: facts.refunds.map((r) => r.id), baselineRefundedCents: facts.refundedCents,
      };
      claim.refund = refund; claim.approvedBy = approvedBy; claim.status = "refund_pending";
      claim.reason = "The refund is waiting for PayPal confirmation.";
      this.event(claim, "Refund authorized", "pending", `${approvedBy === "seller" ? "Seller" : "Policy"} approval passed the payment gate. Stable request ID: ${refund.requestId}.`);
      await this.sendRefund(claim, order, facts);
      return this.getClaim(id, undefined, true);
    } finally { this.store.release(`refund:${id}`, this.owner); }
  }
  private async sendRefund(claim: StoredClaim, order: StoredOrder, facts: PaymentFacts): Promise<void> {
    const operation = claim.refund!;
    try {
      gate({ claimId: claim.id, approvedBy: operation.approvedBy, evidence: claim.evidenceKind },
        { action: "refund", amountCents: operation.amountCents, capturedCents: facts.amountCents, refundedCents: facts.refundedCents });
      const result = await this.payments.refund(order.captureId!, operation.amountCents, operation.requestId);
      operation.id = result.id; this.store.put("claims", claim.id, claim);
      this.finishRefund(claim, order, await this.payments.getRefund(result.id));
    } catch {
      claim.status = "refund_pending"; claim.reason = "PayPal has not confirmed the refund yet. We are checking the same operation, not paying twice.";
      this.event(claim, "Refund confirmation pending", "pending", "The original request ID is retained for reconciliation.");
    }
  }
  private finishRefund(claim: StoredClaim, order: StoredOrder, result: RefundFacts): void {
    const operation = claim.refund!;
    if (result.amountCents !== operation.amountCents || result.currency !== "USD" || (operation.id && operation.id !== result.id)) throw new Error("Refund facts do not match.");
    operation.id = result.id;
    if (result.status === "COMPLETED") {
      operation.status = "completed"; claim.status = "refunded"; claim.closedAt = this.date();
      claim.reason = "Your refund is confirmed by PayPal.";
      order.refundedCents = Math.max(order.refundedCents, operation.baselineRefundedCents + operation.amountCents);
      this.store.put("orders", order.id, order);
      this.event(claim, "PayPal refund confirmed", "complete", `Refund ${result.id} · $${(result.amountCents / 100).toFixed(2)} USD.`);
    } else if (["FAILED", "CANCELLED", "DENIED"].includes(result.status)) {
      operation.status = "failed"; claim.status = "held"; claim.reason = "PayPal could not complete the refund. The seller will take a look.";
      this.event(claim, "Refund not completed", "failed", "No completed refund is claimed.");
    } else {
      claim.status = "refund_pending"; claim.reason = "PayPal is processing your refund.";
      this.event(claim, "PayPal refund processing", "pending", `Refund ${result.id} is not completed.`);
    }
  }
  private async reconcileRefund(claim: StoredClaim, order: StoredOrder, facts: PaymentFacts): Promise<void> {
    const operation = claim.refund!;
    if (operation.id) { this.finishRefund(claim, order, await this.payments.getRefund(operation.id)); return; }
    const added = facts.refunds.filter((r) => !operation.baselineRefundIds.includes(r.id));
    if (added.length === 1 && added[0].amountCents === operation.amountCents) {
      this.finishRefund(claim, order, await this.payments.getRefund(added[0].id)); return;
    }
    if (facts.refundedCents !== operation.baselineRefundedCents || added.length) {
      claim.reason = "The capture balance changed. The seller must reconcile this pending refund.";
      this.event(claim, "Balance reconciliation needed", "pending", "No second refund was sent."); return;
    }
    // shortcut: retry only within five hours; older unknown operations need manual reconciliation.
    if (this.now() - Date.parse(operation.createdAt) >= 5 * 60 * 60_000) {
      claim.reason = "This pending refund needs seller reconciliation in PayPal.";
      this.store.put("claims", claim.id, claim); return;
    }
    await this.sendRefund(claim, order, facts);
  }
  async refreshClaim(id: string, token?: string, seller = false): Promise<ClaimView> {
    this.getClaim(id, token, seller);
    if (this.refreshes.has(id)) return this.refreshes.get(id)!;
    const claim = this.claim(id);
    if (claim.lastSyncAttempt && this.now() - claim.lastSyncAttempt < 60_000) return this.getClaim(id, token, seller);
    claim.lastSyncAttempt = this.now(); this.store.put("claims", id, claim);
    const promise = (async () => {
      try {
        const order = this.order(claim.orderId), facts = await this.payments.getOrder(order.paypalOrderId);
        this.applyFacts(order, facts);
        const current = this.claim(id);
        if (current.refund?.status === "pending" && this.store.acquire(`refund:${id}`, this.owner, this.now(), 120_000)) {
          try { await this.reconcileRefund(current, order, facts); }
          finally { this.store.release(`refund:${id}`, this.owner); }
        }
        const updated = this.claim(id); updated.lastSyncedAt = this.date(); updated.syncError = null;
        this.store.put("claims", id, updated);
      } catch {
        const updated = this.claim(id); updated.syncError = "PayPal refresh failed. The last confirmed state is shown.";
        this.store.put("claims", id, updated);
      } finally { this.refreshes.delete(id); }
      return this.getClaim(id, token, seller);
    })();
    this.refreshes.set(id, promise); return promise;
  }
  async pollActive(): Promise<void> {
    for (const claim of this.store.all<StoredClaim>("claims")) {
      if (claim.status !== "refunded" && claim.status !== "reviewing") await this.refreshClaim(claim.id, undefined, true);
    }
  }
  async cleanup(): Promise<number> {
    let count = 0;
    for (const claim of this.store.all<StoredClaim>("claims")) {
      if (!claim.closedAt || claim.evidenceDeleted || this.now() - Date.parse(claim.closedAt) < 30 * 24 * 60 * 60_000) continue;
      for (const image of this.store.all<StoredImage>("images").filter((row) => row.orderId === claim.orderId)) {
        await unlink(join(this.store.directory, "evidence", image.id)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        this.store.remove("images", image.id); count++;
      }
      claim.evidenceDeleted = true; this.event(claim, "Evidence deleted", "info", "Original images removed 30 days after closure.");
    }
    return count;
  }
}
