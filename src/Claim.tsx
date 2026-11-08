import { type FormEvent, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Camera, Check, CheckCircle2, CircleHelp, Clock3, Copy, Fingerprint, Link2, LockKeyhole, MessageCircle, ShieldCheck, Smartphone, Upload } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { ClaimView, ImageInput, OrderView } from "../lib/app-types";
import { api, errorMessage, receiveCapability, rememberToken } from "./api";
import { EvidenceChecks, Loading, Notice, OrderSummary, PhotoUpload, PolicyCard, RefreshButton, StatusBadge, Timeline } from "./components";
import { capturePath, confirmedRefund, dateTime, isActiveClaim, money } from "./domain";
import { usePolling } from "./hooks";

type ClaimResource = { order: OrderView; claim: ClaimView | null };

export default function Claim() {
  const { id = "" } = useParams();
  const [token] = useState(() => receiveCapability(id));
  if (!token) return <main id="main" className="access-page"><span className="round-icon"><LockKeyhole size={25} strokeWidth={1.2} /></span><h1>This claim opens only from its private link.</h1><p>Open this claim in the browser tab you used at checkout, or use the complete private handoff link from that tab.</p><p>For your privacy, an order number alone cannot unlock evidence.</p><Link to="/shop" className="button primary">Back to Sunday Supply <ArrowRight size={15} /></Link></main>;
  return <AuthorizedClaim id={id} token={token} />;
}

