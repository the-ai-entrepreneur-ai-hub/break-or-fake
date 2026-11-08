import type { ClaimStatus, ClaimView, OrderView } from "../lib/app-types.js";

export const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

export const isActiveClaim = (status: ClaimStatus) =>
  status === "reviewing" || status === "refund_pending" || status === "draft" || status === "awaiting_live" || status === "held";

export const pollDelay = (failures: number) => Math.min(3000 * 2 ** Math.min(failures, 4), 30000);

export function confirmedRefund(claim: Pick<ClaimView, "status" | "refund">): boolean {
  return claim.status === "refunded" && claim.refund?.status === "completed" && !!claim.refund.id;
}

export function refundableBalance(order: Pick<OrderView, "amountCents" | "refundedCents">): number {
  return Math.max(0, order.amountCents - order.refundedCents);
}

export function refundAmount(value: string, balance: number): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const cents = Math.round(Number(value) * 100);
  return Number.isSafeInteger(cents) && cents > 0 && cents <= balance ? cents : null;
}

export function capturePath(id: string, token: string): string {
  return `/capture?claim=${encodeURIComponent(id)}#token=${encodeURIComponent(token)}`;
}

export const statusLabels: Record<ClaimStatus, string> = {
  draft: "Getting started",
  awaiting_live: "Live photo requested",
  reviewing: "Reviewing evidence",
  held: "With the seller",
  refund_pending: "Refund pending",
  refunded: "Refund confirmed",
};

export function claimLabel(claim: Pick<ClaimView, "status" | "refund">): string {
  return claim.status === "refunded" && !confirmedRefund(claim) ? "Checking refund confirmation" : statusLabels[claim.status];
}

export function shortId(value: string): string {
  return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
}

export function dateTime(value: string | null): string {
  if (!value) return "Not yet synced";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function syncIsStale(lastSyncedAt: string | null, syncError: string | null, now = Date.now()): boolean {
  if (!lastSyncedAt || syncError) return true;
  const at = Date.parse(lastSyncedAt);
  return !Number.isFinite(at) || now - at > 90_000;
}
