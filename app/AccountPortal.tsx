"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import type { CustomerType } from "./content";
import { COUNTRIES } from "./content";
import { useAuth } from "../lib/auth";
import type { AddressRow } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { B2bCalculator } from "./B2bCalculator";
import { useCatalog } from "./useCatalog";
import {
  AccountEmptyState,
  AccountIcon,
  AccountQuickLinks,
  AccountSectionHeader,
  AccountAction,
  AccountSummaryRow,
  type AccountQuickLink,
} from "./AccountUI";
import { resolveGreetingName } from "../lib/accountGreeting";
import type { AddressSnapshot } from "../lib/orderAddressSnapshot";
import { getCountryLabel } from "../lib/shipping";
import {
  getCancellationView,
  getLifecycleSteps,
  getPaymentStatusLabel,
  getPrimaryStatusLabel,
  getRefundView,
  getStatusDetailText,
  getTrackingView,
} from "../lib/orderStatus";

type PortalPage = "dashboard" | "orders" | "subscriptions" | "addresses" | "profile" | "business" | "order-detail" | "subscription-detail" | "supply-detail";

const NAV: { key: PortalPage; label: string; b2bOnly?: boolean; privateOnly?: boolean }[] = [
  { key: "dashboard", label: "Übersicht" },
  { key: "orders", label: "Bestellungen" },
  { key: "subscriptions", label: "Abos", privateOnly: true },
  { key: "addresses", label: "Adressen" },
  { key: "profile", label: "Kontodaten" },
  { key: "business", label: "B2B", b2bOnly: true },
];

export function AccountPortal({ page, orderId, subscriptionId, supplyId }: { page: PortalPage; orderId?: string; subscriptionId?: string; supplyId?: string }) {
  const { user, profile, loading, signOut } = useAuth();
  const customerType: CustomerType = profile?.customer_type ?? "private";

  // Not logged in → redirect
  useEffect(() => {
    if (!loading && !user) {
      window.location.href = "/account";
    }
  }, [loading, user]);

  // Business-only page guard
  useEffect(() => {
    if (!loading && (page === "business" || page === "supply-detail") && customerType !== "business") {
      window.location.href = "/account/dashboard";
    }
  }, [loading, page, customerType]);

  // Private-only page guard (subscriptions are B2C only)
  useEffect(() => {
    if (!loading && (page === "subscriptions" || page === "subscription-detail") && customerType === "business") {
      window.location.href = "/account/dashboard";
    }
  }, [loading, page, customerType]);

  if (loading) {
    return <main className="portal"><p className="portal-loading">Laden…</p></main>;
  }

  if (!user) {
    return null;
  }

  const navItems = NAV.filter(n => (!n.b2bOnly || customerType === "business") && (!n.privateOnly || customerType === "private"));

  const handleLogout = async () => {
    await signOut();
    window.location.href = "/account";
  };

  return (
    <main className="portal">
      <nav className="portal-nav">
        {navItems.map(n => (
          <Link key={n.key} href={`/account/${n.key}`} className={page === n.key || (n.key === "orders" && page === "order-detail") || (n.key === "subscriptions" && page === "subscription-detail") || (n.key === "business" && page === "supply-detail") ? "active" : ""}>{n.label}</Link>
        ))}
        <span className="portal-nav-spacer" />
        <button className="portal-logout" onClick={handleLogout}>Abmelden</button>
      </nav>

      <div className={`portal-content${customerType === "business" ? " portal-content-wide" : ""}`}>
        {page === "dashboard" && <PortalDashboard customerType={customerType} />}
        {page === "orders" && <PortalOrders />}
        {page === "order-detail" && <OrderDetail orderId={orderId!} />}
        {page === "subscriptions" && <PortalSubscriptions />}
        {page === "subscription-detail" && <SubscriptionDetail subscriptionId={subscriptionId!} />}
        {page === "addresses" && <PortalAddresses />}
        {page === "profile" && <PortalProfile />}
        {page === "business" && <PortalBusiness />}
        {page === "supply-detail" && <SupplyDetail supplyId={supplyId!} />}
      </div>
    </main>
  );
}

// ── Order Types ───────────────────────────────────────────────────────

type OrderRow = {
  id: string;
  order_number: string;
  customer_type: string;
  status: string;
  payment_status: string;
  fulfillment_status: string;
  currency: string;
  customer_snapshot: Record<string, unknown>;
  // Address snapshots and the net/tax split are NULL until an order
  // actually has them (shipping address collection may not be enabled;
  // billing address is only ever stored when Stripe actually returned
  // one - see migrations 011/012/013). Only *_gross_cents are guaranteed
  // known. Snapshots hold Stripe's own address shape (line1/line2/...),
  // never a guessed street/house-number split.
  shipping_address_snapshot: AddressSnapshot | null;
  billing_address_snapshot: AddressSnapshot | null;
  subtotal_net_cents: number | null;
  subtotal_gross_cents: number;
  discount_total_cents: number;
  shipping_net_cents: number | null;
  shipping_gross_cents: number | null;
  tax_total_cents: number | null;
  total_net_cents: number | null;
  total_gross_cents: number;
  placed_at: string | null;
  created_at: string;
  // Lifecycle fields (migration 019). All nullable and all genuinely
  // unknown for orders placed before that migration - never defaulted to
  // a value that would imply a state we never observed.
  shipping_carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipped_at: string | null;
  refunded_total_cents: number | null;
  cancellation_requested_at: string | null;
};

type OrderItemRow = {
  id: string;
  order_id: string;
  product_name: string;
  variant_name: string | null;
  quantity: number;
  unit_price_net_cents: number;
  unit_price_gross_cents: number;
  tax_rate_percent: number | null;
  line_total_net_cents: number;
  line_total_gross_cents: number;
};

// ── Subscription Types ────────────────────────────────────────────────

type SubscriptionRow = {
  id: string;
  customer_type: string;
  status: string;
  currency: string;
  customer_snapshot: Record<string, unknown>;
  shipping_address_snapshot: Record<string, unknown>;
  billing_address_snapshot: Record<string, unknown>;
  plan_snapshot: Record<string, unknown>;
  subtotal_net_cents: number;
  subtotal_gross_cents: number;
  discount_total_cents: number;
  shipping_net_cents: number;
  shipping_gross_cents: number;
  tax_total_cents: number;
  total_net_cents: number;
  total_gross_cents: number;
  current_period_start: string | null;
  current_period_end: string | null;
  next_delivery_at: string | null;
  started_at: string | null;
  paused_at: string | null;
  cancelled_at: string | null;
  cancel_at_period_end: boolean;
  created_at: string;
};

type SubscriptionItemRow = {
  id: string;
  subscription_id: string;
  product_name: string;
  variant_name: string | null;
  quantity: number;
  unit_price_net_cents: number;
  unit_price_gross_cents: number;
  tax_rate_percent: number | null;
  line_total_net_cents: number;
  line_total_gross_cents: number;
};

const SUB_STATUS_DE: Record<string, string> = {
  pending: "Wird eingerichtet",
  active: "Aktiv",
  paused: "Pausiert",
  cancelled: "Beendet",
};

const UNIT_DE_PLURAL: Record<string, string> = { day: "Tage", week: "Wochen", month: "Monate", year: "Jahre" };

function fmtInterval(unit?: string, count?: number): string {
  if (!unit || !count) return "";
  if (count === 1) {
    const map: Record<string, string> = { day: "Täglich", week: "Wöchentlich", month: "Monatlich", year: "Jährlich" };
    return map[unit] || "";
  }
  const plural = UNIT_DE_PLURAL[unit];
  return plural ? `Alle ${count} ${plural}` : "";
}

// ── B2B Supply Types ──────────────────────────────────────────────────

type SupplyAgreementRow = {
  id: string;
  customer_type: string;
  offer_model_id: number | null;
  status: string;
  currency: string;
  offer_model_snapshot: Record<string, unknown>;
  business_snapshot: Record<string, unknown>;
  customer_snapshot: Record<string, unknown>;
  shipping_address_snapshot: Record<string, unknown>;
  billing_address_snapshot: Record<string, unknown>;
  subtotal_net_cents: number;
  subtotal_gross_cents: number;
  discount_total_cents: number;
  shipping_net_cents: number;
  shipping_gross_cents: number;
  tax_total_cents: number;
  total_net_cents: number;
  total_gross_cents: number;
  billing_interval_unit: string | null;
  billing_interval_count: number | null;
  delivery_interval_unit: string | null;
  delivery_interval_count: number | null;
  commitment_months: number | null;
  started_at: string | null;
  commitment_end_at: string | null;
  next_delivery_at: string | null;
  ended_at: string | null;
  created_at: string;
};

