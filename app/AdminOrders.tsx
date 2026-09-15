"use client";
import { useCallback, useEffect, useState } from "react";
import { OrderActions } from "./AdminOrderActions";
import {
  FULFILLMENT_STATUSES,
  FULFILLMENT_STATUS_LABEL,
  ORDER_STATUSES,
  ORDER_STATUS_LABEL,
  PAYMENT_STATUSES,
  PAYMENT_STATUS_LABEL,
  addressLines,
  customerFromSnapshot,
  formatCents,
  formatItemSummary,
  formatPieces,
  orderTotalGrams,
  type OrderItemSummary,
  type FulfillmentStatus,
  type OrderStatus,
  type PaymentStatus,
} from "../lib/adminOrdersQuery";

/**
 * THE ORDER SECTION OF THE OPERATIONS SCREEN.
 *
 * Read only, on purpose and structurally: there is no button in this
 * file that changes anything. Refunds, cancellations, shipping and
 * tracking live behind the bearer secrets in /api/internal/orders/* and
 * stay there until a later package wires them up deliberately. What
 * this screen does is answer "what came in, what is paid, what still
 * has to go out" without anybody opening the Supabase console.
 *
 * Every number and every status comes from the orders the checkout
 * already wrote. Nothing here computes a price, a tax or a total: the
 * order snapshots carry all of them and a second calculation would be
 * a second truth.
 *
 * The "Inhalt" column is the same discipline. Product names, variants
 * and quantities are read from order_items - the rows the checkout
 * wrote - and merged for display only. The server sends one summary per
 * order alongside the page, so the browser never fetches per row, and
 * when that summary could not be read in full the column says so rather
 * than showing an order as smaller than it is.
 */

type OrderRow = {
  id: string;
  order_number: string;
  created_at: string;
  placed_at: string | null;
  status: OrderStatus;
  payment_status: PaymentStatus;
  fulfillment_status: FulfillmentStatus;
  customer_type: string;
  currency: string;
  total_gross_cents: number | null;
  refunded_total_cents: number | null;
  cancelled_at: string | null;
  cancellation_requested_at: string | null;
  cancellation_request_resolution: string | null;
  shipping_carrier: string | null;
  tracking_number: string | null;
  customer_snapshot: unknown;
};

type OrderItem = {
  id: string;
  product_name: string;
  variant_name: string | null;
  sku: string | null;
  product_reference: string | null;
  quantity: number;
  unit_price_gross_cents: number | null;
  unit_price_net_cents: number | null;
  line_total_gross_cents: number | null;
  line_total_net_cents: number | null;
  tax_rate_percent: number | null;
  metadata: unknown;
};

type OrderDetail = OrderRow & {
  billing_address_snapshot: unknown;
  shipping_address_snapshot: unknown;
  subtotal_net_cents: number | null;
  subtotal_gross_cents: number | null;
  discount_total_cents: number | null;
  shipping_net_cents: number | null;
  shipping_gross_cents: number | null;
  tax_total_cents: number | null;
  total_net_cents: number | null;
  tax_treatment: string | null;
  tax_vat_country: string | null;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  shipped_at: string | null;
  tracking_url: string | null;
  refund_updated_at: string | null;
  cancellation_request_note: string | null;
  cancellation_request_resolved_at: string | null;
  // The four email state machines, so the operator can see whether the
  // customer was actually told. Written by existing senders; none of
  // them is written from this screen.
  confirmation_email_status: string | null;
  confirmation_email_sent_at: string | null;
  shipment_email_status: string | null;
  shipment_email_sent_at: string | null;
  refund_email_status: string | null;
  refund_email_sent_at: string | null;
  cancellation_outcome_email_status: string | null;
  cancellation_outcome_email_sent_at: string | null;
  cancellation_confirmation_email_status: string | null;
  cancellation_confirmation_email_sent_at: string | null;
};

export type OrdersSummary = {
  total: number | null;
  today: number | null;
  paid: number | null;
  openFulfillment: number | null;
  cancelled: number | null;
  refunded: number | null;
  revenueTodayCents: number | null;
  revenueCapped: boolean;
  dayStartIso: string;
};

type OrdersPayload = {
  rows: OrderRow[];
  /** Compact contents per order id - one server request for the page. */
  itemSummaries: Record<string, OrderItemSummary>;
  /** True when the page's item read was short or failed; the UI says so. */
  itemsCapped: boolean;
  page: number;
  pageSize: number;
  total: number;
  status: OrderStatus | "all";
  payment: PaymentStatus | "all";
  fulfillment: FulfillmentStatus | "all";
  search: string;
  summary: OrdersSummary;
  fetchedAt: string;
};

