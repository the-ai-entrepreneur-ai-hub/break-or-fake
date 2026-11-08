export type ClaimStatus = "draft" | "awaiting_live" | "reviewing" | "held" | "refund_pending" | "refunded";
export type EvidenceKind = "upload" | "live";
export interface ImageInput { mimeType: "image/jpeg" | "image/png"; data: string }
export interface ProductView {
  id: string; title: string; subtitle: string; priceCents: number;
  image: string; kind: "upload" | "live" | "judge"; available: boolean; unavailableReason?: string;
}
export interface CheckView {
  id: string; label: string; status: "pass" | "hold" | "pending" | "info"; detail: string;
}
export interface TimelineView {
  id: string; at: string; name: string; status: "complete" | "pending" | "failed" | "info"; detail: string;
}
export interface OrderView {
  id: string; productId: string; title: string; amountCents: number;
  status: "created" | "captured" | "pending" | "failed";
  paypalOrderId: string; captureId?: string; createdAt: string; isJudge: boolean;
  listingHash: string; listingImageUrl: string; tracking: string | null;
  simulatedDelivery: boolean; claimId?: string; refundedCents: number;
}
export interface EvidenceView { id: string; url: string; label: string; mimeType: string; sha256: string }
export interface ReviewerView { model: string; ok: boolean; durationMs: number; returnedModel?: string; error?: string }
export interface RefundView {
  id?: string; status: "pending" | "completed" | "failed"; amountCents: number; requestId: string;
}
export interface ClaimView {
  id: string; orderId: string; status: ClaimStatus; createdAt: string; updatedAt: string;
  message: string; amountCents: number; evidenceKind: EvidenceKind; reason: string;
  checks: CheckView[]; timeline: TimelineView[]; order: OrderView; evidence: EvidenceView[];
  reviews: ReviewerView[]; refund: RefundView | null; lastSyncedAt: string | null;
  syncError: string | null; recorded: boolean; canRefund: boolean; cameraLabel?: string;
}
export interface ConfigView {
  shopName: string; mode: "sandbox"; paypalClientId: string | null; catalog: ProductView[];
  reviewReady: boolean; sellerConfigured: boolean;
}
export interface EvaluationSummary {
  cases: number; liveCompleted: number; liveStatus: "blocked" | "incomplete" | "complete";
  recordedChecks: { passed: number; total: number }; reportDate: string | null;
  honestHolds: { count: number; total: number } | null;
  catches: { count: number; total: number } | null;
  falseRefunds: { count: number; total: number } | null;
}