type SupplyItemRow = {
  id: string;
  supply_agreement_id: string;
  product_name: string;
  variant_name: string | null;
  grams: number | null;
  quantity: number;
  base_unit_price_net_cents: number;
  discount_percent: number | null;
  unit_price_net_cents: number;
  unit_price_gross_cents: number;
  tax_rate_percent: number | null;
  line_total_net_cents: number;
  line_total_gross_cents: number;
};

const SUPPLY_STATUS_DE: Record<string, string> = {
  pending: "Wird eingerichtet",
  active: "Aktiv",
  paused: "Pausiert",
  cancelled: "Beendet",
  completed: "Abgeschlossen",
};

const fmtCents = (cents: number) => (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });

/** Plan name from the frozen plan snapshot, never a guessed one. */
const subPlanName = (sub: SubscriptionRow | null) =>
  (sub?.plan_snapshot as Record<string, string> | null)?.name || "Abo";

/** Delivery interval from the frozen plan snapshot, or "" when it has none. */
const subInterval = (sub: SubscriptionRow | null) => {
  const ps = sub?.plan_snapshot as Record<string, string | number> | null;
  return ps ? fmtInterval(ps.delivery_interval_unit as string, ps.delivery_interval_count as number) : "";
};

// ── Dashboard ──────────────────────────────────────────────────────────

/**
 * The tiles that close the private dashboard. Every href is a real portal
 * route (see NAV above and the router in GloaSite.tsx) - a tile that led
 * nowhere would be worse than no tile at all.
 */
const PRIVATE_QUICK_LINKS: AccountQuickLink[] = [
  { href: "/account/orders", label: "Bestellungen", icon: "bag" },
  { href: "/account/subscriptions", label: "Abos", icon: "repeat" },
  { href: "/account/addresses", label: "Adressen", icon: "pin" },
  { href: "/account/profile", label: "Kontodaten", icon: "user" },
];

/**
 * Same tiles, business destinations. /account/subscriptions is B2C only
 * and is deliberately absent; /account/business is the B2B area a private
 * account never sees.
 */
const BUSINESS_QUICK_LINKS: AccountQuickLink[] = [
  { href: "/account/orders", label: "Bestellungen", icon: "bag" },
  { href: "/account/business", label: "Belieferung", icon: "truck" },
  { href: "/account/addresses", label: "Lieferadressen", icon: "pin" },
  { href: "/account/profile", label: "Firmendaten", icon: "building" },
];

function PortalDashboard({ customerType }: { customerType: CustomerType }) {
  return customerType === "business" ? <BusinessDashboard /> : <PrivateDashboard />;
}

/** The gross figure a customer sees, or the net one a business order records. */
function orderAmount(order: OrderRow): string {
  const business = order.customer_type === "business";
  const cents = business ? order.total_net_cents ?? order.total_gross_cents : order.total_gross_cents;
  return `${fmtCents(cents)} €${business && order.total_net_cents !== null ? " netto" : ""}`;
}

// ── Private dashboard ──────────────────────────────────────────────────

function PrivateDashboard() {
  const { profile } = useAuth();
  const [latestOrder, setLatestOrder] = useState<OrderRow | null>(null);
  const [orderLoading, setOrderLoading] = useState(() => !!supabase);
  const [activeSub, setActiveSub] = useState<SubscriptionRow | null>(null);
  const [subLoading, setSubLoading] = useState(() => !!supabase);
  const [nextDeliverySub, setNextDeliverySub] = useState<SubscriptionRow | null>(null);
  const [deliveryLoading, setDeliveryLoading] = useState(() => !!supabase);

  useEffect(() => {
    if (!supabase) return;
    supabase.from("orders").select("*").order("created_at", { ascending: false }).limit(1)
      .then(({ data }) => { setLatestOrder(data?.[0] ?? null); setOrderLoading(false); });
    supabase.from("subscriptions").select("*").eq("status", "active").order("created_at", { ascending: false }).limit(1)
      .then(({ data }) => { setActiveSub(data?.[0] ?? null); setSubLoading(false); });
    supabase.from("subscriptions").select("*").eq("status", "active").not("next_delivery_at", "is", null).gte("next_delivery_at", new Date().toISOString()).order("next_delivery_at", { ascending: true }).limit(1)
      .then(({ data }) => { setNextDeliverySub(data?.[0] ?? null); setDeliveryLoading(false); });
  }, []);

  // Null rather than a placeholder: "Hallo, -." and "Hallo, GLOA." are
  // both wrong, so an account with no stored first name gets a neutral
  // greeting instead of an invented one.
  const greetingName = resolveGreetingName(profile?.first_name);

  return (
    <>
      <section className="portal-greeting">
        <p className="eyebrow">DEIN GLOA</p>
        <h1>{greetingName ? `Hallo, ${greetingName}.` : "Willkommen zurück."}</h1>
      </section>

      <section className="portal-section">
        <AccountSectionHeader label="NÄCHSTE LIEFERUNG" />
        {deliveryLoading ? (
          <AccountEmptyState>Laden…</AccountEmptyState>
        ) : nextDeliverySub?.next_delivery_at ? (
          <div className="portal-line">
            <strong>{fmtDate(nextDeliverySub.next_delivery_at)}</strong>
            <span>{subPlanName(nextDeliverySub)}{subInterval(nextDeliverySub) ? ` · ${subInterval(nextDeliverySub)}` : ""}</span>
            <a href={`/account/subscriptions/${nextDeliverySub.id}`} className="portal-action">ABO ANSEHEN</a>
          </div>
        ) : (
          <AccountEmptyState action={<AccountAction href="/account/subscriptions">ABO EINRICHTEN</AccountAction>}>
            Keine geplante Lieferung.
          </AccountEmptyState>
        )}
      </section>

      <section className="portal-section">
        <AccountSectionHeader label="LETZTE BESTELLUNG" />
        {orderLoading ? (
          <AccountEmptyState>Laden…</AccountEmptyState>
        ) : latestOrder ? (
          <>
            <div className="portal-order">
              <div className="portal-order-id">
                <strong>{latestOrder.order_number}</strong>
                <span>{getPrimaryStatusLabel(latestOrder)}</span>
              </div>
              <div className="portal-order-meta">
                <span>{fmtDate(latestOrder.placed_at || latestOrder.created_at)}</span>
                <strong>{orderAmount(latestOrder)}</strong>
              </div>
            </div>
            <div className="portal-actions">
              <a href={`/account/orders/${latestOrder.id}`} className="portal-action">BESTELLUNG ANSEHEN</a>
              <Link href="/account/orders" className="portal-action">ALLE BESTELLUNGEN</Link>
            </div>
          </>
        ) : (
          <AccountEmptyState action={<AccountAction href="/shop">ZUM SHOP</AccountAction>}>
            Du hast noch keine Bestellung.
          </AccountEmptyState>
        )}
      </section>

      <section className="portal-section">
        <AccountSectionHeader label="DEIN ABO" />
        {subLoading ? (
          <AccountEmptyState>Laden…</AccountEmptyState>
        ) : activeSub ? (
          <>
            <div className="portal-order">
              <div className="portal-order-id">
                <strong>{subPlanName(activeSub)}</strong>
                <span>{SUB_STATUS_DE[activeSub.status] || activeSub.status}</span>
              </div>
              <div className="portal-order-meta">
                {subInterval(activeSub) && <span>{subInterval(activeSub)}</span>}
                <strong>{fmtCents(activeSub.total_gross_cents)} €</strong>
              </div>
            </div>
            <div className="portal-actions">
              <a href={`/account/subscriptions/${activeSub.id}`} className="portal-action">ABO ANSEHEN</a>
            </div>
          </>
        ) : (
          <AccountEmptyState action={<AccountAction href="/account/subscriptions">ABOS ANSEHEN</AccountAction>}>
            Du hast aktuell kein Abonnement.
          </AccountEmptyState>
        )}
      </section>

      <AccountQuickLinks items={PRIVATE_QUICK_LINKS} />
    </>
  );
}

