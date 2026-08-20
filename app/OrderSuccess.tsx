"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { useCart } from "./cart";
import type { AddressSnapshot } from "../lib/orderAddressSnapshot";
import { getCountryLabel } from "../lib/shipping";

type OrderData = {
  id: string;
  orderNumber: string;
  placedAt: string;
  currency: string;
  totalGrossCents: number;
  paymentStatus: string;
  shippingAddress: AddressSnapshot | null;
  items: {
    productName: string;
    variantLabel: string | null;
    quantity: number;
    unitGrossCents: number;
    lineGrossCents: number;
  }[];
};

type ApiStatus = "loading" | "invalid" | "unpaid" | "processing" | "success";

const fmtCents = (cents: number) => (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });

const MAX_POLLS = 6;
const POLL_INTERVAL_MS = 2000;

/**
 * The Stripe redirect (checkout=success / session_id in the URL) is never
 * treated as proof of payment - this page only ever shows order data that
 * GET /api/orders/success returned, which itself only reports an order
 * that the verified, atomic webhook-driven flow already created.
 */
export function OrderSuccess() {
  const { user } = useAuth();
  const { clearCart } = useCart();
  // undefined = server render (no window yet), null = genuinely absent.
  // A lazy initializer (not an effect) mirrors how Account() elsewhere in
  // this app reads window.location on first client render.
  const [sessionId] = useState<string | null | undefined>(() =>
    typeof window === "undefined" ? undefined : new URLSearchParams(window.location.search).get("session_id")
  );
  const [apiStatus, setApiStatus] = useState<ApiStatus>("loading");
  const [order, setOrder] = useState<OrderData | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const [ownOrder, setOwnOrder] = useState(false);
  const clearedRef = useRef(false);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/orders/success?session_id=${encodeURIComponent(sessionId)}`);
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!body?.status) {
          setApiStatus("invalid");
          return;
        }
        setApiStatus(body.status as ApiStatus);
        if (body.status === "success") setOrder(body.order as OrderData);
      } catch {
        if (!cancelled) setApiStatus("invalid");
      }
    })();

    return () => { cancelled = true; };
  }, [sessionId, pollCount]);

  // Keep polling while payment/order confirmation is still in flight.
  useEffect(() => {
    if (apiStatus !== "processing" && apiStatus !== "unpaid") return;
    if (pollCount >= MAX_POLLS) return;
    const t = setTimeout(() => setPollCount(c => c + 1), POLL_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [apiStatus, pollCount]);

  // Only offer the account CTA if this order actually belongs to the
  // signed-in customer - reuses the same RLS policy that already scopes
  // /account/orders/[id], instead of trusting anything from this page.
  useEffect(() => {
    let cancelled = false;
    if (!order || !user || !supabase) {
      queueMicrotask(() => { if (!cancelled) setOwnOrder(false); });
      return () => { cancelled = true; };
    }
    supabase.from("orders").select("id").eq("id", order.id).maybeSingle().then(({ data }) => {
      if (!cancelled) setOwnOrder(!!data);
    });
    return () => { cancelled = true; };
  }, [order, user]);

  // Clear the cart exactly once, and only once a verified paid order
  // actually exists - never on the redirect alone, never on a re-render.
  useEffect(() => {
    if (order && !clearedRef.current) {
      clearedRef.current = true;
      clearCart();
    }
  }, [order, clearCart]);

  if (sessionId === undefined || apiStatus === "loading") {
    return (
      <main className="account-page">
        <section className="account-section">
          <p className="eyebrow">ZAHLUNG ERHALTEN</p>
          <h1>Einen Moment…</h1>
        </section>
      </main>
    );
  }

  if (sessionId === null || apiStatus === "invalid") {
    return (
      <main className="account-page">
        <section className="account-section">
          <p className="eyebrow">BESTELLUNG</p>
          <h1>Diese Bestellung konnte nicht gefunden werden.</h1>
          <p className="account-lead">Der Link ist ungültig oder abgelaufen.</p>
          <Link className="cta" href="/shop">WEITER EINKAUFEN</Link>
        </section>
      </main>
    );
  }

  if ((apiStatus === "processing" || apiStatus === "unpaid") && pollCount < MAX_POLLS) {
    return (
      <main className="account-page">
        <section className="account-section">
          <p className="eyebrow">ZAHLUNG ERHALTEN</p>
          <h1>Deine Bestellung wird gerade bestätigt.</h1>
          <p className="account-lead">Bitte einen Moment.</p>
        </section>
      </main>
    );
  }

  if (apiStatus === "processing" || apiStatus === "unpaid") {
    return (
      <main className="account-page">
        <section className="account-section">
          <p className="eyebrow">ZAHLUNG WIRD BESTÄTIGT</p>
          <h1>Deine Zahlung wird noch bestätigt.</h1>
          <p className="account-lead">Das kann in seltenen Fällen etwas länger dauern.</p>
          <button className="cta" onClick={() => setPollCount(0)}>ERNEUT PRÜFEN</button>
        </section>
      </main>
    );
  }

  if (!order) return null;

  return (
    <main className="order-success-page">
      <section className="order-success-hero">
        <p className="eyebrow">ZAHLUNG BESTÄTIGT</p>
        <h1>Danke für deine Bestellung.</h1>
        <p className="account-lead">Bestellnummer {order.orderNumber}</p>
      </section>

      <section className="order-detail-section">
        <p className="eyebrow">ARTIKEL</p>
        <div className="order-items-list">
          {order.items.map((item, i) => (
            <div key={i} className="order-item-row">
              <div className="order-item-name">
                <strong>{item.productName}</strong>
                {item.variantLabel && <span className="order-item-variant">{item.variantLabel}</span>}
              </div>
              <span className="order-item-qty">{item.quantity}×</span>
              <span className="order-item-unit">{fmtCents(item.unitGrossCents)} €</span>
              <span className="order-item-total">{fmtCents(item.lineGrossCents)} €</span>
            </div>
          ))}
        </div>
      </section>

      {order.shippingAddress && (
        <section className="order-detail-section">
          <p className="eyebrow">LIEFERADRESSE</p>
          <div className="portal-address-display">
            {order.shippingAddress.name && <p>{order.shippingAddress.name}</p>}
            <p>{order.shippingAddress.line1}</p>
            {order.shippingAddress.line2 && <p>{order.shippingAddress.line2}</p>}
            <p>{order.shippingAddress.postalCode} {order.shippingAddress.city}</p>
            {order.shippingAddress.state && <p>{order.shippingAddress.state}</p>}
            <p>{getCountryLabel(order.shippingAddress.country)}</p>
          </div>
        </section>
      )}

      <section className="order-detail-section">
        <div className="order-totals">
          <div className="portal-profile-row"><span>Datum</span><strong>{fmtDate(order.placedAt)}</strong></div>
          <div className="portal-profile-row"><span>Zahlungsstatus</span><strong>Bezahlt</strong></div>
          <div className="portal-profile-row order-total-final"><span>Gesamt</span><strong>{fmtCents(order.totalGrossCents)} €</strong></div>
        </div>
      </section>

      <section className="order-success-actions">
        {ownOrder ? (
          <>
            <Link className="cta" href={`/account/orders/${order.id}`}>BESTELLUNG ANSEHEN</Link>
            <Link className="cta secondary" href="/account/dashboard">ZUM KONTO</Link>
            <Link className="order-success-link" href="/shop">Weiter einkaufen</Link>
          </>
        ) : (
          <>
            <Link className="cta" href="/shop">WEITER EINKAUFEN</Link>
            <Link className="order-success-link" href="/account">Zum Konto / Anmelden</Link>
          </>
        )}
      </section>
    </main>
  );
}
