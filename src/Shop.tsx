import { useEffect, useState } from "react";
import { ArrowDown, ArrowRight, Check, CheckCircle2, Fingerprint, LockKeyhole, Package, ShieldCheck } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import type { ConfigView, ImageInput, OrderView, ProductView } from "../lib/app-types";
import { api, buyerToken, errorMessage, rememberToken } from "./api";
import { Loading, Notice, OrderSummary, PhotoUpload } from "./components";
import { money } from "./domain";
import { usePolling } from "./hooks";
import PayPalCheckout from "./PayPalCheckout";

const placeholders: ProductView[] = [
  { id: "linen", title: "Everyday linen", subtitle: "Upload path. Under $15, one photo is enough.", priceCents: 1200, kind: "upload", image: "", available: false },
  { id: "mug", title: "The everyday mug", subtitle: "Live path. Above $15, three live photos with a handwritten code.", priceCents: 3200, kind: "live", image: "", available: false },
  { id: "judge-cup", title: "The paper-cup test", subtitle: "Judge path. Your own cup photo becomes the listing. Buy it, tear it, claim it.", priceCents: 2500, kind: "judge", image: "", available: false },
];

export default function Shop() {
  const config = usePolling<ConfigView>("config", (signal) => api("/api/config", { signal }));
  const catalog = config.data?.catalog ?? placeholders;
  const [selectedId, setSelectedId] = useState("");
  const product = catalog.find((item) => item.id === selectedId) ?? catalog.find((item) => item.kind === "judge") ?? catalog[0];
  const [image, setImage] = useState<ImageInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [savedId, setSavedId] = useState("");
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState(false);
  const { hash } = useLocation();
  useEffect(() => { if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: "smooth" }); }, [hash]);
  useEffect(() => {
    try {
      const id = sessionStorage.getItem("break-or-fake:last-order");
      if (id && buyerToken(id)) setSavedId(id);
    } catch { /* Resuming remains available through the buyer link. */ }
  }, []);
  const ready = !!config.data?.paypalClientId && !!product?.available && (product.kind !== "judge" || !!image);
  function selectJudge() {
    setSelectedId("judge-cup"); setOrder(null); setError("");
  }
  async function restoreOrder() {
    setRestoring(true); setError("");
    try { const result = await api<{ order: OrderView }>(`/api/orders/${encodeURIComponent(savedId)}`, { token: buyerToken(savedId) }); setOrder(result.order); document.getElementById("collection")?.scrollIntoView({ behavior: "smooth" }); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setRestoring(false); }
  }
  return <main id="main" className="shop-page">
    <section className="shop-hero" aria-labelledby="shop-heading"><div className="hero-copy"><span className="eyebrow">Break or Fake demo</span><h1 id="shop-heading">A test store for damage claims.</h1><p>Anyone can now fake a damage photo with one prompt. Break or Fake checks the claim before a PayPal refund moves. Real damage gets refunded. Doubtful photos wait for the seller. This is a sandbox test store, so no real money moves.</p><div className="hero-actions"><a href="#judge-cup" className="button primary hero-cta" onClick={selectJudge}>Try it with a paper cup ($25)<ArrowRight size={17} /></a><Link to="/seller" className="button secondary hero-cta">Open the seller desk<ArrowRight size={17} /></Link></div></div></section>
    <section id="collection" className="collection-section"><div className="section-heading"><h2>Test products.</h2></div>
      {config.error && <Notice kind="error">The shop configuration could not be loaded. Checkout is unavailable. <button className="text-button" onClick={() => void config.refresh()}>Try again</button></Notice>}
      {config.loading && !config.data && <Loading>Opening the products…</Loading>}
      <div className="shop-workspace"><div className="product-grid">{catalog.filter((item) => item.available).map((item, index) => <button id={item.id === "judge-cup" ? "judge-cup" : undefined} className={`product-card ${product?.id === item.id ? "selected" : ""}`} disabled={busy} key={item.id} type="button" aria-pressed={product?.id === item.id} onClick={() => { setSelectedId(item.id); setOrder(null); setError(""); }}>
        <div className="product-visual"><span className="product-number mono">0{index + 1}</span><ProductPhoto product={item} /><span className={`product-tag ${item.kind === "judge" ? "judge" : ""}`}>{item.kind === "judge" ? "Judge path" : item.kind === "upload" ? "Upload path" : "Live path"}</span></div><div className="product-description"><div><h3>{item.title}</h3><span>{money(item.priceCents)}</span></div><p>{item.subtitle}</p><div className="product-select"><span>{product?.id === item.id ? "Selected for checkout" : "Select product"}</span><span className="selection-circle">{product?.id === item.id ? <Check size={12} /> : <ArrowRight size={13} />}</span></div></div>
      </button>)}</div>
      <aside className="checkout-panel panel" aria-label="Sandbox checkout">{order ? <OrderConfirmation order={order} onUpdate={setOrder} onReset={() => { setOrder(null); setError(""); }} /> : <>
        <div className="section-label"><span className="eyebrow">Sandbox checkout</span><Package size={18} strokeWidth={1.3} /></div><h3>{product?.title}</h3><p className="checkout-subtitle">{product?.kind === "judge" ? "Your photo of the intact cup is hashed into the PayPal order, so the claim can only be about this cup." : "The original listing photo is bound to this PayPal order."}</p><div className="checkout-total"><span>1 item · USD</span><strong>{money(product?.priceCents ?? 0)}</strong></div>
        {product?.kind === "judge" && <div className="judge-upload"><span className="step-label"><span>01</span> First, your intact cup</span><PhotoUpload label="Add your original cup photo" hint="An intact paper cup, clearly in frame" value={image} onChange={setImage} disabled={busy} /><details className="judge-instructions"><summary>How the paper-cup test works<ArrowDown size={12} /></summary><ol><li>Photograph your intact paper cup. This original becomes your listing.</li><li>Pay $25 with a PayPal sandbox buyer account.</li><li>Tear the cup, then open your claim and take three live photos with a handwritten code.</li></ol></details></div>}
        {!config.data?.paypalClientId ? <div className="setup-state"><LockKeyhole size={19} strokeWidth={1.3} /><strong>Sandbox checkout is unavailable.</strong><p>No payment has been created.</p></div> : !product?.available ? <div className="setup-state"><LockKeyhole size={19} strokeWidth={1.3} /><strong>This product is not checkout-ready.</strong><p>{product?.unavailableReason ?? "The seller’s original listing photo is needed."}</p></div> : !ready ? <div className="setup-state subtle"><Fingerprint size={19} strokeWidth={1.3} /><strong>Your photo comes first.</strong><p>Add the intact cup photo to unlock sandbox checkout.</p></div> : <PayPalCheckout clientId={config.data.paypalClientId} product={product} image={product.kind === "judge" ? image : null} onResult={setOrder} onBusy={setBusy} />}
        {product?.kind === "judge" && <p className="field-hint">Judges: pay with PayPal's test card 4005 5192 0000 0004, any future date, CVV 123. Choose United States and pay as a guest, without creating an account.</p>}
        <div className="sandbox-checkout-note"><LockKeyhole size={12} /><span>PayPal sandbox · No real money</span></div>
        {savedId && <button className="text-button resume-order" onClick={() => void restoreOrder()} disabled={restoring || busy}>{restoring ? "Checking saved order…" : "Resume my saved order"}<ArrowRight size={12} /></button>}
      </>}{error && <Notice kind="error">{error}</Notice>}</aside></div>
    </section>
    <section className="how-section" id="how-it-works"><div className="how-intro"><h2>How a claim is reviewed.</h2></div><div className="how-cards">{[
      ["01", "Show the damage.", "Upload a photo, or take three live photos with a code we give you.", Fingerprint],
      ["02", "Independent reviewers look at it.", "Two or three vision models check the item, the damage, the code and whether the scene is real. Code, not a model, decides about money.", ShieldCheck],
      ["03", "One of three outcomes.", "Refunded through PayPal, a live photo requested, or held for the seller. Never an automatic denial.", CheckCircle2],
    ].map(([number, title, text, Icon]) => { const StepIcon = Icon as typeof Check; return <article className="how-card panel" key={String(number)}><div><span className="mono">{String(number)}</span><StepIcon size={22} strokeWidth={1.2} /></div><h3>{String(title)}</h3><p>{String(text)}</p></article>; })}</div></section>
    <section className="real-facts" id="whats-real" aria-labelledby="real-heading"><h2 id="real-heading">What is real here</h2><table><thead><tr><th scope="col">Part</th><th scope="col">What happens</th></tr></thead><tbody>
      <tr><th scope="row">Real application logic</th><td>Original-byte evidence, private access, listing hashes, capture codes and expiry, a deterministic payment gate, and case history.</td></tr>
      <tr><th scope="row">PayPal sandbox operations</th><td>Orders, captures, tracking and confirmed refunds use PayPal sandbox accounts. No real money.</td></tr>
      <tr><th scope="row">Simulated delivery eligibility</th><td>Judge orders use simulated delivery eligibility. Merchant-reported tracking is not proof of carrier delivery.</td></tr>
      <tr><th scope="row">Reviewer inference</th><td>Configured vision models review actual submitted photos. They can miss edited or staged scenes. Missing Content Credentials do not prove authenticity. No review-time guarantee has been measured.</td></tr>
      <tr><th scope="row">Shop pictures</th><td>Synthetic catalog art. Not photos of real stock, and never used as evidence.</td></tr>
    </tbody></table></section>
  </main>;
}

