"use client";
import { useState } from "react";
import { formatCents } from "../lib/adminOrdersQuery";
import {
  canCancel,
  canRefund,
  canResolveRequest,
  canShip,
  cancellationRefundState,
  emailStatusLabel,
  hasOpenCancellationRequest,
  maxRefundableCents,
  parseEuroToCents,
  type ActionableOrder,
} from "../lib/adminOrderActionRules";

/**
 * THE ORDER ACTIONS, AND THE SECOND CLICK IN FRONT OF EACH ONE.
 *
 * Four things can be done to an order from here: mark it shipped, answer
 * a cancellation request, cancel it, and send money back. Each of them is
 * real and none of them is undoable from this screen, so each is a
 * two-step: the first click opens a confirmation that says exactly what
 * will happen in words, and only the second click sends anything.
 *
 * ── WHAT THIS COMPONENT IS NOT ────────────────────────────────
 *
 * It is not the guard. canShip, canCancel and canRefund decide which
 * buttons appear, and every rule in them is a restatement of one that
 * lives in a database function which decides again, under a row lock, in
 * the same transaction as its write. If this component were wrong the
 * server would refuse and the operator would see why. Hiding a button is
 * a courtesy, never a protection.
 *
 * ── NOTHING IS ASSUMED TO HAVE WORKED ─────────────────────────
 *
 * There is no optimistic state anywhere below. A button goes busy, the
 * server answers, and only then does the screen change - by reloading the
 * order and the list from the server, not by patching a local copy. A
 * failure shows the server's sentence and leaves the order exactly as it
 * was displayed.
 *
 * ── THE DANGEROUS BUTTON IS NEVER THE DEFAULT ─────────────────
 *
 * In every confirmation, "Abbrechen" comes first in the DOM and is what
 * an Enter keypress or a stray tab lands on. The destructive control is
 * second, and only the refund one is coloured - a screen where everything
 * is red teaches the operator to ignore red.
 */

type ActionOrder = ActionableOrder & {
  id: string;
  order_number: string;
  shipping_carrier?: string | null;
  tracking_number?: string | null;
  tracking_url?: string | null;
  shipped_at?: string | null;
  cancellation_request_note?: string | null;
  cancellation_request_resolved_at?: string | null;
  refund_updated_at?: string | null;
  confirmation_email_status?: string | null;
  shipment_email_status?: string | null;
  refund_email_status?: string | null;
  cancellation_outcome_email_status?: string | null;
};

type Pending =
  | null
  | { kind: "ship"; summary: string[]; body: Record<string, unknown> }
  | { kind: "cancel"; summary: string[]; body: Record<string, unknown> }
  | { kind: "resolve"; summary: string[]; body: Record<string, unknown>; decision: string }
  | { kind: "refund"; summary: string[]; body: Record<string, unknown>; amountLabel: string };

const ENDPOINT: Record<string, string> = {
  ship: "/api/admin/orders/ship",
  cancel: "/api/admin/orders/cancel",
  resolve: "/api/admin/orders/resolve-request",
  refund: "/api/admin/orders/refund",
};

/** What the operator is told after the server answered. Never a guess. */
function describeResult(kind: string, data: Record<string, unknown>): string {
  const mail = (o: unknown) =>
    o === "sent" ? "Die Bestätigung wurde versendet."
      : o === "already-sent" ? "Die Bestätigung war bereits versendet."
      : o === "not-eligible" ? "Es war keine Bestätigung fällig."
      : o === "not-attempted" ? "Es wurde noch keine Bestätigung versendet."
      : "Die Bestätigung konnte NICHT versendet werden.";

  if (kind === "ship") {
    const base = data.applied ? "Die Bestellung ist als versendet erfasst." : "Die Bestellung war bereits versendet.";
    return `${base} ${mail(data.emailOutcome)}`;
  }
  if (kind === "cancel") {
    return data.applied
      ? "Die Bestellung ist storniert. Es wurde KEINE Erstattung ausgelöst."
      : "Die Bestellung war bereits storniert.";
  }
  if (kind === "resolve") {
    const word = data.resolution === "approved" ? "angenommen" : "abgelehnt";
    return `Die Stornierungsanfrage wurde ${word}. ${mail(data.emailOutcome)}`;
  }
  const amount = typeof data.amountCents === "number" ? formatCents(data.amountCents) : "Der Betrag";
  if (data.syncResult === "sync_failed") {
    return `${amount} wurde bei Stripe erstattet, die Bestellung konnte aber noch nicht aktualisiert werden. Der Stripe-Webhook holt das nach.`;
  }
  const settled = data.refundStatus === "pending"
    ? `${amount} wurde bei Stripe ausgelöst und ist noch nicht abgeschlossen.`
    : `${amount} wurde erstattet.`;
  return `${settled} ${mail(data.emailOutcome)}`;
}

