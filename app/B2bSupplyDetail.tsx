"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "../lib/supabase";
import {
  B2B_DELIVERY_STATUS_DE,
  B2B_MAX_SELF_SERVICE_PACKS,
  B2B_MIN_SELF_SERVICE_PACKS,
  B2B_PAYMENT_STATUS_DE,
  b2bHoldReasonDe,
  b2bPlanKind,
  b2bSelfServiceActions,
} from "../lib/b2bChangeRules.ts";

/**
 * THE SELF-SERVICE SUPPLY SCREEN (Package 5G).
 *
 * The B2B area has shown a legacy supply agreement since 4A: an offer
 * model, an interval and eight legacy money columns. A SELF-SERVICE
 * agreement has none of those - migration 059 nulls all eight and
 * replaces them with a plan, a pack count and either a recurring
 * subscription or a frozen twelve-month contract - so it gets its own
 * screen rather than a legacy one with empty rows in it.
 *
 * ── WHAT IT READS, AND WITH WHOSE AUTHORITY ───────────────────
 *
 * Three tables, straight from the browser client, under the customer's
 * own session. Migration 060 already granted exactly this: SELECT to
 * `authenticated`, and a policy on each table that joins back to the
 * agreement and requires `a.user_id = auth.uid()` AND
 * `is_business_user()`. So another business's agreement is not hidden by
 * this component - it is invisible to the query.
 *
 * ── AND WHAT IT DELIBERATELY NEVER RENDERS ────────────────────
 *
 * No Stripe id, no database id, no checkout attempt id, no internal hold
 * token, no berlin_eligibility_snapshot and no shipping_snapshot. The
 * hold token in particular is translated (b2bHoldReasonDe) rather than
 * printed: 'b2b:payment_failed' is a system identifier.
 */

type Agreement = {
  id: string;
  plan_type: string | null;
  status: string;
  currency: string;
  quantity_packs: number | null;
  pending_quantity_packs: number | null;
  pack_grams: number | null;
  pack_net_cents: number | null;
  discount_percent: number | null;
  delivery_count: number | null;
  base_monthly_product_net_cents: number | null;
  contract_product_net_cents: number | null;
  instalment_count: number | null;
  started_at: string | null;
  commitment_end_at: string | null;
  next_delivery_at: string | null;
  ended_at: string | null;
  cancellation_requested_at: string | null;
  cancellation_effective_at: string | null;
  business_snapshot: Record<string, unknown> | null;
};

type PaymentRow = {
  id: string;
  instalment_number: number;
  due_at: string;
  status: string;
  net_cents: number;
  gross_cents: number | null;
  paid_at: string | null;
  failed_at: string | null;
  action_required_at: string | null;
};

type DeliveryRow = {
  id: string;
  delivery_number: number;
  scheduled_for: string;
  quantity_packs: number;
  status: string;
  hold_reason: string | null;
  delivery_address_snapshot: Record<string, unknown> | null;
  tracking_number: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
};

const AGREEMENT_COLUMNS =
  "id, plan_type, status, currency, quantity_packs, pending_quantity_packs, "
  + "pack_grams, pack_net_cents, discount_percent, delivery_count, "
  + "base_monthly_product_net_cents, contract_product_net_cents, instalment_count, "
  + "started_at, commitment_end_at, next_delivery_at, ended_at, "
  + "cancellation_requested_at, cancellation_effective_at, business_snapshot";

const fmtCents = (cents: number) =>
  (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });

const PLAN_LABEL: Record<string, string> = {
  monthly: "Monatlich",
  annual: "Jahresvertrag",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Wird eingerichtet",
  active: "Aktiv",
  cancelled: "Beendet",
  completed: "Abgeschlossen",
};