function AuthorizedClaim({ id, token }: { id: string; token: string }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const orderMode = params.get("order") === "1";
  const [message, setMessage] = useState("");
  const [image, setImage] = useState<ImageInput | null>(null);
  const [mode, setMode] = useState<"upload" | "live">("upload");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [handoff, setHandoff] = useState(params.get("handoff") === "1");
  const resource = usePolling<ClaimResource>(`claim:${id}:${orderMode}`, async (signal, manual) => {
    if (orderMode) {
      const { order } = await api<{ order: OrderView }>(`/api/orders/${encodeURIComponent(id)}`, { token, signal });
      rememberToken(token, order.id);
      if (!order.claimId) return { order, claim: null };
      rememberToken(token, order.claimId);
      const { claim } = await api<{ claim: ClaimView }>(`/api/claims/${encodeURIComponent(order.claimId)}`, { token, signal });
      return { order: claim.order, claim };
    }
    const { claim } = await api<{ claim: ClaimView }>(`/api/claims/${encodeURIComponent(id)}${manual ? "/refresh" : ""}`, { token, signal, ...(manual ? { method: "POST", body: {} } : {}) });
    rememberToken(token, claim.orderId, claim.id);
    return { claim, order: claim.order };
  }, (value) => !!value.claim && (isActiveClaim(value.claim.status) || (value.claim.status === "refunded" && !confirmedRefund(value.claim))));
  const order = resource.data?.order;
  const claim = resource.data?.claim;
  useEffect(() => {
    if (orderMode && claim) navigate(`/claim/${encodeURIComponent(claim.id)}`, { replace: true });
  }, [claim?.id, orderMode, navigate]);

  async function submit(action: "upload" | "live" | "phone" | "help", event?: FormEvent) {
    event?.preventDefault();
    if (!order || submitting) return;
    if (action === "upload" && !image) { setError("Add an original photo, or choose live capture or seller help."); return; }
    if (!message.trim() && !claim && action !== "help") { setError("Tell us briefly what happened so the seller has some context."); return; }
    setSubmitting(true); setError("");
    try {
      const { claim: next } = await api<{ claim: ClaimView }>(`/api/orders/${encodeURIComponent(order.id)}/claims`, {
        method: "POST", token, body: {
          message: message.trim() || claim?.message || "I need help documenting my damaged item.",
          ...(action === "upload" && image ? { image } : {}),
          ...(action === "help" ? { help: true } : {}),
        },
      });
      rememberToken(token, next.id, next.orderId);
      if (action === "live") { window.location.assign(capturePath(next.id, token)); return; }
      if (next.id !== id || orderMode) navigate(`/claim/${encodeURIComponent(next.id)}${action === "phone" ? "?handoff=1" : ""}`, { replace: true });
      else { resource.setData({ claim: next, order: next.order }); if (action === "phone") setHandoff(true); if (action === "upload") setImage(null); }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSubmitting(false); }
  }

  if (!resource.data) return <main id="main" className="claim-page"><Link to="/shop" className="back-link"><ArrowLeft size={13} />Sunday Supply</Link>{resource.error ? <div className="panel error-panel"><span className="eyebrow">We couldn’t open this claim</span><h1>Let’s take<br />another look.</h1><Notice kind="error">{resource.error}</Notice><button className="button secondary" disabled={resource.loading} onClick={() => void resource.refresh()}>Try again</button><p className="small muted">If this is a private-link issue, return to the checkout tab. No evidence is shown without your access.</p></div> : <Loading>Opening your private order…</Loading>}</main>;

  const captured = order?.status === "captured" && !!order.captureId;
  return <main id="main" className="claim-page">
    <div className="page-topline"><Link to="/shop" className="back-link"><ArrowLeft size={13} />Back to Sunday Supply</Link><span className="eyebrow"><LockKeyhole size={12} />Private & order-bound</span></div>
    <header className="page-heading claim-heading"><div><h1>Report damage on this order.</h1><p>Tell us what happened and show the damage. You will see the result on this page.</p></div><div className="claim-heading-note"><ShieldCheck size={26} strokeWidth={1.1} /><p>A person can always review it.</p></div></header>
    <ProgressRail claim={claim ?? null} />
    <div className="claim-layout"><div className="claim-main">
      {resource.error && <Notice kind="error">Progress could not be refreshed. Your last saved state is still shown. {resource.error}</Notice>}
      {!captured ? <section className="panel"><span className="eyebrow">Payment not confirmed</span><h2>One thing before<br />we begin.</h2><p>A claim needs a completed sandbox capture. This order is currently {order?.status}.</p><button className="button secondary" disabled={resource.loading} onClick={() => void resource.refresh()}>Check payment status</button></section> : claim ? <>
        <ClaimResult claim={claim} loading={resource.loading} onRefresh={() => void resource.refresh()} />
        {!claim.refund && (claim.status === "awaiting_live" || claim.status === "draft" || claim.status === "held") && <section className="panel capture-options">
          <h3>Next step</h3>
          <p>{claim.amountCents > 1500 ? `At ${money(claim.amountCents)}, an upload alone doesn’t meet the policy. Add live photos, or ask the seller for help.` : "Live photos can add context. Or ask the seller to review it."}</p>
          <div className="capture-steps"><span><span>01</span>Write the fresh code</span><span><span>02</span>Item + code in view</span><span><span>03</span>Three distinct angles</span></div>
          <a href={capturePath(claim.id, token)} className="button primary"><Camera size={16} />Add live photos<ArrowRight size={15} /></a>
          <button className="button secondary" onClick={() => setHandoff((value) => !value)}><Smartphone size={15} />{handoff ? "Hide phone handoff" : "Continue on my phone"}</button>
          {handoff && <PhoneHandoff id={claim.id} token={token} />}
          <details className="additional-photo"><summary>Add an original photo instead <ArrowRight size={12} /></summary><p>An upload adds context to this same claim. Above $15, it still needs live capture or explicit seller approval.</p><PhotoUpload label="Choose your original damage photo" hint="Your file is preserved without re-encoding" value={image} onChange={setImage} disabled={submitting} /><label htmlFor="claim-extra-context">Anything to add? (optional)</label><textarea id="claim-extra-context" rows={3} maxLength={2000} value={message} onChange={(event) => setMessage(event.target.value)} placeholder={claim.message} disabled={submitting} /><button className="button secondary full-width" disabled={submitting || !image} onClick={() => void submit("upload")}>{submitting ? "Saving original evidence…" : "Save photo to this claim"}<ArrowRight size={13} /></button></details>
          <div className="help-alternative"><CircleHelp size={17} /><div><strong>No camera?</strong><p>Camera permission, a compatible device, or another photo is never a condition for asking a person for help.</p><button className="text-button" disabled={submitting} onClick={() => void submit("help")}>{submitting ? "Sending request…" : "Ask the seller for help"}<ArrowRight size={13} /></button></div></div>
        </section>}
        {error && <Notice kind="error">{error}</Notice>}
        {!!claim.checks.length && <EvidenceChecks checks={claim.checks} />}
        <Timeline events={claim.timeline} />
      </> : <form className="panel claim-form" onSubmit={(event) => void submit(mode, event)}>
        <div className="section-label"><span className="eyebrow">01 / Report</span><MessageCircle size={17} strokeWidth={1.4} /></div><h3>What happened?</h3><label htmlFor="claim-message">What happened to your item?</label><textarea id="claim-message" maxLength={2000} rows={4} placeholder="The item arrived damaged. Here’s what I noticed…" value={message} onChange={(event) => setMessage(event.target.value)} disabled={submitting} /><div className="textarea-note"><span>Only the seller and reviewers can see this.</span><span className="mono">{message.length}/2000</span></div>
        <span className="eyebrow evidence-label">02 / Evidence</span><div className="evidence-choice" role="group" aria-label="Evidence method"><button type="button" aria-pressed={mode === "upload"} className={mode === "upload" ? "selected" : ""} onClick={() => setMode("upload")} disabled={submitting}><Upload size={18} strokeWidth={1.3} /><strong>Original upload</strong><span>Start with a photo</span></button><button type="button" aria-pressed={mode === "live"} className={mode === "live" ? "selected" : ""} onClick={() => setMode("live")} disabled={submitting}><Camera size={18} strokeWidth={1.3} /><strong>Live photos</strong><span>Three angles, one code</span></button></div>
        {mode === "upload" ? <><PhotoUpload label="Choose your original damage photo" hint="Show the whole item and the damage clearly" value={image} onChange={setImage} disabled={submitting} />{order!.amountCents > 1500 && <div className="small-note"><Camera size={15} /><span>This {money(order!.amountCents)} item is above the $15 upload policy. An upload can provide context, but a refund needs live photos or seller approval.</span></div>}</> : <div className="live-explanation"><span className="round-icon"><Camera size={23} strokeWidth={1.2} /></span><div><strong>Live photos</strong><p>We give you a three-digit code. Write it on paper and take three photos of the damage with the code in frame. You have two minutes.</p><button type="button" className="text-button" disabled={submitting} onClick={() => void submit("phone")}><Smartphone size={13} />Use my phone<ArrowRight size={12} /></button></div></div>}
        {error && <Notice kind="error">{error}</Notice>}<button className="button primary full-width" type="submit" disabled={submitting || (mode === "upload" && !image)}>{submitting ? "Saving your claim…" : "Submit claim"}<ArrowRight size={16} /></button><div className="help-alternative"><CircleHelp size={17} /><div><strong>No camera?</strong><p>The seller can review the claim without a photo.</p><button className="text-button" type="button" disabled={submitting} onClick={() => void submit("help")}>Ask for seller help<ArrowRight size={12} /></button></div></div>
      </form>}
    </div><aside className="claim-sidebar"><OrderSummary order={order!} token={token} /><PolicyCard /><div className="privacy-note"><LockKeyhole size={15} /><p>Original evidence is private and removed 30 days after claim closure. Handoff links grant access to this order; share only with your own device.</p></div></aside></div>
  </main>;
}

