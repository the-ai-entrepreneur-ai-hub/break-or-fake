import { useEffect, useRef, useState } from "react";
import type { ImageInput, OrderView, ProductView } from "../lib/app-types";
import { api, buyerToken, errorMessage, rememberToken } from "./api";
import { Loading, Notice } from "./components";

interface PayPalButtons {
  render: (element: HTMLElement) => Promise<void>;
  close: () => Promise<void>;
}
interface PayPalSdk {
  Buttons: (options: {
    style: { layout: "vertical"; color: "gold"; shape: "pill"; label: "paypal"; height: number };
    createOrder: () => Promise<string>;
    onApprove: (data: { orderID: string }) => Promise<void>;
    onCancel: () => void;
    onError: (error: unknown) => void;
  }) => PayPalButtons;
}
declare global { interface Window { paypal?: PayPalSdk } }
let sdkPromise: Promise<PayPalSdk> | null = null;

function loadSdk(clientId: string): Promise<PayPalSdk> {
  if (window.paypal) return Promise.resolve(window.paypal);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<PayPalSdk>((resolve, reject) => {
    const script = document.createElement("script");
    const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
    if (nonce) { script.nonce = nonce; script.dataset.cspNonce = nonce; }
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture`;
    script.async = true;
    const timeout = setTimeout(() => { script.remove(); reject(new Error("PayPal took too long to load. Check your connection and try again.")); }, 20000);
    script.onload = () => { clearTimeout(timeout); window.paypal ? resolve(window.paypal) : reject(new Error("PayPal could not be loaded.")); };
    script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error("PayPal is unavailable. Check your connection or browser content settings.")); };
    document.head.append(script);
  }).catch((cause) => { sdkPromise = null; throw cause; });
  return sdkPromise;
}

export default function PayPalCheckout({ clientId, product, image, onResult, onBusy }: {
  clientId: string; product: ProductView; image: ImageInput | null;
  onResult: (order: OrderView) => void; onBusy: (busy: boolean) => void;
}) {
  const target = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onResult, onBusy });
  callbacks.current = { onResult, onBusy };
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [recoverable, setRecoverable] = useState<OrderView | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    let disposed = false;
    let buttons: PayPalButtons | undefined;
    let order: OrderView | null = null;
    setLoading(true);
    setError("");
    setNotice("");
    void loadSdk(clientId).then(async (sdk) => {
      if (disposed || !target.current) return;
      buttons = sdk.Buttons({
        style: { layout: "vertical", color: "gold", shape: "pill", label: "paypal", height: 48 },
        createOrder: async () => {
          callbacks.current.onBusy(true);
          setError("");
          setNotice("");
          try {
            const result = await api<{ order: OrderView; token: string; paypalOrderId: string }>("/api/orders", {
              method: "POST", body: { productId: product.id, ...(image ? { image } : {}) },
            });
            order = result.order;
            rememberToken(result.token, result.order.id);
            try { sessionStorage.setItem("break-or-fake:last-order", result.order.id); } catch { /* The in-memory capability still works. */ }
            if (!disposed) setRecoverable(result.order);
            return result.paypalOrderId;
          } catch (cause) { callbacks.current.onBusy(false); throw cause; }
        },
        onApprove: async ({ orderID }) => {
          if (!order || order.paypalOrderId !== orderID) throw new Error("The checkout could not be matched. Please check your saved order.");
          try {
            const result = await api<{ order: OrderView }>(`/api/orders/${encodeURIComponent(order.id)}/capture`, { method: "POST", body: {}, token: buyerToken(order.id) });
            if (!disposed) callbacks.current.onResult(result.order);
          } catch (cause) { if (!disposed) setError(`${errorMessage(cause)} Your payment status is not yet confirmed. Check the saved order before trying another checkout.`); }
          finally { callbacks.current.onBusy(false); }
        },
        onCancel: () => { callbacks.current.onBusy(false); if (!disposed) setNotice("Checkout was closed. No completed payment is being claimed."); },
        onError: () => { callbacks.current.onBusy(false); if (!disposed) setError("PayPal checkout was interrupted. If you approved a payment, check the saved order below before trying again."); },
      });
      await buttons.render(target.current);
      if (!disposed) setLoading(false);
    }).catch((cause) => { if (!disposed) { setError(errorMessage(cause)); setLoading(false); callbacks.current.onBusy(false); } });
    return () => { disposed = true; void buttons?.close().catch(() => {}); };
  }, [clientId, product.id, image, retry]);

  async function checkOrder() {
    if (!recoverable) return;
    setChecking(true);
    setError("");
    try {
      const result = await api<{ order: OrderView }>(`/api/orders/${encodeURIComponent(recoverable.id)}`, { token: buyerToken(recoverable.id) });
      callbacks.current.onResult(result.order);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setChecking(false); callbacks.current.onBusy(false); }
  }
  return <div className="paypal-checkout">
    {loading && <Loading>Connecting to PayPal sandbox…</Loading>}
    <div ref={target} className="paypal-button-mount" />
    {notice && <Notice>{notice}</Notice>}
    {error && <><Notice kind="error">{error}</Notice>{recoverable ? <button className="button secondary full-width" onClick={() => void checkOrder()} disabled={checking}>{checking ? "Checking payment…" : "Check saved order"}</button> : <button className="text-button" onClick={() => setRetry((value) => value + 1)}>Retry PayPal connection</button>}</>}
  </div>;
}