// ── Business dashboard ─────────────────────────────────────────────────

function BusinessDashboard() {
  const { user, profile, businessProfile } = useAuth();
  const [latestOrder, setLatestOrder] = useState<OrderRow | null>(null);
  const [orderLoading, setOrderLoading] = useState(() => !!supabase);
  const [agreements, setAgreements] = useState<SupplyAgreementRow[]>([]);
  const [nextDelivery, setNextDelivery] = useState<SupplyAgreementRow | null>(null);
  const [supplyLoading, setSupplyLoading] = useState(() => !!supabase);

  useEffect(() => {
    if (!supabase) return;
    supabase.from("orders").select("*").order("created_at", { ascending: false }).limit(1)
      .then(({ data }) => { setLatestOrder(data?.[0] ?? null); setOrderLoading(false); });
    supabase.from("b2b_supply_agreements").select("*").order("created_at", { ascending: false })
      .then(({ data }) => {
        const rows = data ?? [];
        setAgreements(rows);
        // Which delivery is still upcoming depends on the clock, so it is
        // resolved here rather than while rendering.
        const now = Date.now();
        setNextDelivery(
          rows
            .filter(a => a.status === "active" && a.next_delivery_at && new Date(a.next_delivery_at).getTime() >= now)
            .sort((a, b) => new Date(a.next_delivery_at!).getTime() - new Date(b.next_delivery_at!).getTime())[0] ?? null
        );
        setSupplyLoading(false);
      });
  }, []);

  const companyName = resolveGreetingName(businessProfile?.company_name);
  const contactName = resolveGreetingName(profile?.first_name);
  const greetingName = companyName ?? contactName;

  // Only fields the account actually stores. No customer number, no
  // member-since, no price tier: the application has none of those, and a
  // summary panel is not a reason to invent them.
  // Company identity first, contact last: the panel is about the
  // business, and the account email is the least useful line on it.
  const companyFacts: [string, string][] = [];
  if (businessProfile?.legal_form) companyFacts.push(["Rechtsform", businessProfile.legal_form]);
  if (businessProfile?.vat_id) companyFacts.push(["USt-IdNr.", businessProfile.vat_id]);
  if (profile?.customer_type === "business") companyFacts.push(["Konto", "Geschäftskonto"]);
  if (user?.email) companyFacts.push(["E-Mail", user.email]);

  const activeAgreements = agreements.filter(a => a.status === "active");

  return (
    <>
      <section className="portal-b2b-head">
        <div className="portal-b2b-intro">
          <p className="eyebrow">DEIN GLOA B2B</p>
          <h1>{greetingName ? `Hallo, ${greetingName}.` : "Willkommen zurück."}</h1>
          <p className="portal-b2b-lead">Willkommen in deinem B2B-Kundenkonto.</p>
        </div>
        {(companyName || companyFacts.length > 0) && (
          <aside className="portal-company-panel">
            <div className="portal-company-head">
              <AccountIcon name="building" />
              <strong>{companyName ?? "Unternehmen"}</strong>
            </div>
            {companyFacts.map(([label, value]) => (
              <div key={label} className="portal-company-fact"><span>{label}</span><strong>{value}</strong></div>
            ))}
          </aside>
        )}
      </section>

      <section className="portal-section">
        <AccountSectionHeader label="REGELMÄSSIGE BELIEFERUNG" />
        {supplyLoading ? (
          <AccountEmptyState>Laden…</AccountEmptyState>
        ) : (
          <div className="portal-summary-rows">
            {nextDelivery ? (
              <AccountSummaryRow
                icon="truck"
                label="Nächste Lieferung"
                primary={fmtDate(nextDelivery.next_delivery_at!)}
                secondary={[
                  (nextDelivery.offer_model_snapshot as Record<string, string>).label || "Belieferung",
                  fmtInterval(nextDelivery.delivery_interval_unit ?? undefined, nextDelivery.delivery_interval_count ?? undefined),
                ].filter(Boolean).join(" · ")}
                value={`${fmtCents(nextDelivery.total_net_cents)} € netto`}
                href={`/account/business/supply/${nextDelivery.id}`}
              />
            ) : (
              <AccountSummaryRow
                icon="truck"
                label="Nächste Lieferung"
                primary="Keine geplante Lieferung."
                secondary="Bezugsmodell, Lieferintervall und Konditionen richten wir gemeinsam ein."
                action={<AccountAction href="/account/business">BELIEFERUNG EINRICHTEN</AccountAction>}
              />
            )}
            {agreements.length > 0 && (
              <AccountSummaryRow
                icon="repeat"
                label="Vereinbarungen"
                primary={`${activeAgreements.length} aktiv`}
                secondary={agreements.length > activeAgreements.length ? `${agreements.length} insgesamt` : undefined}
                value="B2B-Bereich"
                href="/account/business"
              />
            )}
          </div>
        )}
      </section>

      <section className="portal-section">
        <AccountSectionHeader label="BESTELLUNGEN" />
        {orderLoading ? (
          <AccountEmptyState>Laden…</AccountEmptyState>
        ) : latestOrder ? (
          <div className="portal-summary-rows">
            <AccountSummaryRow
              icon="bag"
              label="Letzte Bestellung"
              primary={latestOrder.order_number}
              secondary={`${fmtDate(latestOrder.placed_at || latestOrder.created_at)} · ${getPrimaryStatusLabel(latestOrder)}`}
              value={orderAmount(latestOrder)}
              href={`/account/orders/${latestOrder.id}`}
            />
            <AccountSummaryRow
              icon="bag"
              label="Bestellhistorie"
              primary="Alle Bestellungen"
              action={<AccountAction href="/account/orders">ÖFFNEN</AccountAction>}
            />
          </div>
        ) : (
          <AccountEmptyState action={<AccountAction href="/account/business">B2B-PREISE ANSEHEN</AccountAction>}>
            Noch keine Bestellung.
          </AccountEmptyState>
        )}
      </section>

      <AccountQuickLinks items={BUSINESS_QUICK_LINKS} />
    </>
  );
}

// ── Bestellungen ───────────────────────────────────────────────────────

function PortalOrders() {
  const { profile } = useAuth();
  const isBusiness = profile?.customer_type === "business";
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(() => !!supabase);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!supabase) return;
    supabase.from("orders").select("*").order("created_at", { ascending: false })
      .then(({ data, error: err }) => {
        if (err) { setError("Deine Bestellungen konnten gerade nicht geladen werden."); }
        else { setOrders(data ?? []); }
        setLoading(false);
      });
  }, []);

  return (
    <>
      <section className="portal-page-head">
        <p className="eyebrow">BESTELLUNGEN</p>
        <h1>Bestellungen.</h1>
        <p className="portal-page-lead">Hier findest du deine bisherigen Bestellungen.</p>
      </section>

      {loading ? (
        <p className="portal-loading">Laden…</p>
      ) : error ? (
        <section className="portal-empty-state"><p>{error}</p></section>
      ) : orders.length === 0 ? (
        <section className="portal-empty-state">
          <p>Du hast noch keine Bestellungen.</p>
          <Link className="cta" href="/shop">ZUM SHOP</Link>
        </section>
      ) : (
        <div className="order-list">
          <div className="order-list-header">
            <span>Bestellung</span>
            <span>Datum</span>
            <span>Status</span>
            <span>Betrag</span>
          </div>
          {orders.map(o => (
            <a key={o.id} href={`/account/orders/${o.id}`} className="order-list-row">
              <span className="order-list-number">{o.order_number}</span>
              <span>{fmtDate(o.placed_at || o.created_at)}</span>
              <span className="order-list-status">
                {getPrimaryStatusLabel(o)}
                {/* Quiet hint that a tracking link exists on the detail
                    page - not a second status, and absent when there is
                    no real tracking data. */}
                {getTrackingView(o) && <span className="order-list-tracking">Sendung</span>}
              </span>
              <span className="order-list-total">{fmtCents(isBusiness ? o.total_net_cents ?? o.total_gross_cents : o.total_gross_cents)} €{isBusiness && o.total_net_cents !== null ? " netto" : ""}</span>
            </a>
          ))}
        </div>
      )}
    </>
  );
}

// ── Bestelldetail ─────────────────────────────────────────────────────