/** The address a delivery was actually routed to, in the 060 shape. */
function addressLine(snapshot: Record<string, unknown> | null): string | null {
  if (!snapshot) return null;
  const s = snapshot as Record<string, string | null | undefined>;
  const parts = [
    [s.line1, s.line2].filter(Boolean).join(" "),
    [s.postalCode, s.city].filter(Boolean).join(" "),
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export function B2bSupplyDetail({ supplyId }: { supplyId: string }) {
  const [agreement, setAgreement] = useState<Agreement | null>(null);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [loading, setLoading] = useState(() => !!supabase);
  const [notFound, setNotFound] = useState(!supabase);

  // The two customer actions.
  const [packs, setPacks] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const load = async () => {
    if (!supabase) return;
    const [a, p, d] = await Promise.all([
      supabase.from("b2b_supply_agreements").select(AGREEMENT_COLUMNS).eq("id", supplyId).maybeSingle(),
      supabase.from("b2b_payment_schedule")
        .select("id, instalment_number, due_at, status, net_cents, gross_cents, paid_at, failed_at, action_required_at")
        .eq("supply_agreement_id", supplyId).order("instalment_number"),
      supabase.from("b2b_deliveries")
        .select("id, delivery_number, scheduled_for, quantity_packs, status, hold_reason, "
          + "delivery_address_snapshot, tracking_number, dispatched_at, delivered_at")
        .eq("supply_agreement_id", supplyId).order("delivery_number"),
    ]);
    if (!a.data) { setNotFound(true); setLoading(false); return; }
    const row = a.data as unknown as Agreement;
    setAgreement(row);
    setPacks(row.pending_quantity_packs ?? row.quantity_packs ?? 1);
    setPayments((p.data ?? []) as unknown as PaymentRow[]);
    setDeliveries((d.data ?? []) as unknown as DeliveryRow[]);
    setLoading(false);
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [supplyId]);

  if (loading) return <p className="portal-loading">Laden…</p>;

  if (notFound || !agreement) return (
    <>
      <section className="portal-page-head">
        <p className="eyebrow">BELIEFERUNG</p>
        <h1>Belieferung nicht gefunden.</h1>
      </section>
      <Link href="/account/business" className="portal-back-link">&larr; Zurück zu B2B</Link>
    </>
  );

  const kind = b2bPlanKind(agreement.plan_type);
  const actions = b2bSelfServiceActions(agreement);
  const monthlyGrossHint = agreement.base_monthly_product_net_cents;

  /** Both actions share one call shape, one error handling and one reload. */
  const post = async (path: string, body: Record<string, unknown>, success: string) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const { data: { session } } = await supabase!.auth.getSession();
      if (!session?.access_token) { setError("Bitte melde dich an."); return; }
      const res = await fetch(`/api/b2b/supply/${agreement.id}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        // The server copy is already customer-safe; the fallback never
        // exposes a raw error.
        setError(typeof payload?.error === "string" ? payload.error : "Das hat gerade nicht geklappt.");
        return;
      }
      setNotice(success);
      await load();
    } catch {
      setError("Das hat gerade nicht geklappt.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Link href="/account/business" className="portal-back-link">&larr; B2B</Link>

      <section className="portal-page-head">
        <p className="eyebrow">BELIEFERUNG</p>
        <h1>{PLAN_LABEL[agreement.plan_type ?? ""] ?? "Belieferung"}</h1>
        <p className="portal-page-lead">
          {agreement.quantity_packs ?? "—"} × {agreement.pack_grams ?? 500} g GLOA Matcha pro Lieferung.
        </p>
      </section>

      {/* ── THE AGREEMENT ── */}
      <div className="order-detail-meta">
        <div className="portal-profile-row"><span>Modell</span><strong>{PLAN_LABEL[agreement.plan_type ?? ""] ?? "—"}</strong></div>
        <div className="portal-profile-row"><span>Status</span><strong>{STATUS_LABEL[agreement.status] ?? agreement.status}</strong></div>
        <div className="portal-profile-row"><span>Menge</span><strong>{agreement.quantity_packs ?? "—"} Packungen</strong></div>
        {agreement.pending_quantity_packs !== null && (
          <div className="portal-profile-row">
            <span>Ab nächster Abrechnung</span>
            <strong>{agreement.pending_quantity_packs} Packungen</strong>
          </div>
        )}
        {agreement.started_at && (
          <div className="portal-profile-row"><span>Beginn</span><strong>{fmtDate(agreement.started_at)}</strong></div>
        )}
        {kind === "annual" && agreement.commitment_end_at && (
          <div className="portal-profile-row"><span>Vertrag bis</span><strong>{fmtDate(agreement.commitment_end_at)}</strong></div>
        )}
        {kind === "monthly" && monthlyGrossHint !== null && (
          <div className="portal-profile-row">
            <span>Produkt netto pro Monat</span>
            <strong>{fmtCents(monthlyGrossHint)} €</strong>
          </div>
        )}
        {kind === "annual" && agreement.contract_product_net_cents !== null && (
          <>
            <div className="portal-profile-row">
              <span>Vertragssumme netto</span>
              <strong>{fmtCents(agreement.contract_product_net_cents)} €</strong>
            </div>
            {agreement.discount_percent !== null && (
              <div className="portal-profile-row"><span>Rabatt</span><strong>{agreement.discount_percent} %</strong></div>
            )}
            {agreement.instalment_count !== null && (
              <div className="portal-profile-row"><span>Raten</span><strong>{agreement.instalment_count}</strong></div>
            )}
          </>
        )}
        {agreement.cancellation_effective_at && (
          <div className="portal-profile-row">
            <span>Endet am</span>
            <strong>{fmtDate(agreement.cancellation_effective_at)}</strong>
          </div>
        )}
        {agreement.ended_at && (
          <div className="portal-profile-row"><span>Beendet am</span><strong>{fmtDate(agreement.ended_at)}</strong></div>
        )}
      </div>

      {/* ── THE ANNUAL PAYMENT SCHEDULE ── */}
      {payments.length > 0 && (
        <section className="order-detail-section">
          <p className="eyebrow">ZAHLUNGSPLAN</p>
          <div className="supply-list">
            <div className="supply-list-header">
              <span>Rate</span><span>Fällig</span><span>Status</span><span>Betrag</span>
            </div>
            {payments.map(p => (
              <div key={p.id} className="supply-list-row">
                <span className="supply-list-name">{p.instalment_number} von {agreement.instalment_count ?? payments.length}</span>
                <span>{p.paid_at ? `bezahlt ${fmtDate(p.paid_at)}` : fmtDate(p.due_at)}</span>
                <span>{B2B_PAYMENT_STATUS_DE[p.status] ?? p.status}</span>
                <span className="supply-list-total">
                  {p.gross_cents !== null
                    ? `${fmtCents(p.gross_cents)} € brutto`
                    : `${fmtCents(p.net_cents)} € netto`}
                </span>
              </div>
            ))}
          </div>
          <p className="portal-note">
            Beträge in Euro. Bis zur Rechnungsstellung steht der Nettobetrag, danach der Bruttobetrag.
          </p>
        </section>
      )}

      {/* ── THE DELIVERIES ── */}
      <section className="order-detail-section">
        <p className="eyebrow">LIEFERUNGEN</p>
        {deliveries.length === 0 ? (
          <p className="portal-empty">Noch keine Lieferung geplant.</p>
        ) : (
          <div className="supply-list">
            <div className="supply-list-header">
              <span>Lieferung</span><span>Termin</span><span>Status</span><span>Menge</span>
            </div>
            {deliveries.map(d => (
              <div key={d.id} className="supply-list-row">
                <span className="supply-list-name">
                  Nr. {d.delivery_number}
                  {addressLine(d.delivery_address_snapshot) && (
                    <span className="order-item-variant">{addressLine(d.delivery_address_snapshot)}</span>
                  )}
                  {d.hold_reason && (
                    <span className="order-item-variant">{b2bHoldReasonDe(d.hold_reason)}</span>
                  )}
                  {d.tracking_number && (
                    <span className="order-item-variant">Sendung {d.tracking_number}</span>
                  )}
                </span>
                <span>
                  {d.delivered_at ? fmtDate(d.delivered_at)
                    : d.dispatched_at ? fmtDate(d.dispatched_at)
                      : fmtDate(d.scheduled_for)}
                </span>
                <span>{B2B_DELIVERY_STATUS_DE[d.status] ?? d.status}</span>
                <span className="supply-list-total">{d.quantity_packs} × {agreement.pack_grams ?? 500} g</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── WHAT THE CUSTOMER MAY DO ── */}
      <section className="order-detail-section">
        <p className="eyebrow">ÄNDERN</p>

        {notice && <p className="portal-note">{notice}</p>}
        {error && <p className="portal-error">{error}</p>}

        {actions.blockedReason && <p className="portal-note">{actions.blockedReason}</p>}

        {actions.mayChangeQuantity && (
          <div className="portal-field">
            <label htmlFor="b2b-packs">Menge pro Lieferung</label>
            <select
              id="b2b-packs"
              value={packs ?? 1}
              disabled={busy}
              onChange={e => setPacks(Number(e.target.value))}
            >
              {Array.from(
                { length: B2B_MAX_SELF_SERVICE_PACKS - B2B_MIN_SELF_SERVICE_PACKS + 1 },
                (unused, i) => B2B_MIN_SELF_SERVICE_PACKS + i
              ).map(n => (
                <option key={n} value={n}>{n} × {agreement.pack_grams ?? 500} g</option>
              ))}
            </select>
            <p className="portal-note">
              Eine neue Menge gilt ab der nächsten Abrechnung. Die laufende Periode und
              die bereits bezahlte Lieferung bleiben unverändert.
            </p>
            <button
              type="button"
              className="portal-action"
              disabled={busy || packs === null}
              onClick={() => void post("quantity", { quantityPacks: packs }, "Deine neue Menge gilt ab der nächsten Abrechnung.")}
            >
              MENGE ÄNDERN
            </button>
          </div>
        )}

        {actions.mayCancel && (
          <div className="portal-field">
            {!confirmCancel ? (
              <button
                type="button"
                className="portal-action"
                disabled={busy}
                onClick={() => setConfirmCancel(true)}
              >
                BELIEFERUNG KÜNDIGEN
              </button>
            ) : (
              <>
                <p className="portal-note">
                  Deine Belieferung endet zum nächsten Abrechnungstermin, wenn deine Kündigung
                  mindestens 14 Tage vorher bei uns ist. Danach endet sie eine Abrechnungsperiode
                  später. Das genaue Enddatum zeigen wir dir sofort nach der Kündigung.
                </p>
                <label htmlFor="b2b-cancel-reason">Grund (optional)</label>
                <textarea
                  id="b2b-cancel-reason"
                  value={cancelReason}
                  maxLength={500}
                  disabled={busy}
                  onChange={e => setCancelReason(e.target.value)}
                />
                <button
                  type="button"
                  className="portal-action"
                  disabled={busy}
                  onClick={() => void post(
                    "cancel",
                    cancelReason.trim() ? { reason: cancelReason.trim() } : {},
                    "Deine Kündigung ist vorgemerkt. Das Enddatum steht oben."
                  )}
                >
                  KÜNDIGUNG ABSCHICKEN
                </button>
                <button
                  type="button"
                  className="portal-action"
                  disabled={busy}
                  onClick={() => { setConfirmCancel(false); setCancelReason(""); }}
                >
                  ABBRECHEN
                </button>
              </>
            )}
          </div>
        )}

        <p className="portal-note">
          Deine Lieferadresse verwaltest du unter{" "}
          <Link href="/account/addresses">Adressen</Link>. Eine neue Standardadresse gilt für
          die nächste noch nicht disponierte Lieferung; bereits disponierte Lieferungen behalten
          ihre Adresse.
        </p>
      </section>
    </>
  );
}