function ProductPhoto({ product }: { product: ProductView }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [product.image]);
  return product.image && !failed ? <img className="product-photo" src={product.image} alt={product.title} onError={() => setFailed(true)} /> : <div className="product-photo-placeholder">{product.title}</div>;
}

function OrderConfirmation({ order, onUpdate, onReset }: { order: OrderView; onUpdate: (order: OrderView) => void; onReset: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const token = buyerToken(order.id);
  const captured = order.status === "captured" && !!order.captureId;
  useEffect(() => { if (token && order.claimId) rememberToken(token, order.claimId); }, [token, order.claimId]);
  async function refresh() {
    setBusy(true); setError("");
    try { const result = await api<{ order: OrderView }>(`/api/orders/${encodeURIComponent(order.id)}/capture`, { method: "POST", body: {}, token }); onUpdate(result.order); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <div className="order-confirmation"><div className={`confirmation-icon ${captured ? "complete" : ""}`}>{captured ? <Check size={24} /> : <Package size={24} />}</div><span className="eyebrow">PayPal sandbox</span><h3>{captured ? "Payment confirmed." : order.status === "pending" ? "Payment pending." : "Checkout isn’t complete."}</h3><p>{captured ? "Your sandbox payment is confirmed. Your original listing is saved." : "No completed purchase is being claimed. The next step appears when PayPal confirms your payment."}</p><OrderSummary order={order} token={token} compact />{captured ? <>{order.isJudge && <div className="judge-next"><p>Tear your paper cup. Open a claim, then take three live photos beside a handwritten code. The $25 test needs live photos or seller review.</p></div>}<Link className="button primary full-width" to={order.claimId ? `/claim/${encodeURIComponent(order.claimId)}` : `/claim/${encodeURIComponent(order.id)}?order=1`}>Start or resume a claim<ArrowRight size={16} /></Link><p className="field-hint">Your private access is saved in this browser tab. Keep it open.</p></> : <button className="button secondary full-width" onClick={() => void refresh()} disabled={busy}>{busy ? "Checking…" : "Check payment status"}</button>}{error && <Notice kind="error">{error}</Notice>}<button className="text-button" onClick={onReset}>Back to products</button></div>;
}
