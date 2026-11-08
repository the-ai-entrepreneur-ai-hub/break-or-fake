import type { CheckView, ClaimStatus, EvidenceKind, ReviewerView, TimelineView, RefundView } from "./app-types.js";
import type { Credentials } from "./provenance.js";

export interface StoredImage {
  id: string; orderId: string; mimeType: "image/jpeg" | "image/png"; sha256: string;
  createdAt: string; label: string; credentials: Pick<Credentials, "status" | "generated">;
}
export interface StoredOrder {
  id: string; tokenHash: string; productId: string; title: string; amountCents: number;
  listingHash: string; listingImageId: string; isJudge: boolean; createdAt: string;
  status: "created" | "captured" | "pending" | "failed"; paypalOrderId: string;
  captureId?: string; payerId?: string; refundedCents: number; tracking: string | null;
  deliveredAt?: string; simulatedDelivery: boolean; claimId?: string;
}
export interface StoredRefund extends RefundView {
  approvedBy: "policy" | "seller"; createdAt: string; baselineRefundIds: string[];
  baselineRefundedCents: number;
}
export interface StoredClaim {
  id: string; orderId: string; status: ClaimStatus; createdAt: string; updatedAt: string;
  closedAt?: string; message: string; amountCents: number; evidenceKind: EvidenceKind;
  imageIds: string[]; reason: string; checks: CheckView[]; timeline: TimelineView[];
  reviews: ReviewerView[]; approvedBy: "policy" | "seller" | null; refund: StoredRefund | null;
  lastSyncedAt: string | null; lastSyncAttempt: number; syncError: string | null;
  captureCode?: string; cameraLabel?: string; reviewAttempt: number; evidenceDeleted?: boolean;
  captureSession?: { id: string; nonce: string; code: string; issuedAt: number; expiresAt: number; receivedAt: number; hashes: string[] };
}
