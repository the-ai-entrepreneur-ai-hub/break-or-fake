import { type FormEvent, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowRight, Check, CheckCircle2, ChevronRight, Clock3, FileImage, Fingerprint, LockKeyhole, LogOut, MessageCircle, ShieldCheck, SlidersHorizontal } from "lucide-react";
import type { ClaimView, ConfigView } from "../lib/app-types";
import { api, ApiError, errorMessage } from "./api";
import { EvidenceChecks, EvidenceImage, Loading, Notice, OrderSummary, PolicyCard, RefreshButton, StatusBadge, Timeline } from "./components";
import { confirmedRefund, dateTime, money, refundableBalance, refundAmount, shortId } from "./domain";
import { usePolling } from "./hooks";

type SellerSession = { authenticated: boolean; configured: boolean; role: "seller" | "viewer" | null; canRefund: boolean };

export default function Seller() {
  const session = usePolling<SellerSession>("seller-session", (signal) => api("/api/seller/session", { signal }), (value) => value.authenticated);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function signedOut() {
    session.setData({ authenticated: false, configured: true, role: null, canRefund: false });
  }
  async function login(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await api("/api/seller/login", { method: "POST", body: { password } });
      setPassword("");
      await session.refresh();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true); setError("");
    try { await api("/api/seller/logout", { method: "POST", body: {} }); signedOut(); }
    catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) signedOut();
      else setError(errorMessage(cause));
    } finally { setBusy(false); }
  }
  return <main id="main" className="seller-page">
    <header className="page-heading seller-heading"><div><h1>Seller desk</h1><p>Every claim with its evidence, the checks, and the refund gate.</p></div>{session.data?.authenticated && <div className="seller-access"><span className="session-label"><CheckCircle2 size={15} />{session.data.role === "viewer" ? "Viewer · read only" : "Seller"}</span><button className="button secondary small-button" onClick={() => void logout()} disabled={busy}><LogOut size={14} />Sign out</button></div>}</header>
    {(session.error || error) && <Notice kind="error">{error || session.error}</Notice>}
    {session.loading && !session.data ? <Loading>Checking access…</Loading> : !session.data?.authenticated ? <section className="panel login-panel"><div><h2>Sign in</h2><p>Judges: use the viewer password from the Devpost submission.</p><p>Sellers approve refunds with their own password.</p></div><form onSubmit={(event) => void login(event)}><label htmlFor="seller-password">Password</label><input id="seller-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={busy} /><button className="button primary" disabled={busy || !password}>{busy ? "Signing in…" : "Open the queue"}<ArrowRight size={14} /></button></form></section> : <ClaimQueue key={session.data.role} canRefund={session.data.canRefund} onUnauthorized={signedOut} />}
  </main>;
}

function ClaimQueue({ canRefund, onUnauthorized }: { canRefund: boolean; onUnauthorized: () => void }) {
  const config = usePolling<ConfigView>("seller-config", (signal) => api("/api/config", { signal }));
  const queue = usePolling<{ claims: ClaimView[] }>("seller-queue", async (signal) => {
    try { return await api("/api/seller/claims", { signal }); }
    catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      throw cause;
    }
  }, () => true);
  const [selected, setSelected] = useState("");
  const claims = queue.data?.claims ?? [];
  const [filter, setFilter] = useState<"all" | "review">("all");
  const displayed = filter === "all" ? claims : claims.filter((item) => item.status === "held" || item.status === "awaiting_live");
  const claim = displayed.find((item) => item.id === selected) ?? displayed[0];
  async function refreshCase() {
    if (!claim) return;
    try {
      const result = await api<{ claim: ClaimView }>(`/api/claims/${encodeURIComponent(claim.id)}/refresh`, { method: "POST", body: {} });
      updateClaim(result.claim);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      throw cause;
    }
  }
  function updateClaim(next: ClaimView) {
    queue.setData((current) => current ? { claims: current.claims.map((item) => item.id === next.id ? next : item) } : { claims: [next] });
  }
  return <>{config.data && !config.data.reviewReady && <Notice>Reviewers are not configured. Claims will be held for the seller.</Notice>}{config.data && !config.data.sellerConfigured && <Notice>Seller approval is not configured.</Notice>}<div className="seller-workspace">
    <aside className="queue-panel panel"><div className="section-label"><h3>Claim queue</h3><span className="queue-count mono">{claims.length.toString().padStart(2, "0")}</span></div><div className="queue-filters"><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All claims</button><button className={filter === "review" ? "active" : ""} onClick={() => setFilter("review")}>Needs review</button><SlidersHorizontal size={13} /></div>
      {queue.loading && !queue.data ? <Loading>Opening the queue…</Loading> : queue.error && !queue.data ? <Notice kind="error">{queue.error}</Notice> : displayed.length ? <ul className="claim-queue">{displayed.map((item) => <li key={item.id}><button className={claim?.id === item.id ? "active" : ""} onClick={() => setSelected(item.id)} aria-pressed={claim?.id === item.id}><div className="queue-item-top"><span className="mono">{shortId(item.id)}</span><span>{money(item.amountCents)}</span></div><strong>{item.order.title}</strong><p>{item.message || item.reason}</p><div className="queue-item-bottom"><StatusBadge claim={item} /><ChevronRight size={14} /></div></button></li>)}</ul> : <div className="empty-queue"><FileImage size={28} strokeWidth={1.1} /><h4>No claims yet.</h4></div>}
      <div className="queue-footer"><span className="mono">Private queue</span><RefreshButton loading={queue.loading} onClick={() => void queue.refresh()} /></div>{queue.error && queue.data && <p className="field-error" role="alert">Queue refresh unavailable. Saved state shown.</p>}
    </aside>
    <div className="case-column">{claim ? <SellerCase key={claim.id} claim={claim} canRefund={canRefund} onUpdate={updateClaim} onRefresh={refreshCase} /> : <div className="panel no-selection"><span className="round-icon"><Fingerprint size={28} strokeWidth={1.1} /></span><h2>Select a claim.</h2></div>}</div>
  </div></>;
}