export function OrderActions({ order, onDone }: { order: ActionOrder; onDone: () => void | Promise<void> }) {
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const [carrier, setCarrier] = useState(order.shipping_carrier ?? "");
  const [trackingNumber, setTrackingNumber] = useState(order.tracking_number ?? "");
  const [trackingUrl, setTrackingUrl] = useState(order.tracking_url ?? "");
  const [refundMode, setRefundMode] = useState<"full" | "partial">("full");
  const [refundInput, setRefundInput] = useState("");

  const ship = canShip(order);
  const cancel = canCancel(order);
  const refund = canRefund(order);
  const resolve = canResolveRequest(order);
  const maxRefund = maxRefundableCents(order);
  const cancelState = cancellationRefundState(order);
  const currency = order.currency ?? "EUR";

  /**
   * Sends one confirmed action.
   *
   * Guarded by `busy` AGAINST A DOUBLE CLICK, which is the weakest of the
   * three protections and the only one that lives in the browser. The
   * other two are real: the database functions are idempotent, and the
   * refund carries a deterministic Stripe idempotency key derived from
   * the order and the amount already refunded.
   */
  async function run(p: NonNullable<Pending>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(ENDPOINT[p.kind], {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p.body),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Die Aktion konnte nicht ausgeführt werden.");
        return;
      }
      setResult(describeResult(p.kind, data));
      setPending(null);
      // The server is the only source of what the order now says.
      await onDone();
    } catch {
      setError("Die Aktion konnte nicht ausgeführt werden. Bitte erneut versuchen.");
    } finally {
      setBusy(false);
    }
  }

  function confirmPanel(p: NonNullable<Pending>, danger: boolean, finalLabel: string) {
    return (
      <div className={`ops-confirm${danger ? " ops-confirm-danger" : ""}`} role="alertdialog" aria-label="Bestätigung">
        <ul className="ops-confirm-facts">
          {p.summary.map(line => <li key={line}>{line}</li>)}
        </ul>
        <div className="ops-confirm-buttons">
          <button type="button" className="ops-btn" onClick={() => setPending(null)} disabled={busy}>
            Abbrechen
          </button>
          <button
            type="button"
            className={danger ? "ops-btn ops-btn-danger" : "ops-btn ops-btn-primary"}
            onClick={() => void run(p)}
            disabled={busy}
          >
            {busy ? "Wird ausgeführt…" : finalLabel}
          </button>
        </div>
      </div>
    );
  }

  const refundAmountCents = refundMode === "full" ? maxRefund : parseEuroToCents(refundInput);
  const refundAmountValid =
    refundAmountCents !== null && refundAmountCents > 0 && refundAmountCents <= maxRefund;

  return (
    <section className="ops-actions" aria-label="Aktionen">
      {result && <p className="ops-action-ok" role="status">{result}</p>}
      {error && <p className="ops-error" role="alert">{error}</p>}

      {/* ── CANCELLATION REQUEST ─────────────────────────────── */}
      {hasOpenCancellationRequest(order) && (
        <div className="ops-action-block ops-action-attention">
          <h4>Stornierungsanfrage offen</h4>
          {order.cancellation_request_note && (
            <p className="ops-action-note">„{order.cancellation_request_note}“</p>
          )}
          <p className="ops-action-note">
            Solange diese Anfrage offen ist, kann die Bestellung nicht versendet werden.
          </p>
          {pending?.kind === "resolve"
            ? confirmPanel(pending, pending.decision === "approve", pending.decision === "approve"
                ? "Anfrage endgültig annehmen"
                : "Anfrage endgültig ablehnen")
            : resolve.allowed && (
              <div className="ops-action-buttons">
                <button
                  type="button" className="ops-btn" disabled={busy}
                  onClick={() => setPending({
                    kind: "resolve", decision: "decline",
                    body: { orderNumber: order.order_number, decision: "decline" },
                    summary: [
                      `Bestellung ${order.order_number}`,
                      "Die Stornierungsanfrage wird ABGELEHNT.",
                      "Die Bestellung bleibt bestehen und kann danach normal versendet werden.",
                      "Der Kunde erhält automatisch eine Nachricht über die Entscheidung.",
                    ],
                  })}
                >Anfrage ablehnen</button>
                <button
                  type="button" className="ops-btn ops-btn-primary" disabled={busy}
                  onClick={() => setPending({
                    kind: "resolve", decision: "approve",
                    body: { orderNumber: order.order_number, decision: "approve" },
                    summary: [
                      `Bestellung ${order.order_number}`,
                      "Die Stornierungsanfrage wird ANGENOMMEN.",
                      "Die Bestellung wird dadurch storniert.",
                      "Es wird dabei KEINE Erstattung ausgelöst – die Erstattung ist ein eigener Schritt.",
                      "Der Kunde erhält automatisch eine Nachricht über die Entscheidung.",
                    ],
                  })}
                >Anfrage annehmen</button>
              </div>
            )}
        </div>
      )}

      {/* ── SHIPMENT ─────────────────────────────────────────── */}
      <div className="ops-action-block">
        <h4>Versand</h4>
        <dl className="ops-facts ops-facts-tight">
          <div><dt>Versanddienst</dt><dd>{order.shipping_carrier || "—"}</dd></div>
          <div><dt>Sendungsnummer</dt><dd>{order.tracking_number || "—"}</dd></div>
          <div><dt>Versendet am</dt><dd>{order.shipped_at ? new Date(order.shipped_at).toLocaleString("de-DE") : "—"}</dd></div>
          <div><dt>Versandbestätigung</dt><dd>{emailStatusLabel(order.shipment_email_status)}</dd></div>
        </dl>

        {!ship.allowed && <p className="ops-action-note">{ship.reason}</p>}

        {ship.allowed && pending?.kind === "ship" && confirmPanel(pending, false, "Versand endgültig bestätigen")}

        {ship.allowed && pending?.kind !== "ship" && (
          <>
            <div className="ops-action-fields">
              <label>
                <span>Versanddienst</span>
                <input
                  type="text" value={carrier} maxLength={100} disabled={busy}
                  onChange={e => setCarrier(e.target.value)} placeholder="z. B. DHL"
                />
              </label>
              <label>
                <span>Sendungsnummer</span>
                <input
                  type="text" value={trackingNumber} maxLength={100} disabled={busy}
                  onChange={e => setTrackingNumber(e.target.value)} placeholder="optional"
                />
              </label>
              <label>
                <span>Tracking-Link</span>
                <input
                  type="url" value={trackingUrl} maxLength={500} disabled={busy}
                  onChange={e => setTrackingUrl(e.target.value)} placeholder="https://… (optional)"
                />
              </label>
            </div>
            {/* No URL is ever built from a tracking number here. A carrier's
                link format is its own business and guessing it produces a
                link that 404s in the customer's inbox. */}
            <p className="ops-action-note">
              Der Tracking-Link wird nicht automatisch erzeugt. Wenn kein Link eingetragen ist,
              nennt die Versandbestätigung nur die Sendungsnummer.
            </p>
            <div className="ops-action-buttons">
              <button
                type="button" className="ops-btn ops-btn-primary" disabled={busy}
                onClick={() => setPending({
                  kind: "ship",
                  body: {
                    orderNumber: order.order_number,
                    carrier: carrier.trim() || null,
                    trackingNumber: trackingNumber.trim() || null,
                    trackingUrl: trackingUrl.trim() || null,
                  },
                  summary: [
                    `Bestellung ${order.order_number} wird als versendet markiert.`,
                    `Versanddienst: ${carrier.trim() || "—"}`,
                    `Sendungsnummer: ${trackingNumber.trim() || "—"}`,
                    `Tracking-Link: ${trackingUrl.trim() || "—"}`,
                    "Der Kunde erhält anschließend automatisch die Versandbestätigung.",
                  ],
                })}
              >Versand bestätigen</button>
            </div>
          </>
        )}
      </div>

      {/* ── PAYMENT / REFUND ─────────────────────────────────── */}
      <div className="ops-action-block">
        <h4>Zahlung / Erstattung</h4>
        <dl className="ops-facts ops-facts-tight">
          <div><dt>Bezahlt</dt><dd>{formatCents(order.total_gross_cents, currency)}</dd></div>
          <div><dt>Bereits erstattet</dt><dd>{formatCents(order.refunded_total_cents ?? 0, currency)}</dd></div>
          <div><dt>Noch erstattbar</dt><dd>{formatCents(maxRefund, currency)}</dd></div>
          <div><dt>Erstattungsbestätigung</dt><dd>{emailStatusLabel(order.refund_email_status)}</dd></div>
        </dl>

        {!refund.allowed && <p className="ops-action-note">{refund.reason}</p>}

        {refund.allowed && pending?.kind === "refund"
          && confirmPanel(pending, true, `${pending.amountLabel} endgültig erstatten`)}

        {refund.allowed && pending?.kind !== "refund" && (
          <>
            <div className="ops-action-fields">
              <label className="ops-radio">
                <input
                  type="radio" name="ops-refund-mode" checked={refundMode === "full"} disabled={busy}
                  onChange={() => setRefundMode("full")}
                />
                <span>Gesamt erstatten ({formatCents(maxRefund, currency)})</span>
              </label>
              <label className="ops-radio">
                <input
                  type="radio" name="ops-refund-mode" checked={refundMode === "partial"} disabled={busy}
                  onChange={() => setRefundMode("partial")}
                />
                <span>Teilbetrag</span>
              </label>
              {refundMode === "partial" && (
                <label>
                  <span>Betrag in {currency}</span>
                  <input
                    type="text" inputMode="decimal" value={refundInput} disabled={busy}
                    onChange={e => setRefundInput(e.target.value)} placeholder="z. B. 9,99"
                  />
                </label>
              )}
            </div>
            {refundMode === "partial" && refundInput.trim() && !refundAmountValid && (
              <p className="ops-action-note">
                Bitte einen Betrag zwischen 0,01 und {formatCents(maxRefund, currency)} eingeben.
              </p>
            )}
            <div className="ops-action-buttons">
              <button
                type="button" className="ops-btn ops-btn-danger" disabled={busy || !refundAmountValid}
                onClick={() => {
                  if (!refundAmountValid || refundAmountCents === null) return;
                  const label = formatCents(refundAmountCents, currency);
                  setPending({
                    kind: "refund",
                    amountLabel: label,
                    // Full refunds send NO amount: the server computes the
                    // maximum from the order, so the browser cannot be the
                    // reason a cent too much goes back.
                    body: refundMode === "full"
                      ? { id: order.id }
                      : { id: order.id, amountCents: refundAmountCents },
                    summary: [
                      `Bestellung ${order.order_number}`,
                      `Es werden ${label} an den Kunden zurückgezahlt.`,
                      "Diese Aktion löst eine echte Rückzahlung über Stripe aus.",
                      "Sie kann durch Schließen dieses Fensters nicht rückgängig gemacht werden.",
                      "Der Kunde erhält anschließend automatisch die Erstattungsbestätigung.",
                    ],
                  });
                }}
              >Erstattung</button>
            </div>
          </>
        )}
      </div>

      {/* ── CANCELLATION ─────────────────────────────────────── */}
      <div className="ops-action-block">
        <h4>Stornierung</h4>
        <dl className="ops-facts ops-facts-tight">
          <div><dt>Status</dt><dd>{cancelState.cancelled ? "Storniert" : "Nicht storniert"}</dd></div>
          {cancelState.cancelled && (
            <div>
              <dt>Erstattung</dt>
              <dd className={cancelState.refundedCents <= 0 ? "ops-open-refund" : undefined}>
                {cancelState.label.replace("Erstattung: ", "")}
                {cancelState.refundedCents > 0 && ` (${formatCents(cancelState.refundedCents, currency)})`}
              </dd>
            </div>
          )}
          <div><dt>Anfrage entschieden</dt><dd>{order.cancellation_request_resolution || "—"}</dd></div>
          <div><dt>Stornobestätigung</dt><dd>{emailStatusLabel(order.cancellation_outcome_email_status)}</dd></div>
        </dl>

        {!cancel.allowed && <p className="ops-action-note">{cancel.reason}</p>}

        {cancel.allowed && pending?.kind === "cancel" && confirmPanel(pending, true, "Bestellung endgültig stornieren")}

        {cancel.allowed && pending?.kind !== "cancel" && (
          <div className="ops-action-buttons">
            <button
              type="button" className="ops-btn" disabled={busy}
              onClick={() => setPending({
                kind: "cancel",
                body: { orderNumber: order.order_number },
                summary: [
                  `Bestellung ${order.order_number} wird storniert.`,
                  "Die Bestellung wird dadurch nicht mehr versendet.",
                  "Es wird KEINE Erstattung ausgelöst – Geld zurückzahlen ist ein eigener Schritt.",
                  maxRefund > 0
                    ? `Offen bleiben ${formatCents(maxRefund, currency)}.`
                    : "Es ist kein erstattbarer Betrag offen.",
                ],
              })}
            >Bestellung stornieren</button>
          </div>
        )}
      </div>

      {/* ── EMAIL STATE ──────────────────────────────────────── */}
      <div className="ops-action-block">
        <h4>E-Mails an den Kunden</h4>
        <dl className="ops-facts ops-facts-tight">
          <div><dt>Bestellbestätigung</dt><dd>{emailStatusLabel(order.confirmation_email_status)}</dd></div>
          <div><dt>Versandbestätigung</dt><dd>{emailStatusLabel(order.shipment_email_status)}</dd></div>
          <div><dt>Erstattungsbestätigung</dt><dd>{emailStatusLabel(order.refund_email_status)}</dd></div>
          <div><dt>Stornoentscheidung</dt><dd>{emailStatusLabel(order.cancellation_outcome_email_status)}</dd></div>
        </dl>
        <p className="ops-action-note">
          Die Bestellbestätigung wird automatisch nach der Zahlung versendet und kann von hier
          aus nicht erneut ausgelöst werden.
        </p>
      </div>
    </section>
  );
}
