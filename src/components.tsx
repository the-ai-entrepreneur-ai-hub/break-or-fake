import { type ChangeEvent, type ReactNode, useEffect, useId, useState } from "react";
import { ArrowRight, Check, CheckCircle2, Circle, Clock3, ExternalLink, ImagePlus, LoaderCircle, LockKeyhole, RefreshCw, ShieldCheck, Sparkles, Sun, X } from "lucide-react";
import { Link, NavLink, useLocation } from "react-router-dom";
import type { CheckView, ClaimView, ImageInput, OrderView, TimelineView } from "../lib/app-types";
import { errorMessage, originalImage } from "./api";
import { claimLabel, confirmedRefund, dateTime, money, shortId } from "./domain";

export function Shell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const seller = pathname === "/seller";
  return <div className={`app-shell ${seller ? "seller-shell" : ""}`}>
    <a href="#main" className="skip-link">Skip to content</a>
    <header className="site-header">
      <Link to="/shop" className="brand" aria-label="Sunday Supply home"><Sun strokeWidth={1.15} size={31} /><span>{seller ? <>BREAK <i>or</i> FAKE</> : <>SUNDAY SUPPLY</>}</span></Link>
      <nav aria-label="Main navigation" className="main-nav">
        <Link to="/shop#collection">Products</Link>
        <Link to="/shop#how-it-works">How claims work</Link>
        <Link to="/shop#whats-real">What's real</Link>
      </nav>
      <div className="header-end"><span className="sandbox-pill"><span />Sandbox</span><NavLink to="/seller" className="desk-link">Seller desk<ArrowRight size={13} /></NavLink></div>
    </header>
    {children}
    <footer className="site-footer">Sunday Supply is a sandbox test store for the Break or Fake demo. No real money.</footer>
  </div>;
}

export function Notice({ children, kind = "info" }: { children: ReactNode; kind?: "info" | "error" | "success" }) {
  return <div className={`notice ${kind}`} role={kind === "error" ? "alert" : "status"}>{kind === "success" ? <CheckCircle2 size={17} /> : kind === "error" ? <Circle size={16} /> : <ShieldCheck size={17} />}<div>{children}</div></div>;
}

export function Loading({ children = "Just a moment…" }: { children?: ReactNode }) {
  return <div className="loading-state" role="status"><LoaderCircle className="spin" size={20} /><span>{children}</span></div>;
}

export function RefreshButton({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  return <button className="text-button refresh-button" type="button" disabled={loading} onClick={onClick}><RefreshCw size={13} className={loading ? "spin" : ""} />{loading ? "Refreshing" : "Refresh"}</button>;
}

export function StatusBadge({ claim }: { claim: ClaimView }) {
  const done = confirmedRefund(claim);
  const pending = claim.status === "reviewing" || claim.status === "refund_pending" || (claim.status === "refunded" && !done);
  return <span className={`status-badge ${done ? "green" : pending ? "blue" : "amber"}`}>{done ? <Check size={12} /> : pending ? <Clock3 size={12} /> : <Circle size={9} />}{claimLabel(claim)}</span>;
}

export function EvidenceImage({ url, token, alt, className = "" }: { url: string; token?: string; alt: string; className?: string }) {
  const [source, setSource] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let objectUrl = "";
    const controller = new AbortController();
    setSource("");
    setFailed(false);
    void (async () => {
      try {
        const target = new URL(url, window.location.origin);
        if (!url || target.origin !== window.location.origin) throw new Error("Evidence must stay on this service.");
        const response = await fetch(target.pathname + target.search, {
          signal: controller.signal, credentials: "same-origin", cache: "no-store",
          headers: token ? { Authorization: `Bearer ${token}` } : {}, referrerPolicy: "no-referrer",
        });
        if (!response.ok) throw new Error("Image unavailable");
        const blob = await response.blob();
        if (!blob.type.startsWith("image/")) throw new Error("Image unavailable");
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      } catch { if (!disposed) setFailed(true); }
    })();
    return () => { disposed = true; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url, token]);
  return <div className={`evidence-image ${className}`}>{source ? <img src={source} alt={alt} onError={() => { setSource(""); setFailed(true); }} /> : failed ? <div className="image-placeholder"><ImagePlus size={24} strokeWidth={1} /><span>Image unavailable</span><small>Original evidence is private.</small></div> : <Loading>Loading original…</Loading>}</div>;
}