function SellerCase({ claim, canRefund, onUpdate, onRefresh }: { claim: ClaimView; canRefund: boolean; onUpdate: (claim: ClaimView) => void; onRefresh: () => Promise<void> }) {
  const [evidenceIndex, setEvidenceIndex] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const evidence = claim.evidence[evidenceIndex] ?? claim.evidence[0];
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true); setError("");
    try { await onRefresh(); } catch (cause) { setError(errorMessage(cause)); }
    finally { setRefreshing(false); }
  }
  return <article className="case-detail">
    <section className="panel case-overview"><div className="section-label"><span className="eyebrow">Private & order-bound<span className="mono case-id">{shortId(claim.id)}</span></span><StatusBadge claim={claim} /></div><div className="case-title"><div><h2>{claim.order.title}</h2><p>Opened {dateTime(claim.createdAt)} · {claim.evidenceKind === "live" ? "Live photos" : "Original upload"}</p></div><span className="case-value">{money(claim.amountCents)}</span></div><div className="buyer-message"><MessageCircle size={16} strokeWidth={1.3} /><blockquote>{claim.message || "No buyer message."}</blockquote></div><div className="case-reason"><span className="eyebrow">Next step</span><p>{claim.reason}</p></div>{claim.evidenceKind === "live" && <p className="field-hint">Camera source: <span className="mono">{claim.cameraLabel && claim.cameraLabel.length > 40 ? `${claim.cameraLabel.slice(0, 40)}…` : claim.cameraLabel || "Not reported"}</span></p>}</section>
    <section className="panel comparison-panel"><div className="section-label"><h3>{claim.order.listingImageUrl ? "Listing and evidence" : "Evidence"}</h3><span className="eyebrow">Private originals</span></div><div className="comparison-grid">
      {claim.order.listingImageUrl && <figure><div className="comparison-image"><EvidenceImage url={claim.order.listingImageUrl} alt="Immutable original listing photograph" /></div><figcaption><span><LockKeyhole size={12} />Original listing</span><span className="mono">{claim.order.listingHash}</span></figcaption></figure>}
      <figure><div className="comparison-image">{evidence?.url ? <EvidenceImage url={evidence.url} alt={evidence.label || "Buyer’s original damage evidence"} /> : <div className="image-placeholder"><FileImage size={30} strokeWidth={1} /><span>No photo submitted</span></div>}</div><figcaption><span><Fingerprint size={12} />{evidence?.label || (claim.evidenceKind === "live" ? "Live photos" : "Buyer evidence")}</span><span className="mono">{evidence ? `${Math.min(evidenceIndex + 1, claim.evidence.length)} / ${claim.evidence.length}` : "—"}</span></figcaption></figure>
    </div>{claim.evidence.length > 1 && <div className="evidence-switcher" role="group" aria-label="Choose evidence frame">{claim.evidence.map((item, index) => <button key={item.id} className={evidenceIndex === index ? "active" : ""} aria-pressed={evidenceIndex === index} onClick={() => setEvidenceIndex(index)}>Frame 0{index + 1}</button>)}</div>}<div className="comparison-note"><ShieldCheck size={13} /><span>Original bytes and hashes are retained.</span></div></section>
    <div className="case-checks-grid"><EvidenceChecks checks={claim.checks} /><PolicyCard /></div>
    <section className="panel reviewers-panel"><div className="section-label"><h3>Independent review</h3><span className="eyebrow">No payment access</span></div>{claim.reviews.length ? <ul className="reviewer-list">{claim.reviews.map((review, index) => <li key={`${review.model}-${index}`}><span className={`check-icon ${review.ok ? "pass" : "hold"}`}>{review.ok ? <Check size={12} /> : <Clock3 size={12} />}</span><div><strong className="mono">{review.returnedModel ?? review.model}</strong><span>{review.ok ? "Valid structured response · not a payment approval" : review.error || "A valid reviewer response was not available."}</span></div><span className="mono">{(review.durationMs / 1000).toFixed(1)}s</span></li>)}</ul> : <p className="small muted">No completed model responses. At least two valid reviews must agree before policy approval.</p>}</section>
    <div className="case-bottom-grid"><div><Timeline events={claim.timeline} /><details className="panel payment-details"><summary>Payment details<ArrowDown size={13} /></summary><OrderSummary order={claim.order} compact /></details></div><div className="refund-column"><RefundControl claim={claim} canRefund={canRefund} onUpdate={onUpdate} /><div className="sync-card"><div className="section-label"><span className="eyebrow">PayPal status</span><RefreshButton loading={refreshing} onClick={() => void refresh()} /></div>{claim.lastSyncedAt && <p>PayPal status checked {dateTime(claim.lastSyncedAt)}</p>}{claim.syncError && <p className="field-error">{claim.syncError}</p>}{error && <p className="field-error" role="alert">{error}</p>}</div></div></div>
  </article>;
}