function ProgressRail({ claim }: { claim: ClaimView | null }) {
  const stage = !claim ? 0 : confirmedRefund(claim) || claim.status === "held" || claim.status === "awaiting_live" ? 2 : 1;
  return <ol className="progress-rail" aria-label="Claim progress">{["Report", "Review", "Result"].map((label, index) => <li key={label} className={index < stage ? "complete" : index === stage ? "current" : ""} aria-current={index === stage ? "step" : undefined}><span>{index < stage ? <Check size={12} /> : `0${index + 1}`}</span><strong>{label}</strong>{index < 2 && <div />}</li>)}</ol>;
}

function ClaimResult({ claim, loading, onRefresh }: { claim: ClaimView; loading: boolean; onRefresh: () => void }) {
  const done = confirmedRefund(claim);
  const state = done ? { title: "Refunded.", text: `${money(claim.refund!.amountCents)} has been confirmed refunded by PayPal sandbox. No real money moved.`, Icon: CheckCircle2 } : claim.status === "refund_pending" || claim.status === "refunded" ? { title: "Refund in progress.", text: "The refund is not confirmed yet. We’re checking PayPal’s status; please don’t start another payment or refund.", Icon: Clock3 } : claim.status === "held" ? { title: "Held for the seller.", text: "Your claim needs more context or a seller’s decision. This is not a denial, and no refund is being claimed.", Icon: MessageCircle } : claim.status === "awaiting_live" ? { title: "A live photo is needed.", text: "Live photos or seller review are the next step. Your claim is saved, and you don’t need to start over.", Icon: Camera } : { title: "Reviewing your photos.", text: "Your evidence is saved. Independent reviewers and payment checks are running. You can leave this tab open.", Icon: Fingerprint };
  return <section className={`panel claim-result ${done ? "is-complete" : ""}`} aria-live="polite">
    <div className="section-label"><StatusBadge claim={claim} /><RefreshButton loading={loading} onClick={onRefresh} /></div>
    <div className="result-symbol"><state.Icon size={29} strokeWidth={1.2} /></div>
    <h2>{state.title}</h2><p>{state.text}</p>
    {claim.reason && <div className="result-reason"><span className="eyebrow">Why this next step</span><p>{claim.reason}</p></div>}
    {done && <dl className="detail-list"><div><dt>Confirmed amount</dt><dd>{money(claim.refund!.amountCents)}</dd></div><div><dt>PayPal refund ID</dt><dd className="mono">{claim.refund!.id}</dd></div></dl>}
    {claim.refund?.status === "failed" && <Notice>The last refund attempt was not confirmed. The seller can inspect the payment history and help; this is not a completed refund.</Notice>}
    {claim.lastSyncedAt && <div className="sync-status">PayPal status checked {dateTime(claim.lastSyncedAt)}</div>}
  </section>;
}

function PhoneHandoff({ id, token }: { id: string; token: string }) {
  const url = window.location.origin + capturePath(id, token);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  async function copy() {
    try { await navigator.clipboard.writeText(url); setCopied(true); setError(""); }
    catch { setError("Clipboard isn’t available. Scan the QR code or open capture on this device."); }
  }
  return <div className="phone-handoff"><div className="qr-frame"><QRCodeSVG value={url} size={136} level="M" title="Private live-capture handoff for this order" /></div><div><h4>Scan with your phone.</h4><p>Open in Safari or Chrome over HTTPS. This private link grants access to your order. Don’t share it publicly.</p><button className="text-button" onClick={() => void copy()}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "Private link copied" : "Copy private handoff link"}</button>{error && <p className="field-error" role="alert">{error}</p>}<span className="private-link-note"><Link2 size={11} />Access token stays in the URL fragment.</span></div></div>;
}