/** Poll only while the operator is actually looking, and gently. */
const POLL_MS = 45_000;

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("de-DE", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
    timeZone: "Europe/Berlin",
  });
}

function fmtTimeOnly(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
}

/** A short, safe rendering of a Stripe identifier for an ops screen. */
function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  return id.length <= 24 ? id : `${id.slice(0, 14)}…${id.slice(-6)}`;
}

export function AdminOrders({ onSessionLost }: { onSessionLost: () => void }) {
  const [data, setData] = useState<OrdersPayload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);

  const [status, setStatus] = useState<OrderStatus | "all">("all");
  const [payment, setPayment] = useState<PaymentStatus | "all">("all");
  const [fulfillment, setFulfillment] = useState<FulfillmentStatus | "all">("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ order: OrderDetail; items: OrderItem[] } | null>(null);
  const [detailError, setDetailError] = useState("");

  type Query = { status: OrderStatus | "all"; payment: PaymentStatus | "all"; fulfillment: FulfillmentStatus | "all"; search: string; page: number };

  // NOTHING IS SET BEFORE THE FIRST AWAIT. A synchronous setState inside
  // an effect starts a cascading render, and the mount effect calls this
  // directly - so the busy flag is raised after the request is already
  // in flight, and the query travels as an argument rather than through
  // a ref written during render.
  const load = useCallback(async (query: Query, cancelled: () => boolean = () => false) => {
    try {
      const res = await fetch("/api/admin/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(query),
      });
      if (cancelled()) return;
      if (res.status === 401) { onSessionLost(); return; }
      if (!res.ok) {
        setLoadError("Die Bestellungen konnten nicht geladen werden.");
        return;
      }
      const payload = (await res.json()) as OrdersPayload;
      if (cancelled()) return;
      setData(payload);
      setLoadError("");
    } catch {
      if (!cancelled()) setLoadError("Die Bestellungen konnten nicht geladen werden.");
    }
  }, [onSessionLost]);

  // The busy flag belongs to the BUTTON, not to load(). An effect that
  // sets state before its first await starts a cascading render, so the
  // one path that may show a spinner is the one a person clicked.
  const refresh = useCallback(async (query: Query) => {
    setBusy(true);
    try { await load(query); } finally { setBusy(false); }
  }, [load]);

  const query: Query = { status, payment, fulfillment, search, page };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await load({ status, payment, fulfillment, search, page }, () => cancelled);
    })();
    return () => { cancelled = true; };
  }, [load, status, payment, fulfillment, search, page]);

  // NEAR-LIVE, NOT REALTIME. One quiet refresh every 45 seconds, and
  // only while this tab is actually visible - a backgrounded admin
  // screen left open overnight must not keep asking. No websocket, no
  // service-role client in the browser, nothing new to operate.
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (document.visibilityState === "visible") {
        void load({ status, payment, fulfillment, search, page }, () => cancelled);
      }
    };
    const id = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load, status, payment, fulfillment, search, page]);

  const openOrder = useCallback(async (id: string) => {
    setOpenId(id);
    setDetail(null);
    setDetailError("");
    try {
      const res = await fetch("/api/admin/orders/detail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (res.status === 401) { onSessionLost(); return; }
      if (res.status === 404) { setDetailError("Diese Bestellung gibt es nicht mehr."); return; }
      if (!res.ok) { setDetailError("Die Bestellung konnte nicht geladen werden."); return; }
      setDetail((await res.json()) as { order: OrderDetail; items: OrderItem[] });
    } catch {
      setDetailError("Die Bestellung konnte nicht geladen werden.");
    }
  }, [onSessionLost]);

  const closeDetail = useCallback(() => { setOpenId(null); setDetail(null); setDetailError(""); }, []);

  // AFTER AN ACTION, THE SERVER IS ASKED AGAIN - both for the open order
  // and for the page behind it. Nothing is patched locally and nothing
  // waits for the 45-second poll: an operator who just shipped an order
  // must see what the order actually says now, not what this tab
  // predicted it would say.
  const reloadAfterAction = useCallback(async () => {
    const id = openId;
    await load({ status, payment, fulfillment, search, page });
    if (!id) return;
    try {
      const res = await fetch("/api/admin/orders/detail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (res.status === 401) { onSessionLost(); return; }
      if (!res.ok) return;
      setDetail((await res.json()) as { order: OrderDetail; items: OrderItem[] });
    } catch {
      // The action already succeeded and said so. A failed re-read is
      // not a failed action, and the next poll will catch up.
    }
  }, [load, openId, status, payment, fulfillment, search, page, onSessionLost]);

  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeDetail(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openId, closeDetail]);

  const reset = (next: Partial<{ status: OrderStatus | "all"; payment: PaymentStatus | "all"; fulfillment: FulfillmentStatus | "all"; search: string }>) => {
    if (next.status !== undefined) setStatus(next.status);
    if (next.payment !== undefined) setPayment(next.payment);
    if (next.fulfillment !== undefined) setFulfillment(next.fulfillment);
    if (next.search !== undefined) setSearch(next.search);
    setPage(1);
  };

  if (!data && loadError) {
    return (
      <section className="ops-panel" aria-label="Bestellungen">
        <p className="ops-error" role="alert">{loadError}</p>
        <button type="button" className="ops-refresh" onClick={() => void refresh(query)}>Erneut versuchen</button>
      </section>
    );
  }
  if (!data) {
    return <section className="ops-panel" aria-label="Bestellungen"><p className="ops-loading">Bestellungen werden geladen…</p></section>;
  }

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const filtered = status !== "all" || payment !== "all" || fulfillment !== "all" || search !== "";

  return (
    <>
      <section className="ops-counts" aria-label="Kennzahlen">
        {([
          ["Heute", data.summary.today],
          ["Umsatz heute", data.summary.revenueTodayCents === null ? null : formatCents(data.summary.revenueTodayCents)],
          ["Bestellungen gesamt", data.summary.total],
          ["Bezahlt", data.summary.paid],
          ["Zu versenden", data.summary.openFulfillment],
          ["Storniert", data.summary.cancelled],
          ["Mit Erstattung", data.summary.refunded],
        ] as [string, string | number | null][]).map(([label, value]) => (
          <div className="ops-count" key={label}>
            <span className="ops-count-value">{value === null ? "—" : value}</span>
            <span className="ops-count-label">{label}</span>
          </div>
        ))}
      </section>

      <section className="ops-controls" aria-label="Bestellungen filtern">
        <div className="ops-filter-row">
          <label htmlFor="ops-o-payment">Zahlung</label>
          <select id="ops-o-payment" value={payment} onChange={e => reset({ payment: e.target.value as PaymentStatus | "all" })}>
            <option value="all">Alle</option>
            {PAYMENT_STATUSES.map(s => <option key={s} value={s}>{PAYMENT_STATUS_LABEL[s]}</option>)}
          </select>

          <label htmlFor="ops-o-fulfil">Versand</label>
          <select id="ops-o-fulfil" value={fulfillment} onChange={e => reset({ fulfillment: e.target.value as FulfillmentStatus | "all" })}>
            <option value="all">Alle</option>
            {FULFILLMENT_STATUSES.map(s => <option key={s} value={s}>{FULFILLMENT_STATUS_LABEL[s]}</option>)}
          </select>

          <label htmlFor="ops-o-status">Bestellung</label>
          <select id="ops-o-status" value={status} onChange={e => reset({ status: e.target.value as OrderStatus | "all" })}>
            <option value="all">Alle</option>
            {ORDER_STATUSES.map(s => <option key={s} value={s}>{ORDER_STATUS_LABEL[s]}</option>)}
          </select>
        </div>

        <form className="ops-search" onSubmit={e => { e.preventDefault(); reset({ search: searchInput }); }}>
          <label htmlFor="ops-o-search">Suche</label>
          <input
            id="ops-o-search" type="search" placeholder="Bestellnummer, Name oder E-Mail"
            value={searchInput} onChange={e => setSearchInput(e.target.value)}
          />
          <button type="submit">Suchen</button>
        </form>
      </section>

      <div className="ops-refresh-bar">
        <button type="button" className="ops-refresh" onClick={() => void refresh(query)} disabled={busy}>
          {busy ? "Wird aktualisiert…" : "Aktualisieren"}
        </button>
        <span className="ops-refresh-at">Zuletzt aktualisiert {fmtTimeOnly(data.fetchedAt)} Uhr</span>
        {loadError && <span className="ops-error" role="alert">{loadError}</span>}
        {data.itemsCapped && (
          <span className="ops-note">
            Der Inhalt einzelner Bestellungen konnte nicht vollständig gelesen werden – die Spalte
            {" "}„Inhalt“ kann unvollständig sein. Die Detailansicht zeigt alle Positionen.
          </span>
        )}
      </div>

      <div className="ops-table-wrap">
        <table className="ops-table ops-orders">
          <thead>
            <tr>
              <th scope="col">Bestellung</th>
              <th scope="col">Datum</th>
              <th scope="col">Kunde</th>
              <th scope="col">Inhalt</th>
              <th scope="col">Betrag</th>
              <th scope="col">Zahlung</th>
              <th scope="col">Versand</th>
              <th scope="col">Status</th>
              <th scope="col">Hinweis</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={9} className="ops-empty">
                  {filtered ? "Keine Bestellung passt zu diesem Filter." : "Noch keine Bestellungen."}
                </td>
              </tr>
            )}
            {data.rows.map(r => {
              const c = customerFromSnapshot(r.customer_snapshot);
              const refunded = (r.refunded_total_cents ?? 0) > 0;
              const contents = data.itemSummaries?.[r.id];
              return (
                <tr key={r.id} className="ops-order-row" onClick={() => void openOrder(r.id)}>
                  <td data-label="Bestellung">
                    <button type="button" className="ops-order-open" onClick={e => { e.stopPropagation(); void openOrder(r.id); }}>{r.order_number}</button>
                  </td>
                  <td data-label="Datum">{fmtDateTime(r.placed_at || r.created_at)}</td>
                  <td data-label="Kunde">
                    <span className="ops-order-name">{c.name || "—"}</span>
                    {c.email && <span className="ops-mail">{c.email}</span>}
                  </td>
                  <td data-label="Inhalt" className="ops-order-items">
                    <span className="ops-item-line">{formatItemSummary(contents)}</span>
                    <span className="ops-item-count">{formatPieces(contents?.pieces)}</span>
                  </td>
                  <td data-label="Betrag">{formatCents(r.total_gross_cents, r.currency)}</td>
                  <td data-label="Zahlung">
                    <span className={`ops-status ops-pay-${r.payment_status}`}>{PAYMENT_STATUS_LABEL[r.payment_status] ?? r.payment_status}</span>
                  </td>
                  <td data-label="Versand">
                    <span className={`ops-status ops-ful-${r.fulfillment_status}`}>{FULFILLMENT_STATUS_LABEL[r.fulfillment_status] ?? r.fulfillment_status}</span>
                  </td>
                  <td data-label="Status">
                    <span className={`ops-status ops-ord-${r.status}`}>{ORDER_STATUS_LABEL[r.status] ?? r.status}</span>
                  </td>
                  <td data-label="Hinweis" className="ops-order-flags">
                    {refunded && <span className="ops-flag ops-flag-refund">Erstattung</span>}
                    {r.cancellation_requested_at && !r.cancellation_request_resolution && <span className="ops-flag ops-flag-cancel">Storno angefragt</span>}
                    {r.cancelled_at && <span className="ops-flag ops-flag-cancel">Storniert</span>}
                    {r.tracking_number && <span className="ops-flag ops-flag-track">Tracking</span>}
                    {!refunded && !r.cancellation_requested_at && !r.cancelled_at && !r.tracking_number && "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <nav className="ops-pager" aria-label="Seiten">
        <button type="button" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>Zurück</button>
        <span>Seite {data.page} von {pages} · {data.total} Bestellungen</span>
        <button type="button" disabled={data.page >= pages} onClick={() => setPage(data.page + 1)}>Weiter</button>
      </nav>

      {openId && (
        <div className="ops-drawer-backdrop">
          <button type="button" className="ops-drawer-scrim" aria-label="Bestelldetails schließen" onClick={closeDetail} />
          <aside
            className="ops-drawer" role="dialog" aria-modal="true" aria-label="Bestelldetails"
          >
            <header className="ops-drawer-head">
              <h2>{detail?.order.order_number ?? "Bestellung"}</h2>
              <button type="button" className="ops-drawer-close" onClick={closeDetail} aria-label="Schließen">×</button>
            </header>

            {detailError && <p className="ops-error" role="alert">{detailError}</p>}
            {!detail && !detailError && <p className="ops-loading">Wird geladen…</p>}

            {detail && <OrderDetailBody order={detail.order} items={detail.items} onActionDone={reloadAfterAction} />}
          </aside>
        </div>
      )}
    </>
  );
}

function Facts({ title, rows }: { title: string; rows: [string, React.ReactNode][] }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (shown.length === 0) return null;
  return (
    <section className="ops-drawer-section">
      <h3>{title}</h3>
      <dl className="ops-facts">
        {shown.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
    </section>
  );
}

function OrderDetailBody(
  { order, items, onActionDone }:
  { order: OrderDetail; items: OrderItem[]; onActionDone: () => Promise<void> }
) {
  const customer = customerFromSnapshot(order.customer_snapshot);
  const shipping = addressLines(order.shipping_address_snapshot);
  const billing = addressLines(order.billing_address_snapshot);
  const grams = orderTotalGrams(items);
  const refunded = (order.refunded_total_cents ?? 0) > 0;

  return (
    <>
      <Facts title="Bestellung" rows={[
        ["Bestellnummer", order.order_number],
        ["Eingegangen", fmtDateTime(order.placed_at || order.created_at)],
        ["Status", ORDER_STATUS_LABEL[order.status] ?? order.status],
        ["Zahlung", PAYMENT_STATUS_LABEL[order.payment_status] ?? order.payment_status],
        ["Versandstatus", FULFILLMENT_STATUS_LABEL[order.fulfillment_status] ?? order.fulfillment_status],
        ["Kundentyp", order.customer_type === "business" ? "Geschäftskunde" : "Privat"],
      ]} />

      <Facts title="Kunde" rows={[
        ["Name", customer.name || "—"],
        ["E-Mail", customer.email || "—"],
      ]} />

      <Facts title="Versand" rows={[
        ["Lieferadresse", shipping.length ? <span className="ops-address">{shipping.join("\n")}</span> : "—"],
        ["Rechnungsadresse", billing.length ? <span className="ops-address">{billing.join("\n")}</span> : null],
        ["Versandkosten", formatCents(order.shipping_gross_cents, order.currency)],
        ["Versanddienst", order.shipping_carrier || "—"],
        ["Sendungsnummer", order.tracking_number || "—"],
        ["Tracking", order.tracking_url
          ? <a href={order.tracking_url} target="_blank" rel="noopener noreferrer">Sendung öffnen</a>
          : null],
        ["Versendet am", order.shipped_at ? fmtDateTime(order.shipped_at) : "—"],
      ]} />

      <section className="ops-drawer-section">
        <h3>Positionen</h3>
        <table className="ops-table ops-items">
          <thead>
            <tr>
              <th scope="col">Produkt</th>
              <th scope="col">SKU</th>
              <th scope="col">Menge</th>
              <th scope="col">Stückpreis</th>
              <th scope="col">Summe</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={5} className="ops-empty">Keine Positionen.</td></tr>}
            {items.map(i => (
              <tr key={i.id}>
                <td data-label="Produkt">{[i.product_name, i.variant_name].filter(Boolean).join(" · ")}</td>
                <td data-label="SKU">{i.sku || "—"}</td>
                <td data-label="Menge">{i.quantity}</td>
                <td data-label="Stückpreis">{formatCents(i.unit_price_gross_cents, order.currency)}</td>
                <td data-label="Summe">{formatCents(i.line_total_gross_cents, order.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {grams !== null && <p className="ops-note">Gesamtgewicht {grams} g</p>}
      </section>

      <Facts title="Summen" rows={[
        ["Zwischensumme", formatCents(order.subtotal_gross_cents, order.currency)],
        ["Rabatt", (order.discount_total_cents ?? 0) > 0 ? formatCents(order.discount_total_cents, order.currency) : null],
        ["Versand", formatCents(order.shipping_gross_cents, order.currency)],
        ["Netto", order.total_net_cents !== null ? formatCents(order.total_net_cents, order.currency) : null],
        ["Steuer", order.tax_total_cents !== null ? formatCents(order.tax_total_cents, order.currency) : null],
        ["Gesamt", <strong key="t">{formatCents(order.total_gross_cents, order.currency)}</strong>],
        ["Steuerfall", order.tax_treatment || null],
        ["USt-Land", order.tax_vat_country || null],
      ]} />

      <Facts title="Zahlung" rows={[
        ["Checkout Session", <code key="s">{shortId(order.stripe_checkout_session_id)}</code>],
        ["PaymentIntent", <code key="p">{shortId(order.stripe_payment_intent_id)}</code>],
      ]} />

      {(refunded || order.cancellation_requested_at || order.cancelled_at) && (
        <Facts title="Erstattung / Stornierung" rows={[
          ["Erstattet", refunded ? formatCents(order.refunded_total_cents, order.currency) : null],
          ["Erstattung aktualisiert", order.refund_updated_at ? fmtDateTime(order.refund_updated_at) : null],
          ["Storno angefragt", order.cancellation_requested_at ? fmtDateTime(order.cancellation_requested_at) : null],
          ["Anmerkung", order.cancellation_request_note || null],
          ["Entscheidung", order.cancellation_request_resolution || null],
          ["Entschieden am", order.cancellation_request_resolved_at ? fmtDateTime(order.cancellation_request_resolved_at) : null],
          ["Storniert am", order.cancelled_at ? fmtDateTime(order.cancelled_at) : null],
        ]} />
      )}

      <OrderActions order={order} onDone={onActionDone} />
    </>
  );
}
