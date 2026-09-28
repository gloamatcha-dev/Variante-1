"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { getCountryLabel } from "../lib/shipping";
import type { AddressSnapshot } from "../lib/orderAddressSnapshot";
import {
  getLifecycleSteps,
  getStatusDetailText,
  getTrackingView,
  getRefundView,
  getCancellationView,
  getPrimaryStatusLabel,
  getPaymentStatusLabel,
  type OrderLifecycleFields,
} from "../lib/orderStatus";

/**
 * THE GUEST'S OWN ORDER PAGE.
 *
 * Reached only from the "BESTELLUNG VERWALTEN" link in the order
 * confirmation mail, which carries an opaque token as ?token=. No login,
 * no account, no email entry - a guest paid without registering, and this
 * is where they look at what they bought and ask us to stop it if they
 * change their mind before it ships.
 *
 * ── IT IS THE ACCOUNT ORDER PAGE'S LOGIC, NOT A COPY OF IT ────
 *
 * Every label, step, refund line and cancellation state on this page is
 * computed by lib/orderStatus.ts - the same seven functions
 * app/AccountPortal.tsx's OrderDetail calls, over the same fields. So
 * "Storniert", "Teilweise erstattet", "Wir prüfen" and "schon unterwegs"
 * cannot mean one thing on the account page and another here, and a
 * future change to any of them lands on both at once.
 *
 * The CSS classes are the account page's too (order-status, order-steps,
 * order-detail-section, order-cancel, portal-profile-row), so this is the
 * existing GLOA design rather than a second look for the same content.
 *
 * ── NOTHING HERE DECIDES ANYTHING ─────────────────────────────
 *
 * The component holds no rule about whether a cancellation is possible:
 * it renders getCancellationView()'s answer, and pressing the button
 * POSTs a token. The server re-resolves the order, re-takes the row lock
 * and re-applies the one database rule - so a page left open across a
 * shipment, or an edited DOM, changes nothing about the outcome.
 *
 * ── NOTHING ADMIN, AND NO MONEY BACK ──────────────────────────
 *
 * There is no refund button, no shipping control, no status selector, no
 * price field, no admin note, no order id anywhere in the payload, and
 * nothing that could change who the order belongs to. The only verb this
 * page has is "ask".
 */

/** Exactly the payload POST /api/orders/guest returns. No identifier in it. */
type GuestOrderView = {
  orderNumber: string;
  placedAt: string;
  currency: string;
  subtotalGrossCents: number;
  discountGrossCents: number;
  shippingGrossCents: number | null;
  taxTotalCents: number | null;
  totalGrossCents: number;
  lifecycle: OrderLifecycleFields;
  shippingAddress: AddressSnapshot | null;
  items: {
    productName: string;
    variantLabel: string | null;
    quantity: number;
    unitGrossCents: number;
    lineGrossCents: number;
  }[];
};

type LoadState = "loading" | "no-token" | "not-found" | "error" | "ready";

const fmtCents = (cents: number) => (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });

const MAX_NOTE_LEN = 2000;

/** The shape check the server repeats. Saves a round trip on a mangled link. */
const TOKEN_RE = /^[0-9a-f]{64}$/;

/**
 * THE ACCOUNT PORTAL'S OWN SHELL, WITHOUT THE ACCOUNT NAV.
 *
 * app/AccountPortal.tsx renders every one of its pages inside
 * <main className="portal"><div className="portal-content">, and every
 * class this page uses is styled against that nesting. Reusing it is what
 * makes a guest order look like a GLOA order page rather than a second
 * design for the same content.
 *
 * What is deliberately absent is the portal-nav: there is no account to
 * navigate, no other order to reach and nothing to sign out of. A link
 * opens exactly one order, and the page offers exactly that.
 */
function Shell({ children }: { children: React.ReactNode }) {
  return <main className="portal"><div className="portal-content">{children}</div></main>;
}