function RefundControl({ claim, canRefund, onUpdate }: { claim: ClaimView; canRefund: boolean; onUpdate: (claim: ClaimView) => void }) {
  const balance = refundableBalance(claim.order);
  const [amount, setAmount] = useState((balance / 100).toFixed(2));
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setAmount((balance / 100).toFixed(2)); }, [balance]);
  const cents = refundAmount(amount, balance);
  const done = confirmedRefund(claim);
  const allowed = canRefund && claim.canRefund && balance > 0 && claim.order.status === "captured" && claim.refund?.status !== "pending" && claim.status !== "refund_pending";
  async function refund() {
    if (!allowed || !cents || busy) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ claim: ClaimView }>(`/api/seller/claims/${encodeURIComponent(claim.id)}/refund`, { method: "POST", body: { amountCents: cents } });
      onUpdate(result.claim); setConfirm(false);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <section className={`panel refund-card ${done ? "is-complete" : ""}`}><div className="section-label"><span className="eyebrow">Payment gate</span><LockKeyhole size={17} strokeWidth={1.3} /></div><h3>Refund</h3>
    {done ? <><div className="refund-confirmed"><CheckCircle2 size={22} strokeWidth={1.3} /><strong>{money(claim.refund!.amountCents)}</strong></div><p>PayPal sandbox confirmed the refund.</p><span className="mono refund-id">{claim.refund!.id}</span></> : <><p>{!canRefund ? "Viewer access is read only." : claim.status === "refund_pending" || claim.refund?.status === "pending" ? "Awaiting PayPal confirmation." : "Seller approval still passes the server’s payment and balance checks."}</p><dl className="detail-list"><div><dt>Captured</dt><dd>{money(claim.order.amountCents)}</dd></div><div><dt>Already refunded</dt><dd>{money(claim.order.refundedCents)}</dd></div><div><dt>Remaining balance</dt><dd>{money(balance)}</dd></div></dl>
      {allowed && <><label htmlFor="refund-amount">Refund amount · USD</label><div className="money-input"><span>$</span><input id="refund-amount" inputMode="decimal" type="text" value={amount} onChange={(event) => setAmount(event.target.value)} disabled={busy} aria-invalid={cents === null} /></div>{cents === null && <p className="field-error">Enter a positive amount with at most two decimal places, up to {money(balance)}.</p>}<button className="button paypal-blue full-width" disabled={busy || cents === null} onClick={() => setConfirm(true)}><LockKeyhole size={14} />Review sandbox refund<ArrowRight size={14} /></button><p className="field-hint">No real money. Final authority stays on the server.</p></>}
    </>}
    {error && !confirm && <Notice kind="error">{error}</Notice>}{confirm && allowed && cents !== null && <ConfirmRefund amount={cents} claimId={claim.id} busy={busy} error={error} onCancel={() => { if (!busy) { setConfirm(false); setError(""); } }} onConfirm={() => void refund()} />}
  </section>;
}

function ConfirmRefund({ amount, claimId, busy, error, onCancel, onConfirm }: { amount: number; claimId: string; busy: boolean; error: string; onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="refund-dialog" aria-labelledby="refund-dialog-title" onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}><span className="round-icon"><ShieldCheck size={25} strokeWidth={1.3} /></span><span className="eyebrow">Explicit seller approval</span><h2 id="refund-dialog-title">Approve this refund?</h2><p>You are authorizing a <strong>{money(amount)} PayPal sandbox refund</strong> for case <span className="mono">{shortId(claimId)}</span>.</p><p>The server checks payment facts and runs the gate before contacting PayPal. A pending result is not a completed refund. No real money moves.</p>{error && <Notice kind="error">{error}</Notice>}<button className="button paypal-blue full-width" disabled={busy} onClick={onConfirm}>{busy ? "Waiting for the payment service…" : `Confirm ${money(amount)} sandbox refund`}<ArrowRight size={14} /></button><button className="button secondary full-width" onClick={onCancel} disabled={busy}>Keep reviewing</button></dialog>;
}