export function PhotoUpload({ label, hint, value, onChange, disabled = false }: {
  label: string; hint: string; value: ImageInput | null; onChange: (image: ImageInput | null) => void; disabled?: boolean;
}) {
  const id = useId();
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [filename, setFilename] = useState("");
  const [preview, setPreview] = useState("");
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setReading(true);
    setError("");
    try {
      const image = await originalImage(file);
      setPreview(URL.createObjectURL(file));
      setFilename(file.name);
      onChange(image);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setReading(false); event.target.value = ""; }
  }
  return <div className="photo-upload">
    <label htmlFor={id} className={`upload-zone ${value ? "has-image" : ""} ${disabled ? "disabled" : ""}`}>
      {value && preview ? <img src={preview} alt="Your selected original photo" /> : <div className="upload-icon"><ImagePlus size={23} strokeWidth={1.3} /></div>}
      <span><strong>{reading ? "Reading original photo…" : value ? filename || "Original photo selected" : label}</strong><small>{value ? "Original file selected · not re-encoded" : hint}</small></span>
      {value ? <CheckCircle2 size={18} className="green-text" /> : <ArrowRight size={17} />}
    </label>
    <input id={id} type="file" accept="image/jpeg,image/png" onChange={choose} disabled={disabled || reading} className="file-input" aria-describedby={`${id}-hint`} />
    <p id={`${id}-hint`} className="field-hint">JPEG or PNG, up to 4 MB and 24 megapixels. Keep the original file and its Content Credentials.</p>
    {value && <button className="text-button" disabled={disabled || reading} type="button" onClick={() => { onChange(null); setPreview(""); setFilename(""); }}><X size={12} />Remove photo</button>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </div>;
}

export function OrderSummary({ order, token, compact = false }: { order: OrderView; token?: string; compact?: boolean }) {
  return <section className={`order-summary ${compact ? "compact" : "panel"}`}>
    <div className="section-label"><span className="eyebrow">Your order</span><span className="mono">USD</span></div>
    <div className="order-product">{order.listingImageUrl && <EvidenceImage url={order.listingImageUrl} token={token} alt={`Original listing: ${order.title}`} />}<div><h3>{order.title}</h3><p>Sunday Supply · Quantity 01</p><strong>{money(order.amountCents)}</strong></div></div>
    <dl className="detail-list"><div><dt>Order</dt><dd className="mono" title={order.id}>{shortId(order.id)}</dd></div><div><dt>PayPal order</dt><dd className="mono" title={order.paypalOrderId}>{shortId(order.paypalOrderId)}</dd></div><div><dt>Capture</dt><dd className="mono">{order.captureId ?? (order.status === "pending" ? "Pending" : "Not captured")}</dd></div>{order.tracking && <div><dt>Merchant-reported tracking</dt><dd>{order.tracking}</dd></div>}</dl>
    {order.simulatedDelivery && <div className="small-note"><Sparkles size={14} /><span>Judge demo: delivery eligibility is simulated, not a carrier-confirmed delivery.</span></div>}
    {order.listingImageUrl && <div className="listing-binding"><LockKeyhole size={13} /><span>Original listing locked at checkout</span><span className="mono">{order.listingHash}</span></div>}
  </section>;
}

export function EvidenceChecks({ checks }: { checks: CheckView[] }) {
  return <section className="panel checks-panel"><div className="section-label"><h3>Evidence checks</h3><ShieldCheck size={17} strokeWidth={1.4} /></div>{checks.length ? <ul className="check-list">{checks.map((check) => <li key={check.id}><span className={`check-icon ${check.status}`}>{check.status === "pass" ? <Check size={13} /> : check.status === "pending" ? <Clock3 size={12} /> : <Circle size={9} />}</span><div><strong>{check.label}</strong><p>{check.detail}</p></div><span className="mono check-status">{check.status === "pass" ? "PASS" : check.status === "hold" ? "REVIEW" : check.status === "info" ? "INFO" : "WAIT"}</span></li>)}</ul> : <p className="muted small">Checks will appear when evidence is reviewed. Unknown is not a pass.</p>}<p className="checks-disclaimer">Missing Content Credentials mean unknown provenance, not proof of authenticity.</p></section>;
}

export function Timeline({ events }: { events: TimelineView[] }) {
  return <section className="panel timeline-panel"><div className="section-label"><h3>Case timeline</h3><span className="eyebrow">{events.length.toString().padStart(2, "0")} events</span></div>{events.length ? <ol className="timeline">{events.map((event) => <li key={event.id}><span className={`timeline-dot ${event.status}`}>{event.status === "complete" && <Check size={9} />}</span><div><div className="timeline-heading"><strong>{event.name}</strong><time dateTime={event.at}>{dateTime(event.at)}</time></div><p>{event.detail}</p></div></li>)}</ol> : <p className="muted small">Your case history will appear here.</p>}</section>;
}

export function PolicyCard() {
  return <section className="panel policy-card"><div className="section-label"><h3>Refund policy</h3><ShieldCheck size={17} strokeWidth={1.3} /></div><dl><div><dt>Original upload</dt><dd>≤ $15</dd></div><div><dt>Live photos</dt><dd>≤ $60</dd></div><div><dt>Anything uncertain</dt><dd>Seller review</dd></div></dl><p>At least two valid reviewers must agree. Payment facts, listing match, delivery eligibility and remaining balance are checked separately.</p><p>Ordinary orders: up to two policy refunds per payer in 90 days. Only judge orders have the demo exemption.</p><span className="policy-foot"><LockKeyhole size={12} />Models review evidence. They cannot move money.</span></section>;
}

export function ExternalIcon() { return <ExternalLink size={13} />; }