export function GuestOrder() {
  // undefined = server render (no window yet), null = genuinely absent or
  // malformed. A lazy initializer rather than an effect, mirroring how
  // OrderSuccess() reads session_id.
  const [token] = useState<string | null | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    const raw = new URLSearchParams(window.location.search).get("token");
    return raw && TOKEN_RE.test(raw) ? raw : null;
  });

  const [state, setState] = useState<LoadState>("loading");
  const [order, setOrder] = useState<GuestOrderView | null>(null);

  const [cancelNote, setCancelNote] = useState("");
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const [cancelMessage, setCancelMessage] = useState("");

  useEffect(() => {
    if (token === undefined) return; // still server-rendering
    if (!token) { setState("no-token"); return; }

    let cancelled = false;
    (async () => {
      try {
        // POST, and the token in the BODY. A GET would put a live
        // credential in the request line, where the platform's access log
        // keeps it.
        const res = await fetch("/api/orders/guest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.status === 404) { setState("not-found"); return; }
        if (!res.ok || !body?.order) { setState("error"); return; }
        setOrder(body.order as GuestOrderView);
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const submitCancellationRequest = async () => {
    if (!token) return;
    setCancelBusy(true);
    setCancelError("");
    try {
      const res = await fetch("/api/orders/guest/cancellation-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The token and an optional reason. NO order id - the browser was
        // never told one, so there is nothing here to tamper with.
        body: JSON.stringify({ token, note: cancelNote.trim() || undefined }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // The server's copy is already customer-safe; the fallback never
        // exposes a raw error.
        setCancelError(typeof body?.error === "string" ? body.error : "Das hat gerade nicht geklappt.");
        return;
      }
      setCancelMessage(typeof body?.message === "string" ? body.message : "Wir prüfen, ob die Bestellung noch gestoppt werden kann.");
    } catch {
      setCancelError("Das hat gerade nicht geklappt.");
    } finally {
      setCancelBusy(false);
    }
  };

  if (state === "loading") return (
    <Shell>
      <section className="portal-page-head">
        <p className="eyebrow">BESTELLUNG</p>
        <h1>Laden…</h1>
      </section>
    </Shell>
  );

  /*
    ONE MESSAGE FOR EVERY WAY A LINK CAN OPEN NOTHING.

    A missing token, a mangled one, a token that was never issued and a
    revoked one all land here and read the same. The server already
    answers all four with the same 404 and the same sentence; saying more
    on the page would give back what the API deliberately withholds.
  */
  if (state === "no-token" || state === "not-found") return (
    <Shell>
      <section className="portal-page-head">
        <p className="eyebrow">BESTELLUNG</p>
        <h1>Dieser Link ist nicht (mehr) gültig.</h1>
        <p className="portal-page-lead">
          Prüf bitte, ob du den vollständigen Link aus deiner Bestellbestätigung geöffnet hast. Wir helfen dir
          jederzeit unter <a href="mailto:support@gloamatcha.com" className="order-cancel-link">support@gloamatcha.com</a>.
        </p>
      </section>
      <Link href="/" className="portal-back-link">&larr; Zur Startseite</Link>
    </Shell>
  );

  if (state === "error" || !order) return (
    <Shell>
      <section className="portal-page-head">
        <p className="eyebrow">BESTELLUNG</p>
        <h1>Das klappt gerade nicht.</h1>
        <p className="portal-page-lead">
          Bitte versuch es in einem Moment noch einmal, oder schreib uns an{" "}
          <a href="mailto:support@gloamatcha.com" className="order-cancel-link">support@gloamatcha.com</a>.
        </p>
      </section>
      <Link href="/" className="portal-back-link">&larr; Zur Startseite</Link>
    </Shell>
  );

  // The SAME seven readers the account order page uses, over the same
  // fields. No rule of this page's own.
  const life = order.lifecycle;
  const steps = getLifecycleSteps(life);
  const statusDetail = getStatusDetailText(life);
  const tracking = getTrackingView(life);
  const refund = getRefundView(life);
  const cancellation = getCancellationView(life);
  const cancellationRequested = cancellation.state === "requested" || cancelMessage !== "";
  const ship = order.shippingAddress;

  return (
    <Shell>
      <section className="portal-page-head">
        <p className="eyebrow">BESTELLUNG {order.orderNumber}</p>
        <h1>{order.orderNumber}</h1>
      </section>

      {/* ── Status ── */}
      <section className="order-status">
        <p className="order-status-label">{getPrimaryStatusLabel(life)}</p>
        {statusDetail && <p className="order-status-text">{statusDetail}</p>}
        {steps.length > 0 && (
          <ol className="order-steps">
            {steps.map(step => (
              <li key={step.key} className={`order-step is-${step.state}`}>
                <span className="order-step-dot" aria-hidden="true" />
                <span>{step.label}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div className="order-detail-meta">
        <div className="portal-profile-row"><span>Datum</span><strong>{fmtDate(order.placedAt)}</strong></div>
        <div className="portal-profile-row"><span>Zahlung</span><strong>{getPaymentStatusLabel(life)}</strong></div>
        {/* A refund amount is only ever shown when it was actually
            recorded. An order flagged refunded without a stored amount
            says so in words instead of printing an invented number. */}
        {refund.kind === "full" && (
          <div className="portal-profile-row"><span>Erstattet</span><strong>{fmtCents(refund.amountCents)} €</strong></div>
        )}
        {refund.kind === "partial" && (
          <div className="portal-profile-row"><span>Teilweise erstattet</span><strong>{fmtCents(refund.amountCents)} €</strong></div>
        )}
        {refund.kind === "unknown_amount" && (
          <div className="portal-profile-row"><span>{refund.partial ? "Teilweise erstattet" : "Erstattet"}</span><strong>Betrag folgt</strong></div>
        )}
      </div>

      {/* ── Sendung (only when tracking data actually exists) ── */}
      {tracking && (
        <section className="order-detail-section">
          <p className="eyebrow">SENDUNG</p>
          <div className="order-tracking">
            {tracking.shippedAt && (
              <div className="portal-profile-row"><span>Versendet am</span><strong>{fmtDate(tracking.shippedAt)}</strong></div>
            )}
            {tracking.carrier && (
              <div className="portal-profile-row"><span>Versanddienst</span><strong>{tracking.carrier}</strong></div>
            )}
            {tracking.trackingNumber && (
              <div className="portal-profile-row"><span>Sendungsnummer</span><strong className="order-tracking-number">{tracking.trackingNumber}</strong></div>
            )}
            {/* Rendered only for a validated absolute http(s) URL - see
                sanitizeTrackingUrl. No URL is ever built from a carrier
                name, so a missing link simply means no link.
                noreferrer, so a carrier never receives the token. */}
            {tracking.url && (
              <a className="cta order-tracking-link" href={tracking.url} target="_blank" rel="noopener noreferrer">
                Sendung verfolgen <span aria-hidden="true">↗</span>
              </a>
            )}
          </div>
        </section>
      )}

      {/* ── Stornierung anfragen ── */}
      {(cancellation.state === "eligible" || cancellationRequested || cancellation.state === "declined" || cancellation.state === "too_late") && (
        <section className="order-detail-section">
          <p className="eyebrow">STORNIERUNG</p>
          {/* The same four branches, in the same order, as the account
              order page - declined FIRST, because it is terminal
              (migration 031) and must never keep reading "wir prüfen". */}
          {cancellation.state === "declined" ? (
            <p className="order-cancel-note">
              Deine Stornierungsanfrage konnten wir nicht mehr umsetzen. Die Bestellung bleibt bestehen und wird
              normal bearbeitet. Nach Erhalt kannst du dein{" "}
              <Link href="/widerruf" className="order-cancel-link">Widerrufsrecht</Link> nutzen.
            </p>
          ) : cancellationRequested ? (
            <p className="order-cancel-note">{cancelMessage || "Wir prüfen, ob die Bestellung noch gestoppt werden kann, und melden uns per E-Mail."}</p>
          ) : cancellation.state === "too_late" ? (
            <p className="order-cancel-note">
              Diese Bestellung ist schon unterwegs und lässt sich nicht mehr stoppen. Nach Erhalt kannst du dein{" "}
              <Link href="/widerruf" className="order-cancel-link">Widerrufsrecht</Link> nutzen.
            </p>
          ) : (
            <div className="order-cancel">
              <p className="order-cancel-note">Du möchtest die Bestellung doch nicht? Frag uns an, solange sie noch nicht unterwegs ist.</p>
              <label className="order-cancel-label" htmlFor="guest-cancel-note">Grund (optional)</label>
              <textarea
                id="guest-cancel-note"
                className="order-cancel-input"
                value={cancelNote}
                maxLength={MAX_NOTE_LEN}
                rows={3}
                onChange={e => setCancelNote(e.target.value)}
              />
              {cancelError && <p className="order-cancel-error">{cancelError}</p>}
              <button className="cta order-cancel-cta" onClick={submitCancellationRequest} disabled={cancelBusy}>
                {cancelBusy ? "Wird gesendet…" : "Stornierung anfragen"}
              </button>
            </div>
          )}
        </section>
      )}

      {/* ── Items ── */}
      {order.items.length > 0 && (
        <section className="order-detail-section">
          <p className="eyebrow">ARTIKEL</p>
          <div className="order-items-list">
            {order.items.map((item, index) => (
              <div key={`${item.productName}-${item.variantLabel ?? ""}-${index}`} className="order-item-row">
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
      )}

      {/* ── Lieferadresse (only when actually known). No billing address:
             the confirmation mail this link came from does not carry one
             either, and a link is not proof of identity. ── */}
      {ship && (
        <section className="order-detail-section">
          <p className="eyebrow">LIEFERADRESSE</p>
          <div className="portal-address-display">
            {ship.name && <p>{ship.name}</p>}
            <p>{ship.line1}</p>
            {ship.line2 && <p>{ship.line2}</p>}
            <p>{ship.postalCode} {ship.city}</p>
            {ship.state && <p>{ship.state}</p>}
            <p>{getCountryLabel(ship.country)}</p>
          </div>
        </section>
      )}

      {/* ── Totals (only fields that are actually known) ── */}
      <section className="order-detail-section">
        <p className="eyebrow">SUMME</p>
        <div className="order-totals">
          <div className="portal-profile-row"><span>Zwischensumme</span><strong>{fmtCents(order.subtotalGrossCents)} €</strong></div>
          {order.discountGrossCents > 0 && (
            <div className="portal-profile-row"><span>Rabatt</span><strong>&minus;{fmtCents(order.discountGrossCents)} €</strong></div>
          )}
          {typeof order.shippingGrossCents === "number" && (
            <div className="portal-profile-row"><span>Versand</span><strong>{order.shippingGrossCents === 0 ? "Kostenlos" : `${fmtCents(order.shippingGrossCents)} €`}</strong></div>
          )}
          {typeof order.taxTotalCents === "number" && order.taxTotalCents > 0 && (
            <div className="portal-profile-row"><span>MwSt.</span><strong>{fmtCents(order.taxTotalCents)} €</strong></div>
          )}
          <div className="portal-profile-row order-total-final">
            <span>Gesamt</span>
            <strong>{fmtCents(order.totalGrossCents)} €</strong>
          </div>
        </div>
      </section>

      <section className="order-detail-section">
        <p className="order-cancel-note">
          Fragen zu dieser Bestellung? Schreib uns an{" "}
          <a href="mailto:support@gloamatcha.com" className="order-cancel-link">support@gloamatcha.com</a>.
        </p>
      </section>
    </Shell>
  );
}