function OrderDetail({ orderId }: { orderId: string }) {
  const { session } = useAuth();
  const [order, setOrder] = useState<OrderRow | null>(null);
  const [items, setItems] = useState<OrderItemRow[]>([]);
  const [loading, setLoading] = useState(() => !!supabase);
  const [notFound, setNotFound] = useState(!supabase);
  const [loadError, setLoadError] = useState(false);
  const [cancelNote, setCancelNote] = useState("");
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const [cancelMessage, setCancelMessage] = useState("");

  useEffect(() => {
    if (!supabase) return;
    Promise.all([
      supabase.from("orders").select("*").eq("id", orderId).maybeSingle(),
      supabase.from("order_items").select("*").eq("order_id", orderId).order("created_at"),
    ]).then(([oRes, iRes]) => {
      // A failed query and a genuinely missing order are different
      // things for the customer: one is worth retrying, the other is
      // not. Neither ever surfaces the underlying Supabase message.
      if (oRes.error) { setLoadError(true); }
      else if (!oRes.data) { setNotFound(true); }
      else { setOrder(oRes.data); setItems(iRes.data ?? []); }
      setLoading(false);
    });
  }, [orderId]);

  if (loading) return <p className="portal-loading">Laden…</p>;

  if (loadError) return (
    <>
      <section className="portal-page-head">
        <p className="eyebrow">BESTELLUNG</p>
        <h1>Das hat gerade nicht geklappt.</h1>
        <p className="portal-page-lead">Deine Bestellung konnte nicht geladen werden. Versuch es gleich noch einmal.</p>
      </section>
      <Link href="/account/orders" className="portal-back-link">&larr; Zurück zu Bestellungen</Link>
    </>
  );

  if (notFound || !order) return (
    <>
      <section className="portal-page-head">
        <p className="eyebrow">BESTELLUNG</p>
        <h1>Bestellung nicht gefunden.</h1>
      </section>
      <Link href="/account/orders" className="portal-back-link">&larr; Zurück zu Bestellungen</Link>
    </>
  );

  const isBusiness = order.customer_type === "business";
  // Shipping/billing address snapshots, and the net/tax split, are
  // genuinely unknown (NULL) until shipping/tax are finalized elsewhere -
  // never assume they're present just because an order exists.
  const ship = order.shipping_address_snapshot;
  const bill = order.billing_address_snapshot;
  const subtotalCents = isBusiness ? order.subtotal_net_cents : order.subtotal_gross_cents;
  const shippingCents = isBusiness ? order.shipping_net_cents : order.shipping_gross_cents;
  const totalCents = isBusiness ? order.total_net_cents : order.total_gross_cents;

  // Everything the customer is told about progress, tracking, refunds
  // and cancellation comes from lib/orderStatus.ts, so this page can
  // never invent a state the data doesn't support.
  const steps = getLifecycleSteps(order);
  const statusDetail = getStatusDetailText(order);
  const tracking = getTrackingView(order);
  const refund = getRefundView(order);
  const cancellation = getCancellationView(order);
  const cancellationRequested = cancellation.state === "requested" || cancelMessage !== "";

  const submitCancellationRequest = async () => {
    if (!session?.access_token) { setCancelError("Bitte melde dich an."); return; }
    setCancelBusy(true);
    setCancelError("");
    try {
      const res = await fetch("/api/orders/cancellation-request", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ orderId: order.id, note: cancelNote.trim() || undefined }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // Server copy is already customer-safe; the fallback never
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

  return (
    <>
      <Link href="/account/orders" className="portal-back-link">&larr; Bestellungen</Link>

      <section className="portal-page-head">
        <p className="eyebrow">BESTELLUNG {order.order_number}</p>
        <h1>{order.order_number}</h1>
      </section>

      {/* ── Status ── */}
      <section className="order-status">
        <p className="order-status-label">{getPrimaryStatusLabel(order)}</p>
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
        <div className="portal-profile-row"><span>Datum</span><strong>{fmtDate(order.placed_at || order.created_at)}</strong></div>
        <div className="portal-profile-row"><span>Zahlung</span><strong>{getPaymentStatusLabel(order)}</strong></div>
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
                name, so a missing link simply means no link. */}
            {tracking.url && (
              <a className="cta order-tracking-link" href={tracking.url} target="_blank" rel="noopener noreferrer">
                Sendung verfolgen <span aria-hidden="true">↗</span>
              </a>
            )}
          </div>
        </section>
      )}

      {/* ── Stornierung anfragen ── */}
      {(cancellation.state === "eligible" || cancellationRequested || cancellation.state === "too_late") && (
        <section className="order-detail-section">
          <p className="eyebrow">STORNIERUNG</p>
          {cancellationRequested ? (
            <p className="order-cancel-note">{cancelMessage || "Wir prüfen, ob die Bestellung noch gestoppt werden kann, und melden uns per E-Mail."}</p>
          ) : cancellation.state === "too_late" ? (
            <p className="order-cancel-note">
              Diese Bestellung ist schon unterwegs und lässt sich nicht mehr stoppen. Nach Erhalt kannst du dein{" "}
              <Link href="/widerruf" className="order-cancel-link">Widerrufsrecht</Link> nutzen.
            </p>
          ) : (
            <div className="order-cancel">
              <p className="order-cancel-note">Du möchtest die Bestellung doch nicht? Frag uns an, solange sie noch nicht unterwegs ist.</p>
              <label className="order-cancel-label" htmlFor="cancel-note">Grund (optional)</label>
              <textarea
                id="cancel-note"
                className="order-cancel-input"
                value={cancelNote}
                maxLength={2000}
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
      {items.length > 0 && (
        <section className="order-detail-section">
          <p className="eyebrow">ARTIKEL</p>
          <div className="order-items-list">
            {items.map(item => (
              <div key={item.id} className="order-item-row">
                <div className="order-item-name">
                  <strong>{item.product_name}</strong>
                  {item.variant_name && <span className="order-item-variant">{item.variant_name}</span>}
                </div>
                <span className="order-item-qty">{item.quantity}×</span>
                <span className="order-item-unit">{fmtCents(isBusiness ? item.unit_price_net_cents : item.unit_price_gross_cents)} €</span>
                <span className="order-item-total">{fmtCents(isBusiness ? item.line_total_net_cents : item.line_total_gross_cents)} €</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Addresses (only when actually known) ── */}
      {(ship || bill) && (
        <div className="order-detail-addresses">
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
          {bill && (
            <section className="order-detail-section">
              <p className="eyebrow">RECHNUNGSADRESSE</p>
              <div className="portal-address-display">
                {bill.name && <p>{bill.name}</p>}
                {bill.company && <p>{bill.company}</p>}
                <p>{bill.line1}</p>
                {bill.line2 && <p>{bill.line2}</p>}
                <p>{bill.postalCode} {bill.city}</p>
                {bill.state && <p>{bill.state}</p>}
                <p>{getCountryLabel(bill.country)}</p>
              </div>
            </section>
          )}
        </div>
      )}

      {/* ── Totals (only fields that are actually known) ── */}
      <section className="order-detail-section">
        <p className="eyebrow">SUMME</p>
        <div className="order-totals">
          {typeof subtotalCents === "number" && (
            <div className="portal-profile-row"><span>Zwischensumme</span><strong>{fmtCents(subtotalCents)} €</strong></div>
          )}
          {order.discount_total_cents > 0 && (
            <div className="portal-profile-row"><span>Rabatt</span><strong>&minus;{fmtCents(order.discount_total_cents)} €</strong></div>
          )}
          {typeof shippingCents === "number" && (
            <div className="portal-profile-row"><span>Versand</span><strong>{shippingCents === 0 ? "Kostenlos" : `${fmtCents(shippingCents)} €`}</strong></div>
          )}
          {typeof order.tax_total_cents === "number" && order.tax_total_cents > 0 && (
            <div className="portal-profile-row"><span>MwSt.</span><strong>{fmtCents(order.tax_total_cents)} €</strong></div>
          )}
          {typeof totalCents === "number" && (
            <div className="portal-profile-row order-total-final">
              <span>Gesamt{isBusiness ? " netto" : ""}</span>
              <strong>{fmtCents(totalCents)} €</strong>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

// ── Abos ───────────────────────────────────────────────────────────────

function PortalSubscriptions() {
  const [subs, setSubs] = useState<SubscriptionRow[]>([]);
  const [loading, setLoading] = useState(() => !!supabase);
  const [error, setError] = useState("");
  // The real Matcha variants and their real catalog prices. Nothing about
  // a subscription changes them: no subscription price exists in the
  // database, so the prices shown here are the ordinary shop prices.
  const { product, loading: catalogLoading } = useCatalog("matcha");

  useEffect(() => {
    if (!supabase) return;
    supabase.from("subscriptions").select("*").order("created_at", { ascending: false })
      .then(({ data, error: err }) => {
        if (err) { setError("Deine Abos konnten gerade nicht geladen werden."); }
        else {
          // active zuerst, dann restliche Status, innerhalb neueste zuerst
          const sorted = [...(data ?? [])].sort((a, b) => {
            const aActive = a.status === "active" ? 0 : 1;
            const bActive = b.status === "active" ? 0 : 1;
            if (aActive !== bActive) return aActive - bActive;
            return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
          });
          setSubs(sorted);
        }
        setLoading(false);
      });
  }, []);

  const hasSubs = subs.length > 0;

  return (
    <>
      <section className="portal-page-head">
        <p className="eyebrow">ABOS</p>
        <h1>{hasSubs ? "Deine Abos." : "Dein Matcha, regelmäßig."}</h1>
        <p className="portal-page-lead">
          {hasSubs
            ? "Hier findest du deine regelmäßigen Lieferungen."
            : "Regelmäßige Lieferungen für deinen GLOA Matcha, in Vorbereitung."}
        </p>
      </section>

      {loading ? (
        <p className="portal-loading">Laden…</p>
      ) : error ? (
        <section className="portal-section"><AccountEmptyState>{error}</AccountEmptyState></section>
      ) : hasSubs ? (
        <div className="sub-list">
          <div className="sub-list-header">
            <span>Abo</span>
            <span>Lieferung</span>
            <span>Status</span>
            <span>Betrag</span>
          </div>
          {subs.map(s => {
            const plan = s.plan_snapshot as Record<string, string>;
            return (
              <a key={s.id} href={`/account/subscriptions/${s.id}`} className="sub-list-row">
                <span className="sub-list-name">{plan.name || "Abo"}</span>
                <span>{s.next_delivery_at ? fmtDate(s.next_delivery_at) : "-"}</span>
                <span>{SUB_STATUS_DE[s.status] || s.status}</span>
                <span className="sub-list-total">{fmtCents(s.total_gross_cents)} €</span>
              </a>
            );
          })}
        </div>
      ) : (
        <>
          {/*
            Deliberately NOT a booking form. The subscriptions table has no
            INSERT path for a client, b2c_subscription_plans ships without
            rows because intervals and conditions are not confirmed, and
            Stripe runs in one-time payment mode only. A start button here
            would be a button that cannot start anything, so the page shows
            what is real - the sizes and their actual prices - and the one
            action that genuinely works today.
          */}
          <section className="portal-section">
            <AccountSectionHeader label="STATUS" />
            <AccountEmptyState>Du hast aktuell kein Abonnement.</AccountEmptyState>
            <p className="portal-note">
              Abos sind noch nicht buchbar. Sobald Lieferintervalle und Konditionen feststehen,
              kannst du dein Abo direkt hier starten. Bis dahin bestellst du deinen Matcha wie
              gewohnt im Shop.
            </p>
          </section>

          <section className="portal-section">
            <AccountSectionHeader label="GRÖSSEN" />
            {catalogLoading ? (
              <AccountEmptyState>Laden…</AccountEmptyState>
            ) : product && product.variants.length > 0 ? (
              <>
                <div className="portal-summary-rows">
                  {product.variants.map(v => (
                    <AccountSummaryRow
                      key={v.id}
                      icon="repeat"
                      label={product.name}
                      primary={v.label}
                      secondary={v.size_grams !== null ? `${v.size_grams} g` : undefined}
                      value={`${fmtCents(v.price_gross_cents)} €`}
                    />
                  ))}
                </div>
                <p className="portal-note">
                  Preise wie im Shop. Für ein Abo ist kein gesonderter Preis und kein Rabatt hinterlegt.
                </p>
                <div className="portal-actions">
                  <Link href="/shop" className="portal-action">MATCHA BESTELLEN</Link>
                </div>
              </>
            ) : (
              <AccountEmptyState action={<AccountAction href="/shop">ZUM SHOP</AccountAction>}>
                Produkte konnten gerade nicht geladen werden.
              </AccountEmptyState>
            )}
          </section>
        </>
      )}
    </>
  );
}

// ── Abo-Detail ──────────────────────────────────────────────────────

function SubscriptionDetail({ subscriptionId }: { subscriptionId: string }) {
  const [sub, setSub] = useState<SubscriptionRow | null>(null);
  const [items, setItems] = useState<SubscriptionItemRow[]>([]);
  const [loading, setLoading] = useState(() => !!supabase);
  const [notFound, setNotFound] = useState(!supabase);

  useEffect(() => {
    if (!supabase) return;
    Promise.all([
      supabase.from("subscriptions").select("*").eq("id", subscriptionId).maybeSingle(),
      supabase.from("subscription_items").select("*").eq("subscription_id", subscriptionId).order("created_at"),
    ]).then(([sRes, iRes]) => {
      if (!sRes.data) { setNotFound(true); }
      else { setSub(sRes.data); setItems(iRes.data ?? []); }
      setLoading(false);
    });
  }, [subscriptionId]);

  if (loading) return <p className="portal-loading">Laden…</p>;

  if (notFound || !sub) return (
    <>
      <section className="portal-page-head">
        <p className="eyebrow">ABO</p>
        <h1>Abo nicht gefunden.</h1>
      </section>
      <Link href="/account/subscriptions" className="portal-back-link">&larr; Zurück zu Abos</Link>
    </>
  );

  const plan = sub.plan_snapshot as Record<string, string | number>;
  const ship = sub.shipping_address_snapshot as Record<string, string>;
  const bill = sub.billing_address_snapshot as Record<string, string>;
  const deliveryLabel = fmtInterval(plan.delivery_interval_unit as string, plan.delivery_interval_count as number);

  return (
    <>
      <Link href="/account/subscriptions" className="portal-back-link">&larr; Abos</Link>

      <section className="portal-page-head">
        <p className="eyebrow">ABO</p>
        <h1>{(plan.name as string) || "Dein Abo"}</h1>
      </section>

      <div className="order-detail-meta">
        <div className="portal-profile-row"><span>Status</span><strong>{SUB_STATUS_DE[sub.status] || sub.status}</strong></div>
        {deliveryLabel && <div className="portal-profile-row"><span>Lieferintervall</span><strong>{deliveryLabel}</strong></div>}
        {sub.next_delivery_at && <div className="portal-profile-row"><span>Nächste Lieferung</span><strong>{fmtDate(sub.next_delivery_at)}</strong></div>}
        {sub.started_at && <div className="portal-profile-row"><span>Laufzeit seit</span><strong>{fmtDate(sub.started_at)}</strong></div>}
        {sub.current_period_start && sub.current_period_end && (
          <div className="portal-profile-row"><span>Aktueller Zeitraum</span><strong>{fmtDate(sub.current_period_start)} - {fmtDate(sub.current_period_end)}</strong></div>
        )}
        {sub.cancel_at_period_end && <div className="portal-profile-row"><span>Hinweis</span><strong>Endet zum Periodenende</strong></div>}
        {sub.paused_at && <div className="portal-profile-row"><span>Pausiert seit</span><strong>{fmtDate(sub.paused_at)}</strong></div>}
        {sub.cancelled_at && <div className="portal-profile-row"><span>Beendet am</span><strong>{fmtDate(sub.cancelled_at)}</strong></div>}
      </div>

      {/* ── Items ── */}
      {items.length > 0 && (
        <section className="order-detail-section">
          <p className="eyebrow">ARTIKEL</p>
          <div className="order-items-list">
            {items.map(item => (
              <div key={item.id} className="order-item-row">
                <div className="order-item-name">
                  <strong>{item.product_name}</strong>
                  {item.variant_name && <span className="order-item-variant">{item.variant_name}</span>}
                </div>
                <span className="order-item-qty">{item.quantity}×</span>
                <span className="order-item-unit">{fmtCents(item.unit_price_gross_cents)} €</span>
                <span className="order-item-total">{fmtCents(item.line_total_gross_cents)} €</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Addresses ── */}
      <div className="order-detail-addresses">
        <section className="order-detail-section">
          <p className="eyebrow">LIEFERADRESSE</p>
          <div className="portal-address-display">
            <p>{ship.first_name} {ship.last_name}</p>
            {ship.company && <p>{ship.company}</p>}
            <p>{ship.street} {ship.house_number}</p>
            <p>{ship.zip} {ship.city}</p>
            <p>{getCountryLabel(ship.country)}</p>
          </div>
        </section>
        <section className="order-detail-section">
          <p className="eyebrow">RECHNUNGSADRESSE</p>
          <div className="portal-address-display">
            <p>{bill.first_name} {bill.last_name}</p>
            {bill.company && <p>{bill.company}</p>}
            <p>{bill.street} {bill.house_number}</p>
            <p>{bill.zip} {bill.city}</p>
            <p>{getCountryLabel(bill.country)}</p>
          </div>
        </section>
      </div>

      {/* ── Totals ── */}
      <section className="order-detail-section">
        <p className="eyebrow">SUMME PRO LIEFERUNG</p>
        <div className="order-totals">
          <div className="portal-profile-row"><span>Zwischensumme</span><strong>{fmtCents(sub.subtotal_gross_cents)} €</strong></div>
          {sub.discount_total_cents > 0 && (
            <div className="portal-profile-row"><span>Rabatt</span><strong>&minus;{fmtCents(sub.discount_total_cents)} €</strong></div>
          )}
          {sub.shipping_gross_cents > 0 && (
            <div className="portal-profile-row"><span>Versand</span><strong>{fmtCents(sub.shipping_gross_cents)} €</strong></div>
          )}
          {sub.tax_total_cents > 0 && (
            <div className="portal-profile-row"><span>MwSt.</span><strong>{fmtCents(sub.tax_total_cents)} €</strong></div>
          )}
          <div className="portal-profile-row order-total-final">
            <span>Gesamt</span>
            <strong>{fmtCents(sub.total_gross_cents)} €</strong>
          </div>
        </div>
      </section>
    </>
  );
}

// ── Adressen ───────────────────────────────────────────────────────────

function PortalAddresses() {
  const { addresses, refreshAddresses } = useAuth();
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const defaultShipping = addresses.find(a => a.is_default_shipping);
  const defaultBilling = addresses.find(a => a.is_default_billing);

  const formatAddr = (a: AddressRow) => (
    <div className="portal-address-display">
      <p>{a.first_name} {a.last_name}</p>
      {a.company && <p>{a.company}</p>}
      <p>{a.street} {a.house_number}</p>
      <p>{a.zip} {a.city}</p>
      <p>{a.country}</p>
    </div>
  );

  const handleAdd = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!supabase) return;
    setSaving(true);
    setError("");
    const f = new FormData(e.currentTarget);
    const isFirst = addresses.length === 0;
    const { error: err } = await supabase.from("addresses").insert({
      first_name: String(f.get("firstName")),
      last_name: String(f.get("lastName")),
      company: String(f.get("company") || "") || null,
      street: String(f.get("street")),
      house_number: String(f.get("houseNumber")),
      zip: String(f.get("zip")),
      city: String(f.get("city")),
      country: String(f.get("country")),
      is_default_shipping: isFirst,
      is_default_billing: isFirst,
    });
    setSaving(false);
    if (err) { setError("Fehler beim Speichern."); return; }
    await refreshAddresses();
    setShowForm(false);
  };

  const handleDelete = async (id: string) => {
    if (!supabase) return;
    const addr = addresses.find(a => a.id === id);
    if (addr && (addr.is_default_shipping || addr.is_default_billing) && addresses.length <= 1) {
      setError("Die letzte Standardadresse kann nicht entfernt werden.");
      return;
    }
    await supabase.from("addresses").delete().eq("id", id);
    setError("");
    await refreshAddresses();
  };

  return (
    <>
      <section className="portal-page-head">
        <p className="eyebrow">ADRESSEN</p>
        <h1>Adressen.</h1>
      </section>

      <div className="portal-addresses-grid">
        <section className="portal-address-block">
          <p className="eyebrow">STANDARD-LIEFERADRESSE</p>
          {defaultShipping ? formatAddr(defaultShipping) : <p className="portal-empty">Keine Adresse hinterlegt.</p>}
        </section>
        <section className="portal-address-block">
          <p className="eyebrow">RECHNUNGSADRESSE</p>
          {defaultBilling ? formatAddr(defaultBilling) : <p className="portal-empty">Keine Adresse hinterlegt.</p>}
        </section>
      </div>

      {addresses.length > 0 && (
        <section className="portal-all-addresses">
          <p className="eyebrow">ALLE ADRESSEN</p>
          {addresses.map(a => (
            <div key={a.id} className="portal-address-item">
              {formatAddr(a)}
              <div className="portal-address-badges">
                {a.is_default_shipping && <span className="portal-badge">Lieferadresse</span>}
                {a.is_default_billing && <span className="portal-badge">Rechnungsadresse</span>}
              </div>
              <button className="portal-address-delete" onClick={() => handleDelete(a.id)}>Entfernen</button>
            </div>
          ))}
        </section>
      )}

      {!showForm ? (
        <button className="cta portal-add-address-btn" onClick={() => setShowForm(true)}>ADRESSE HINZUFÜGEN</button>
      ) : (
        <form className="portal-address-form account-form" onSubmit={handleAdd}>
          <p className="account-form-section">NEUE ADRESSE</p>
          <div className="account-form-row">
            <label>Vorname*<input required name="firstName" autoComplete="given-name" /></label>
            <label>Nachname*<input required name="lastName" autoComplete="family-name" /></label>
          </div>
          <label>Firma<input name="company" /></label>
          <div className="account-form-row">
            <label>Straße*<input required name="street" autoComplete="street-address" /></label>
            <label>Hausnummer*<input required name="houseNumber" /></label>
          </div>
          <div className="account-form-row">
            <label>PLZ*<input required name="zip" autoComplete="postal-code" /></label>
            <label>Ort*<input required name="city" /></label>
          </div>
          <label>Land*
            <select required name="country" defaultValue="Deutschland">
              {COUNTRIES.map(c => <option key={c}>{c}</option>)}
            </select>
          </label>
          {error && <p className="account-error">{error}</p>}
          <div className="portal-form-actions">
            <button type="submit" className="cta" disabled={saving}>{saving ? "SPEICHERN…" : "ADRESSE SPEICHERN"}</button>
            <button type="button" className="portal-cancel-btn" onClick={() => { setShowForm(false); setError(""); }}>Abbrechen</button>
          </div>
        </form>
      )}
    </>
  );
}

// ── Kontodaten / Profil ────────────────────────────────────────────────

function PortalProfile() {
  const { user, profile, businessProfile, refreshProfile } = useAuth();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [pwMsg, setPwMsg] = useState("");

  const handleSave = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!supabase || !user) return;
    setSaving(true);
    setError("");
    const f = new FormData(e.currentTarget);
    const { error: err } = await supabase.from("profiles").update({
      first_name: String(f.get("first_name")),
      last_name: String(f.get("last_name")),
      phone: String(f.get("phone") || "") || null,
    }).eq("user_id", user.id);
    setSaving(false);
    if (err) { setError("Fehler beim Speichern."); return; }
    await refreshProfile();
    setEditing(false);
  };


  const handlePasswordReset = async () => {
    if (!supabase || !user?.email) return;
    setPwMsg("");
    const { error: err } = await supabase.auth.resetPasswordForEmail(user.email);
    setPwMsg(err ? "Fehler. Bitte versuche es erneut." : "Wir haben dir eine E-Mail zum Zurücksetzen gesendet.");
  };

  return (
    <>
      <section className="portal-page-head">
        <p className="eyebrow">KONTODATEN</p>
        <h1>Kontodaten.</h1>
      </section>

      <div className="portal-profile-sections">
        <section className="portal-profile-block">
          <p className="eyebrow">PERSÖNLICHE DATEN</p>
          {!editing ? (
            <>
              <div className="portal-profile-row"><span>Vorname</span><strong>{profile?.first_name || "-"}</strong></div>
              <div className="portal-profile-row"><span>Nachname</span><strong>{profile?.last_name || "-"}</strong></div>
              <div className="portal-profile-row"><span>E-Mail</span><strong>{user?.email || "-"}</strong></div>
              <div className="portal-profile-row"><span>Telefon</span><strong>{profile?.phone || "-"}</strong></div>
              <button className="cta portal-edit-btn" onClick={() => setEditing(true)}>BEARBEITEN</button>
            </>
          ) : (
            <form className="account-form portal-inline-form" onSubmit={handleSave}>
              <div className="account-form-row">
                <label>Vorname<input required name="first_name" defaultValue={profile?.first_name ?? ""} /></label>
                <label>Nachname<input required name="last_name" defaultValue={profile?.last_name ?? ""} /></label>
              </div>
              <label>Telefon<input name="phone" defaultValue={profile?.phone ?? ""} /></label>
              {error && <p className="account-error">{error}</p>}
              <div className="portal-form-actions">
                <button type="submit" className="cta" disabled={saving}>{saving ? "SPEICHERN…" : "SPEICHERN"}</button>
                <button type="button" className="portal-cancel-btn" onClick={() => { setEditing(false); setError(""); }}>Abbrechen</button>
              </div>
            </form>
          )}
        </section>

        {profile?.customer_type === "business" && businessProfile && (
          <section className="portal-profile-block">
            <p className="eyebrow">UNTERNEHMENSDATEN</p>
            <div className="portal-profile-row"><span>Firma</span><strong>{businessProfile.company_name || "-"}</strong></div>
            {businessProfile.legal_form && <div className="portal-profile-row"><span>Rechtsform</span><strong>{businessProfile.legal_form}</strong></div>}
            <div className="portal-profile-row"><span>Steuernummer</span><strong>{businessProfile.tax_number || "-"}</strong></div>
            {businessProfile.vat_id && <div className="portal-profile-row"><span>USt-IdNr.</span><strong>{businessProfile.vat_id}</strong></div>}
            {businessProfile.website && <div className="portal-profile-row"><span>Website</span><strong>{businessProfile.website}</strong></div>}
          </section>
        )}

        <section className="portal-profile-block">
          <p className="eyebrow">PASSWORT</p>
          <button className="cta" onClick={handlePasswordReset}>PASSWORT ÄNDERN</button>
          {pwMsg && <p className="portal-profile-note">{pwMsg}</p>}
        </section>

        <section className="portal-profile-block">
          <p className="eyebrow">KONTO</p>
          <p className="portal-profile-note">Konto löschen wird später verfügbar sein.</p>
        </section>
      </div>
    </>
  );
}

// ── B2B Bereich ────────────────────────────────────────────────────────

type OfferModel = { id: number; slug: string; label: string; discount_pct: number; description: string | null; sort_order: number };
type ProductSize = { id: number; grams: number; label: string; price_per_kg_net: number; sort_order: number };
type GeneralTerm = { id: number; key: string; label: string; value: string; sort_order: number };

const fmtEur = (n: number) => n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const calcPrice = (pricePerKg: number, grams: number, discountPct: number) =>
  Math.round(pricePerKg * grams / 1000 * (1 - discountPct / 100) * 100) / 100;

function PortalBusiness() {
  const { businessProfile } = useAuth();
  const [models, setModels] = useState<OfferModel[]>([]);
  const [sizes, setSizes] = useState<ProductSize[]>([]);
  const [terms, setTerms] = useState<GeneralTerm[]>([]);
  const [agreements, setAgreements] = useState<SupplyAgreementRow[]>([]);
  const [loading, setLoading] = useState(() => !!supabase);
  const [supplyLoading, setSupplyLoading] = useState(() => !!supabase);
  const [supplyError, setSupplyError] = useState("");

  useEffect(() => {
    if (!supabase) return;
    Promise.all([
      supabase.from("b2b_offer_models").select("*").order("sort_order"),
      supabase.from("b2b_product_sizes").select("*").order("sort_order"),
      supabase.from("b2b_general_terms").select("*").order("sort_order"),
    ]).then(([m, s, t]) => {
      setModels(m.data ?? []);
      setSizes(s.data ?? []);
      setTerms(t.data ?? []);
      setLoading(false);
    });
    supabase.from("b2b_supply_agreements").select("*").order("created_at", { ascending: false })
      .then(({ data, error: err }) => {
        if (err) { setSupplyError("Deine Belieferung konnte gerade nicht geladen werden."); }
        else {
          const sorted = [...(data ?? [])].sort((a, b) => {
            const aActive = a.status === "active" ? 0 : 1;
            const bActive = b.status === "active" ? 0 : 1;
            if (aActive !== bActive) return aActive - bActive;
            return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
          });
          setAgreements(sorted);
        }
        setSupplyLoading(false);
      });
  }, []);

  if (loading) return <p className="portal-loading">Laden…</p>;

  return (
    <>
      <section className="portal-page-head">
        <p className="eyebrow">B2B</p>
        <h1>B2B bei GLOA.</h1>
        <p className="portal-page-lead">Preise, Bezugsmodelle und Konditionen für dein Unternehmen.</p>
      </section>

      {/* ── Supply Agreements ── */}
      <section className="b2b-section">
        <p className="eyebrow">REGELMÄSSIGE BELIEFERUNG</p>
        {supplyLoading ? (
          <p className="portal-empty">Laden…</p>
        ) : supplyError ? (
          <p className="portal-empty">{supplyError}</p>
        ) : agreements.length === 0 ? (
          <>
            <p className="portal-empty">Noch keine regelmäßige Belieferung eingerichtet.</p>
            <p className="portal-note">
              Bezugsmodell, Gebindegröße und Lieferintervall stimmen wir individuell mit dir ab.
              Deine Konditionen findest du unten auf dieser Seite.
            </p>
            <div className="portal-actions">
              <Link href="/contact" className="portal-action">BELIEFERUNG ANFRAGEN</Link>
            </div>
          </>
        ) : (
          <div className="supply-list">
            <div className="supply-list-header">
              <span>Modell</span>
              <span>Nächste Lieferung</span>
              <span>Status</span>
              <span>Betrag netto</span>
            </div>
            {agreements.map(a => {
              const model = a.offer_model_snapshot as Record<string, string>;
              return (
                <a key={a.id} href={`/account/business/supply/${a.id}`} className="supply-list-row">
                  <span className="supply-list-name">{model.label || "Belieferung"}</span>
                  <span>{a.next_delivery_at ? fmtDate(a.next_delivery_at) : "Noch nicht terminiert"}</span>
                  <span>{SUPPLY_STATUS_DE[a.status] || a.status}</span>
                  <span className="supply-list-total">{fmtCents(a.total_net_cents)} €</span>
                </a>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Pricing Table ── */}
      <section className="b2b-section">
        <p className="eyebrow">DEINE B2B-PREISE</p>
        <p className="b2b-section-lead">Alle Preise netto zzgl. gesetzlicher MwSt.</p>
        {sizes.length > 0 && models.length > 0 && (
          <div className="b2b-pricing-table">
            <div className="b2b-pricing-header">
              <div className="b2b-pricing-cell b2b-pricing-label" />
              {sizes.map(s => <div key={s.id} className="b2b-pricing-cell">{s.label}</div>)}
            </div>
            {models.map(m => (
              <div key={m.id} className="b2b-pricing-row">
                <div className="b2b-pricing-cell b2b-pricing-label">
                  <strong>{m.label}</strong>
                  {m.discount_pct > 0 && <span className="b2b-discount">{"\u2212"}{m.discount_pct} %</span>}
                </div>
                {sizes.map(s => (
                  <div key={s.id} className="b2b-pricing-cell b2b-pricing-value">
                    {fmtEur(calcPrice(s.price_per_kg_net, s.grams, m.discount_pct))} €
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {sizes.length > 0 && (
          <p className="b2b-pricing-note">Basis: {fmtEur(sizes[0].price_per_kg_net)} € / kg netto</p>
        )}
      </section>

      {/* ── Offer Models ── */}
      <section className="b2b-section">
        <p className="eyebrow">BEZUGSMODELLE</p>
        <div className="b2b-models-grid">
          {models.map(m => (
            <div key={m.id} className="b2b-model-card">
              <p className="b2b-model-label">{m.label}</p>
              {m.discount_pct > 0 && <p className="b2b-model-discount">{"\u2212"}{m.discount_pct} % auf den Basispreis</p>}
              {m.description && <p className="b2b-model-desc">{m.description}</p>}
            </div>
          ))}
        </div>
      </section>

      {/* ── Calculator ── */}
      {sizes.length > 0 && models.length > 0 && (
        <section className="b2b-section">
          <p className="eyebrow">KALKULATION</p>
          <h2 className="b2b-section-title">Matcha-Kalkulations&shy;rechner</h2>
          <B2bCalculator models={models} sizes={sizes} />
        </section>
      )}

      {/* ── Terms ── */}
      {terms.length > 0 && (
        <section className="b2b-section">
          <p className="eyebrow">KONDITIONEN</p>
          <div className="b2b-terms-list">
            {terms.map(t => (
              <div key={t.id} className="b2b-term-row">
                <span className="b2b-term-key">{t.label}</span>
                <span>{t.value}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Company Data ── */}
      {businessProfile && (
        <section className="b2b-section">
          <p className="eyebrow">UNTERNEHMENSDATEN</p>
          <div className="portal-fact-grid">
            <div className="portal-fact"><span>Firma</span><strong>{businessProfile.company_name || "\u2014"}</strong></div>
            {businessProfile.legal_form && <div className="portal-fact"><span>Rechtsform</span><strong>{businessProfile.legal_form}</strong></div>}
            <div className="portal-fact"><span>Steuernummer</span><strong>{businessProfile.tax_number || "\u2014"}</strong></div>
            {businessProfile.vat_id && <div className="portal-fact"><span>USt-IdNr.</span><strong>{businessProfile.vat_id}</strong></div>}
            {businessProfile.website && <div className="portal-fact"><span>Website</span><strong>{businessProfile.website}</strong></div>}
          </div>
          <div className="portal-actions">
            <Link href="/account/profile" className="portal-action">KONTODATEN BEARBEITEN</Link>
          </div>
        </section>
      )}
    </>
  );
}

// ── B2B Supply Detail ─────────────────────────────────────────────────

function SupplyDetail({ supplyId }: { supplyId: string }) {
  const [agreement, setAgreement] = useState<SupplyAgreementRow | null>(null);
  const [items, setItems] = useState<SupplyItemRow[]>([]);
  const [loading, setLoading] = useState(() => !!supabase);
  const [notFound, setNotFound] = useState(!supabase);

  useEffect(() => {
    if (!supabase) return;
    Promise.all([
      supabase.from("b2b_supply_agreements").select("*").eq("id", supplyId).maybeSingle(),
      supabase.from("b2b_supply_items").select("*").eq("supply_agreement_id", supplyId).order("created_at"),
    ]).then(([aRes, iRes]) => {
      if (!aRes.data) { setNotFound(true); }
      else { setAgreement(aRes.data); setItems(iRes.data ?? []); }
      setLoading(false);
    });
  }, [supplyId]);

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

  const model = agreement.offer_model_snapshot as Record<string, string | number>;
  const biz = agreement.business_snapshot as Record<string, string>;
  const ship = agreement.shipping_address_snapshot as Record<string, string>;
  const bill = agreement.billing_address_snapshot as Record<string, string>;
  const deliveryLabel = fmtInterval(agreement.delivery_interval_unit ?? undefined, agreement.delivery_interval_count ?? undefined);

  return (
    <>
      <Link href="/account/business" className="portal-back-link">&larr; B2B</Link>

      <section className="portal-page-head">
        <p className="eyebrow">BELIEFERUNG</p>
        <h1>{(model.label as string) || "Belieferung"}</h1>
      </section>

      <div className="order-detail-meta">
        <div className="portal-profile-row"><span>Status</span><strong>{SUPPLY_STATUS_DE[agreement.status] || agreement.status}</strong></div>
        {agreement.started_at && <div className="portal-profile-row"><span>Beginn</span><strong>{fmtDate(agreement.started_at)}</strong></div>}
        {agreement.commitment_end_at && <div className="portal-profile-row"><span>Partnerschaft bis</span><strong>{fmtDate(agreement.commitment_end_at)}</strong></div>}
        {agreement.next_delivery_at && <div className="portal-profile-row"><span>Nächste Lieferung</span><strong>{fmtDate(agreement.next_delivery_at)}</strong></div>}
        {deliveryLabel && <div className="portal-profile-row"><span>Lieferintervall</span><strong>{deliveryLabel}</strong></div>}
        {typeof model.commitment_months === "number" && model.commitment_months > 0 && (
          <div className="portal-profile-row"><span>Laufzeit</span><strong>{model.commitment_months} Monate</strong></div>
        )}
        {agreement.ended_at && <div className="portal-profile-row"><span>Beendet am</span><strong>{fmtDate(agreement.ended_at)}</strong></div>}
      </div>

      {/* ── Pricing Model ── */}
      {typeof model.discount_pct === "number" && (model.discount_pct as number) > 0 && (
        <section className="order-detail-section">
          <p className="eyebrow">PREISMODELL</p>
          <div className="portal-profile-row"><span>Rabatt</span><strong>{"\u2212"}{model.discount_pct} %</strong></div>
        </section>
      )}

      {/* ── Items ── */}
      {items.length > 0 && (
        <section className="order-detail-section">
          <p className="eyebrow">ARTIKEL</p>
          <div className="order-items-list">
            {items.map(item => (
              <div key={item.id} className="order-item-row">
                <div className="order-item-name">
                  <strong>{item.product_name}</strong>
                  {item.variant_name && <span className="order-item-variant">{item.variant_name}</span>}
                  {item.grams && <span className="order-item-variant">{item.grams} g</span>}
                </div>
                <span className="order-item-qty">{item.quantity}×</span>
                <span className="order-item-unit">{fmtCents(item.unit_price_net_cents)} €</span>
                <span className="order-item-total">{fmtCents(item.line_total_net_cents)} €</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Addresses ── */}
      <div className="order-detail-addresses">
        <section className="order-detail-section">
          <p className="eyebrow">LIEFERADRESSE</p>
          <div className="portal-address-display">
            <p>{ship.first_name} {ship.last_name}</p>
            {ship.company && <p>{ship.company}</p>}
            <p>{ship.street} {ship.house_number}</p>
            <p>{ship.zip} {ship.city}</p>
            <p>{getCountryLabel(ship.country)}</p>
          </div>
        </section>
        <section className="order-detail-section">
          <p className="eyebrow">RECHNUNGSADRESSE</p>
          <div className="portal-address-display">
            <p>{bill.first_name} {bill.last_name}</p>
            {bill.company && <p>{bill.company}</p>}
            <p>{bill.street} {bill.house_number}</p>
            <p>{bill.zip} {bill.city}</p>
            <p>{getCountryLabel(bill.country)}</p>
          </div>
        </section>
      </div>

      {/* ── Business Snapshot ── */}
      {biz.company_name && (
        <section className="order-detail-section">
          <p className="eyebrow">UNTERNEHMEN</p>
          <div className="portal-profile-row"><span>Firma</span><strong>{biz.company_name}</strong></div>
          {biz.legal_form && <div className="portal-profile-row"><span>Rechtsform</span><strong>{biz.legal_form}</strong></div>}
          {biz.tax_number && <div className="portal-profile-row"><span>Steuernummer</span><strong>{biz.tax_number}</strong></div>}
          {biz.vat_id && <div className="portal-profile-row"><span>USt-IdNr.</span><strong>{biz.vat_id}</strong></div>}
        </section>
      )}

      {/* ── Totals ── */}
      <section className="order-detail-section">
        <p className="eyebrow">SUMME PRO LIEFERUNG</p>
        <div className="order-totals">
          <div className="portal-profile-row"><span>Zwischensumme netto</span><strong>{fmtCents(agreement.subtotal_net_cents)} €</strong></div>
          {agreement.discount_total_cents > 0 && (
            <div className="portal-profile-row"><span>Rabatt</span><strong>&minus;{fmtCents(agreement.discount_total_cents)} €</strong></div>
          )}
          {agreement.shipping_net_cents > 0 && (
            <div className="portal-profile-row"><span>Versand netto</span><strong>{fmtCents(agreement.shipping_net_cents)} €</strong></div>
          )}
          {agreement.tax_total_cents > 0 && (
            <div className="portal-profile-row"><span>MwSt.</span><strong>{fmtCents(agreement.tax_total_cents)} €</strong></div>
          )}
          <div className="portal-profile-row order-total-final">
            <span>Gesamt netto</span>
            <strong>{fmtCents(agreement.total_net_cents)} €</strong>
          </div>
        </div>
      </section>
    </>
  );
}
