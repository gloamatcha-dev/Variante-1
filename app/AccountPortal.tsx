"use client";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import type { CustomerType } from "./content";
import { useAuth } from "../lib/auth";
import type { AddressRow } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { PASSWORD_RESET_PATH, browserAuthRedirectUrl } from "../lib/authRedirect";
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
// THE PREPAID ANNUAL PLAN, all from pure leaves the browser can load.
// annualPlanAccount.ts was written for exactly this account area and had
// never been rendered; annualPlanRules.ts is the same money leaf the
// server prices with, so no figure here is a second calculation.
import {
  ANNUAL_CHECKOUT_RETURN_PARAM,
  ANNUAL_PLAN_ACCOUNT_SELECT,
  ANNUAL_PLAN_DELIVERY_ACCOUNT_SELECT,
  buildAnnualPlanAccountView,
  resolveAnnualCheckoutReturnState,
  type AnnualCheckoutReturnState,
  type AnnualPlanAccountRow,
  type AnnualPlanAccountView,
  type AnnualPlanDeliveryAccountRow,
} from "../lib/annualPlanAccount";
import {
  ANNUAL_DELIVERY_COUNT,
  ANNUAL_DELIVERY_INTERVAL_DAYS,
  ANNUAL_DISCOUNT_PERCENT,
  buildAnnualPricing,
} from "../lib/annualPlanRules";
import {
  ANNUAL_GERMANY_ONLY_NOTE,
  ANNUAL_LAUNCH_SIZE_BY_SKU,
  isAnnualDeliveryCountry,
} from "../lib/annualPlans";
// The ONE subscription shipping rule, the same table the server prices
// from. A zero-import leaf, so the browser can read it without a second
// copy of 590/0/0 existing anywhere.
import {
  SUBSCRIPTION_ABROAD_SHIPPING_NOTE,
  SUBSCRIPTION_FREE_SHIPPING_FROM_GRAMS,
  SUBSCRIPTION_FREE_SHIPPING_NOTE,
  isSubscriptionBenefitCountry,
  subscriptionDeShippingGrossCents,
} from "../lib/subscriptionPurchaseRules";
import type { AddressSnapshot } from "../lib/orderAddressSnapshot";
import { getCountryLabel, normalizeCountryCode, SHIPPING_COUNTRY_OPTIONS } from "../lib/shipping";
import {
  getCancellationView,
  getLifecycleSteps,
  getPaymentStatusLabel,
  getPrimaryStatusLabel,
  getRefundView,
  getStatusDetailText,
  getTrackingView,
} from "../lib/orderStatus";
import {
  SUBSCRIPTION_CADENCE_LABEL,
  SUBSCRIPTION_QUANTITY_LABEL,
  canRequestSubscriptionCancellation,
  getCancellationCutoffAt,
  getCancellationPreview,
  getEffectiveEndAt,
  getNextBillingAt,
  getNextDeliveryAt,
  getSubscriptionStatusLabel,
  getSubscriptionStatusNote,
  hasEnded,
  isCancellationScheduled,
} from "../lib/subscriptionCancellationRules";

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
        {navItems.map(n => {
          const active = page === n.key || (n.key === "orders" && page === "order-detail") || (n.key === "subscriptions" && page === "subscription-detail") || (n.key === "business" && page === "supply-detail");
          return <Link key={n.key} href={`/account/${n.key}`} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>{n.label}</Link>;
        })}
        <span className="portal-nav-spacer" />
        <button className="portal-logout" onClick={handleLogout}>Abmelden</button>
      </nav>

      <div className={`portal-content${customerType === "business" ? " portal-content-wide" : ""}`}>
        {/* THE RETURN FROM STRIPE, on whichever page the customer lands.
            Mounted in the shell rather than on one page, because the two
            products return to two different routes and neither URL is
            changed by this package. */}
        <CheckoutReturnBanner />
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
  // Migration 031. NULL while the request is still open; 'approved' or
  // 'declined' once an operator has answered. Read-only here - the
  // customer's SELECT grant covers it, and nothing in the browser can
  // write it.
  cancellation_request_resolution: string | null;
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
  /**
   * Migration 034, and only the two the customer is entitled to.
   *
   * cancel_at and last_paid_period_end are deliberately ABSENT. They are
   * what Stripe currently holds and the payment proof the safety sweep
   * needs - internal machinery of Phase 3C, not a customer fact - and the
   * SELECT below does not ask for them either, so they never reach the
   * browser at all. The customer-facing promise is
   * cancellation_effective_at.
   */
  cancellation_requested_at: string | null;
  cancellation_effective_at: string | null;
};

/**
 * Every subscription column the account is allowed to read.
 *
 * Named explicitly rather than `*`. A star select would hand the browser
 * cancel_at and last_paid_period_end the moment migration 034 went live,
 * and "we simply never render it" is not the same guarantee as never
 * having sent it.
 */
const SUBSCRIPTION_SELECT =
  "id, customer_type, status, currency, customer_snapshot, shipping_address_snapshot, " +
  "billing_address_snapshot, plan_snapshot, subtotal_net_cents, subtotal_gross_cents, " +
  "discount_total_cents, shipping_net_cents, shipping_gross_cents, tax_total_cents, " +
  "total_net_cents, total_gross_cents, current_period_start, current_period_end, " +
  "next_delivery_at, started_at, paused_at, cancelled_at, cancel_at_period_end, created_at, " +
  "cancellation_requested_at, cancellation_effective_at";

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
    supabase.from("subscriptions").select(SUBSCRIPTION_SELECT).eq("status", "active").order("created_at", { ascending: false }).limit(1)
      .then(({ data }) => { setActiveSub((data?.[0] as unknown as SubscriptionRow) ?? null); setSubLoading(false); });
    supabase.from("subscriptions").select(SUBSCRIPTION_SELECT).eq("status", "active").not("next_delivery_at", "is", null).gte("next_delivery_at", new Date().toISOString()).order("next_delivery_at", { ascending: true }).limit(1)
      .then(({ data }) => { setNextDeliverySub((data?.[0] as unknown as SubscriptionRow) ?? null); setDeliveryLoading(false); });
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
        ) : nextDeliverySub && getNextDeliveryAt(nextDeliverySub) ? (
          <div className="portal-line">
            <strong>{fmtDate(getNextDeliveryAt(nextDeliverySub) as string)}</strong>
            <span>{subPlanName(nextDeliverySub)} · {SUBSCRIPTION_CADENCE_LABEL}</span>
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
                <span>{getSubscriptionStatusLabel(activeSub)}</span>
              </div>
              <div className="portal-order-meta">
                <span>{SUBSCRIPTION_CADENCE_LABEL}</span>
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
      {(cancellation.state === "eligible" || cancellationRequested || cancellation.state === "declined" || cancellation.state === "too_late") && (
        <section className="order-detail-section">
          <p className="eyebrow">STORNIERUNG</p>
          {/* A declined request is terminal (migration 031) and is checked
              FIRST, so it can never keep rendering "wir prüfen". Before
              this existed there was no way to end that sentence, and a
              refused request said "wir prüfen" forever. No reason is
              shown, because none is collected. */}
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

// ── Abo starten ────────────────────────────────────────────────────────

type SubscriptionPlanRow = {
  id: string;
  slug: string;
  name: string;
  variant_id: string | null;
  sort_order: number;
};

/**
 * THE ONE PLACE A B2C SUBSCRIPTION IS STARTED.
 *
 * The engine behind it has been complete since Task 29D-E. What never
 * existed was a caller: nothing in the browser posted to
 * /api/subscriptions/checkout/session, so the whole flow - recurring
 * Stripe Prices, invoice.paid activation, cancellation, refunds and four
 * transactional mails - was reachable only by hand. This form is that
 * caller, and it is deliberately the only one.
 *
 * ── WHY IT LIVES HERE AND NOT IN THE SHOP ─────────────────────
 *
 * The route accepts exactly planId, addressId and requestId, and refuses
 * a body carrying anything else. Two of those three are things only a
 * signed-in account has:
 *
 *   planId     b2c_subscription_plans grants SELECT to `authenticated`
 *              and its RLS policy shows only active rows. A signed-out
 *              shop visitor cannot read the plans at all.
 *   addressId  one of the customer's OWN saved addresses. The route has
 *              no guest path - it answers 401 without a verified bearer
 *              token - because a recurring contract belongs to a person.
 *
 * So the shop states the offer and links here with the chosen size as a
 * `?sku=` hint. The hint preselects and nothing more: the plans are
 * re-read here, and the server re-resolves the price from the plan's own
 * variant regardless of what any URL said.
 *
 * ── NOT ONE COMMERCIAL VALUE IS SENT ──────────────────────────
 *
 * No price, no shipping, no tax, no quantity, no currency, no user id.
 * Every one of them is resolved server-side by handleSubscriptionCheckout
 * against the catalog and the customer's own address row. This component
 * cannot mis-price a subscription because it never states a price - the
 * euro figures it renders are the shop's own catalog prices, shown so the
 * customer knows what they are choosing, and they travel nowhere.
 *
 * ── THE REQUEST ID IS AN IDEMPOTENCY TOKEN, NOT A NONCE ───────
 *
 * It is minted once per (plan, address) pair and kept while that pair
 * stands, so pressing the button twice - or pressing it again after a
 * failed Stripe call - reuses the same checkout attempt instead of
 * minting a second one. Changing the plan or the address is a different
 * intent and gets a different token, which is exactly the distinction
 * the route's own fingerprint comparison draws on the other side.
 */
function SubscriptionStartForm({ onStarted }: { onStarted?: () => void }) {
  const { session, addresses } = useAuth();
  const { product, loading: catalogLoading } = useCatalog("matcha");
  const [plans, setPlans] = useState<SubscriptionPlanRow[]>([]);
  const [plansLoading, setPlansLoading] = useState(() => !!supabase);
  const [plansError, setPlansError] = useState("");

  // The CHOICES, not the values. Null means "the customer has not picked
  // yet", and the value below is derived - so a preselection never has to
  // be written by an effect and can never fight a later choice.
  const [planChoice, setPlanChoice] = useState<string | null>(null);
  const [addressChoice, setAddressChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  /*
    THE `?sku=` HINT, READ ONCE AND ONLY IN A BROWSER.

    A lazy useState initialiser rather than an effect: the value cannot
    change while this component lives, and reading it in an effect would
    mean a first render that shows the wrong size selected. The typeof
    guard is what makes it safe during server rendering, where there is
    no location to read.
  */
  const [skuHint] = useState<string | null>(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("sku")
  );

  /*
    ACTIVE PLANS ONLY, AND THE DATABASE DECIDES WHICH. Migration 005's
    policy is `using (is_active = true)`, so an inactive plan is not
    filtered out here - it never arrives. That matters: the filter and
    the guarantee are the same statement, and a client-side `.eq` would
    have been a second one free to drift.
  */
  useEffect(() => {
    if (!supabase) return;
    supabase
      .from("b2c_subscription_plans")
      .select("id, slug, name, variant_id, sort_order")
      .order("sort_order", { ascending: true })
      .then(({ data, error: err }) => {
        if (err) setPlansError("Die Abo-Größen konnten gerade nicht geladen werden.");
        else setPlans((data ?? []) as unknown as SubscriptionPlanRow[]);
        setPlansLoading(false);
      });
  }, []);

  /*
    THE PRESELECTED PLAN, DERIVED RATHER THAN WRITTEN.

    A plan row carries variant_id, not a SKU - migration 024 keyed it on
    the variant for the reason it gives there, that a renamed identifier
    must not be able to silently repoint a plan at a different product.
    So the hint is matched by looking the SKU up in the catalog the page
    already loaded, and an unknown or absent hint simply falls back to
    the first active plan. It is never an error: the customer is standing
    in front of the list either way.

    Derived every render instead of set by an effect, which is both the
    repository's standing preference and the only way this cannot render
    once with the wrong size selected.
  */
  const hintedPlanId = (() => {
    if (!product || plans.length === 0) return "";
    const variant = skuHint ? product.variants.find(v => v.sku === skuHint) : null;
    const hinted = variant ? plans.find(p => p.variant_id === variant.id) : null;
    return (hinted ?? plans[0]).id;
  })();
  const planId = planChoice ?? hintedPlanId;

  /* The default shipping address, preselected the same way and never forced. */
  const defaultAddressId = (addresses.find(a => a.is_default_shipping) ?? addresses[0])?.id ?? "";
  const addressId = addressChoice ?? defaultAddressId;

  /*
    THE IDEMPOTENCY TOKEN, MINTED IN THE HANDLER AND NOT IN RENDER.

    randomUUID is not a pure function, so it has no business in
    a render pass. Keyed on the (plan, address) pair in a ref: pressing
    the button twice for the same intent reuses the same token and
    therefore the same checkout attempt, while changing the size or the
    address is a different intent and gets a new one - which is exactly
    the distinction the route's own fingerprint comparison draws on the
    other side.
  */
  const tokenRef = useRef<{ key: string; id: string } | null>(null);

  const variantFor = (plan: SubscriptionPlanRow) =>
    product?.variants.find(v => v.id === plan.variant_id) ?? null;

  const priceFor = (plan: SubscriptionPlanRow): number | null => {
    const variant = variantFor(plan);
    return variant ? variant.price_gross_cents : null;
  };

  /*
    SHIPPING, FOR THE ADDRESS THE CUSTOMER HAS ACTUALLY SELECTED.

    Unlike the shop, this screen knows the destination - so it can be
    exact instead of generic, but only where being exact costs nothing.

    ── GERMANY: the real figures ─────────────────────────────────
    Read per SKU out of lib/subscriptionPurchaseRules.ts, the very rule
    handleSubscriptionCheckout applies, so this cannot show an amount
    the server would not charge.

    ── EVERY OTHER COUNTRY: the rule, not a number ───────────────
    Computing it would mean importing computeShippingGrossCents AND
    reproducing the merchandise subtotal the server derives from the
    plan's own variant - a second copy of the monetary logic living in
    a browser. That is exactly what must not happen, so the screen says
    which rule applies and lets the payment page show the binding total.

    Either way NOTHING travels: the request body carries planId,
    addressId and requestId, and the server resolves every euro itself.
  */
  const selectedCountry = normalizeCountryCode(
    addresses.find(a => a.id === addressId)?.country
  );
  const deliversToGermany = isSubscriptionBenefitCountry(selectedCountry);

  const shippingFor = (plan: SubscriptionPlanRow): number | null => {
    if (!deliversToGermany) return null;
    const variant = variantFor(plan);
    return variant ? subscriptionDeShippingGrossCents(variant.sku) : null;
  };

  const start = async () => {
    if (!session?.access_token) { setError("Bitte melde dich an."); return; }
    if (!planId) { setError("Bitte wähle eine Größe."); return; }
    if (!addressId) { setError("Bitte wähle eine Lieferadresse."); return; }
    const intentKey = `${planId}|${addressId}`;
    if (tokenRef.current?.key !== intentKey) {
      tokenRef.current = { key: intentKey, id: crypto.randomUUID() };
    }
    const requestId = tokenRef.current.id;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/subscriptions/checkout/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        // EXACTLY the three fields the route allows. A fourth would be
        // refused outright rather than ignored, which is the property
        // that keeps "the browser cannot submit a price" checked.
        body: JSON.stringify({ planId, addressId, requestId }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // Every refusal the route can produce already carries
        // customer-safe German copy - including the 503 it answers while
        // B2C_SUBSCRIPTIONS_ENABLED is closed. It is shown as-is rather
        // than replaced, so the page never claims a state the server did
        // not report. The fallback is generic on purpose: a raw server
        // string must never reach the page.
        setError(typeof body?.error === "string" ? body.error : "Das hat gerade nicht geklappt.");
        return;
      }
      const url = typeof body?.url === "string" ? body.url : "";
      if (!url) { setError("Das hat gerade nicht geklappt."); return; }
      onStarted?.();
      // Stripe Checkout is where the binding total - price, shipping and
      // tax, all resolved server-side - is shown and confirmed. Nothing
      // is charged before that page.
      window.location.href = url;
    } catch {
      setError("Das hat gerade nicht geklappt.");
    } finally {
      setBusy(false);
    }
  };

  const loading = catalogLoading || plansLoading;

  return (
    <section className="portal-section">
      <AccountSectionHeader label="ABO STARTEN" />
      <p className="portal-note">
        {SUBSCRIPTION_CADENCE_LABEL} eine Lieferung, {SUBSCRIPTION_QUANTITY_LABEL} pro Lieferung, zum normalen
        Shop-Preis. Für ein Abo ist kein gesonderter Preis und kein Rabatt hinterlegt.
        Es gibt keine Mindestlaufzeit; kündigen kannst du hier im Konto.
      </p>

      {loading ? (
        <AccountEmptyState>Laden…</AccountEmptyState>
      ) : plansError ? (
        <AccountEmptyState>{plansError}</AccountEmptyState>
      ) : plans.length === 0 ? (
        <AccountEmptyState action={<AccountAction href="/shop">ZUM SHOP</AccountAction>}>
          Aktuell ist keine Abo-Größe hinterlegt.
        </AccountEmptyState>
      ) : addresses.length === 0 ? (
        /*
          NO ADDRESS, NO FORM. The route answers 404 for a missing or
          incomplete address, and a submit button that can only produce
          that is worse than the one action which genuinely helps.
        */
        <AccountEmptyState action={<AccountAction href="/account/addresses">ADRESSE HINTERLEGEN</AccountAction>}>
          Für ein Abo brauchen wir eine Lieferadresse in deinem Konto.
        </AccountEmptyState>
      ) : (
        <div className="sub-start">
          <fieldset className="sub-start-field">
            <legend>Größe</legend>
            <div className="sub-start-options" role="radiogroup" aria-label="Abo-Größe wählen">
              {plans.map(p => {
                const cents = priceFor(p);
                const shipping = shippingFor(p);
                return (
                  <label key={p.id} className={`sub-start-option${planId === p.id ? " active" : ""}`}>
                    <input
                      type="radio" name="sub-plan" className="sr-only" value={p.id}
                      checked={planId === p.id} onChange={() => setPlanChoice(p.id)}
                    />
                    <span className="sub-start-option-label">{p.name}</span>
                    {/* The catalog price and the delivery charge, shown so
                        the choice is informed. Neither is sent: the server
                        prices the plan from its own variant and applies
                        the same shipping table this reads. */}
                    {cents !== null && <span className="sub-start-option-meta">{fmtCents(cents)} € je Lieferung</span>}
                    {/* An exact figure only for a German address. For any
                        other destination the row is absent and the note
                        under the address field carries the rule. */}
                    {shipping !== null && (
                      <span className="sub-start-option-meta">
                        {shipping === 0 ? "Kostenloser Versand" : `${fmtCents(shipping)} € Versand je Lieferung`}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="sub-start-field">
            <legend>Lieferadresse</legend>
            <select
              className="sub-start-select" value={addressId}
              onChange={e => setAddressChoice(e.target.value)} aria-label="Lieferadresse wählen"
            >
              {addresses.map(a => (
                <option key={a.id} value={a.id}>
                  {[a.first_name, a.last_name].filter(Boolean).join(" ")}, {a.street} {a.house_number}, {a.zip} {a.city}
                </option>
              ))}
            </select>
            {/* The rule for the SELECTED destination. A German address
                gets the benefit named; anywhere else is told plainly
                that its own shipping cost applies, rather than being
                shown a German figure that would not be charged. */}
            <p className="portal-note sub-start-shipping">
              {deliversToGermany
                ? `${SUBSCRIPTION_FREE_SHIPPING_NOTE} Der Versand gilt je Lieferung; den genauen Gesamtbetrag siehst du vor der Zahlung.`
                : `${SUBSCRIPTION_ABROAD_SHIPPING_NOTE} Der kostenlose Versand ab ${SUBSCRIPTION_FREE_SHIPPING_FROM_GRAMS} g gilt nur innerhalb Deutschlands. Den genauen Gesamtbetrag siehst du vor der Zahlung.`}
            </p>
          </fieldset>

          {error && <p className="sub-start-error" role="alert">{error}</p>}

          <button
            type="button" className="cta sub-start-cta" onClick={() => void start()}
            disabled={busy || !planId || !addressId}
          >
            {busy ? "WIRD GEÖFFNET…" : "ZUR ZAHLUNG"}
          </button>
        </div>
      )}
    </section>
  );
}

/* ══ JAHRESPLAN: DIE VORAUSBEZAHLTEN KOMPONENTEN ══════════════
 *
 * EVERYTHING BELOW THIS MARKER AND ABOVE PortalSubscriptions BELONGS TO
 * THE PREPAID PLAN, not to the recurring subscription. The two are
 * different contracts - one payment against thirteen fixed deliveries
 * versus a charge every 28 days until cancelled - and the tests slice
 * this file on exactly this comment so each suite can hold its own
 * surface to its own rules.
 */

// ── Jahresplan starten ─────────────────────────────────────────────────

/**
 * THE ONE PLACE A PREPAID ANNUAL PLAN IS STARTED.
 *
 * The engine behind it has been complete for some time: the checkout
 * route, the payment webhook, activation with its thirteen frozen
 * delivery dates, the daily maintenance job that fulfils deliveries 2 to
 * 13, the refund writer and the purchase-confirmation mail. What never
 * existed was a caller - nothing in the browser posted to
 * /api/annual-plan/checkout/session. This form is that caller, and it is
 * deliberately the only one.
 *
 * ── WHY IT LIVES HERE AND NOT IN THE SHOP ─────────────────────
 *
 * The route accepts exactly variantId, addressId and requestId. The
 * addressId is one of the customer's OWN saved addresses, and there is
 * no guest path at all: migration 039 made annual_plans.user_id NOT NULL
 * with no "on delete set null", because a prepaid twelve-month contract
 * must stay reachable for a year. So the shop states the offer and links
 * here with the chosen size as a hint.
 *
 * ── NOT ONE COMMERCIAL VALUE IS SENT ──────────────────────────
 *
 * No price, no discount, no shipping, no tax, no total, no delivery
 * count. Every one of them is resolved server-side by
 * handleAnnualPlanCheckout from the catalog and the customer's own
 * address row. The euro figures rendered here come from
 * buildAnnualPricing - the SAME leaf the server prices with - so they
 * cannot disagree, and they travel nowhere.
 *
 * ── GERMANY ONLY, AND THE FORM SAYS SO BEFORE THE PRICE ───────
 *
 * The server refuses a non-German address twice. This screen refuses it
 * once more, up front, so a customer does not choose a size, read a
 * total and only then discover the limit at the payment step.
 */
function AnnualPlanStartForm() {
  const { session, addresses } = useAuth();
  const { product, loading: catalogLoading } = useCatalog("matcha");

  const [variantChoice, setVariantChoice] = useState<string | null>(null);
  const [addressChoice, setAddressChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  /* The `?sku=` hint, read once and only in a browser - see the note on
     the subscription form for why this is a lazy initialiser rather than
     an effect. */
  const [skuHint] = useState<string | null>(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("sku")
  );

  // ONLY THE THREE ANNUAL LAUNCH SIZES. The Metal Case is absent from
  // ANNUAL_LAUNCH_SIZE_BY_SKU and carries no net weight, so it fails the
  // allowlist here exactly as it fails resolveAnnualLaunchPlan server-side.
  const eligible = (product?.variants ?? []).filter(v => ANNUAL_LAUNCH_SIZE_BY_SKU[v.sku] !== undefined);

  const hintedVariantId = (() => {
    if (eligible.length === 0) return "";
    const hinted = skuHint ? eligible.find(v => v.sku === skuHint) : null;
    return (hinted ?? eligible[0]).id;
  })();
  const variantId = variantChoice ?? hintedVariantId;
  const variant = eligible.find(v => v.id === variantId) ?? null;

  /* ONLY GERMAN ADDRESSES ARE OFFERED. A non-German one cannot start an
     annual plan at all, so listing it would be offering a choice that
     only leads to a refusal. The customer is told why below. */
  const germanAddresses = addresses.filter(a => isAnnualDeliveryCountry(normalizeCountryCode(a.country)));
  const defaultAddressId = (germanAddresses.find(a => a.is_default_shipping) ?? germanAddresses[0])?.id ?? "";
  const addressId = addressChoice ?? defaultAddressId;

  /* THE MONEY, from the rules module the server prices with. Rendered so
     the customer knows what they are committing to; never transmitted. */
  const pricing = (() => {
    if (!variant) return null;
    const size = ANNUAL_LAUNCH_SIZE_BY_SKU[variant.sku];
    if (!size) return null;
    const result = buildAnnualPricing({ size, catalogUnitGrossCents: variant.price_gross_cents });
    return result.ok ? result.pricing : null;
  })();

  /* Minted per intent in the handler, never during render - randomUUID is
     not a pure function. Keyed on (variant, address) so pressing twice
     reuses the same annual plan rather than minting a second one, which
     is exactly what annual_plans.payment_checkout_attempt_id's UNIQUE
     constraint is there to make impossible anyway. */
  const tokenRef = useRef<{ key: string; id: string } | null>(null);

  const start = async () => {
    if (!session?.access_token) { setError("Bitte melde dich an."); return; }
    if (!variantId) { setError("Bitte wähle eine Größe."); return; }
    if (!addressId) { setError("Bitte wähle eine Lieferadresse in Deutschland."); return; }
    const intentKey = `${variantId}|${addressId}`;
    if (tokenRef.current?.key !== intentKey) {
      tokenRef.current = { key: intentKey, id: crypto.randomUUID() };
    }
    const requestId = tokenRef.current.id;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/annual-plan/checkout/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        // EXACTLY the three fields the route allows. A fourth is refused
        // outright rather than ignored, which is the property that keeps
        // "the browser cannot submit a price" checked rather than agreed.
        body: JSON.stringify({ variantId, addressId, requestId }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // Every refusal the route produces already carries customer-safe
        // German copy - including the 503 it answers while
        // B2C_ANNUAL_PLAN_ENABLED is closed. Shown as-is, so the page
        // never claims a state the server did not report.
        setError(typeof body?.error === "string" ? body.error : "Das hat gerade nicht geklappt.");
        return;
      }
      const url = typeof body?.url === "string" ? body.url : "";
      if (!url) { setError("Das hat gerade nicht geklappt."); return; }
      // The payment page is where the binding total is shown and
      // confirmed. Nothing is charged before it.
      window.location.href = url;
    } catch {
      setError("Das hat gerade nicht geklappt.");
    } finally {
      setBusy(false);
    }
  };

  const loading = catalogLoading;
  const shipsFree = pricing?.shippingPerDeliveryGrossCents === 0;

  return (
    <section className="portal-section">
      <AccountSectionHeader label="JAHRESPLAN STARTEN" />
      <p className="portal-note">
        {ANNUAL_DELIVERY_COUNT} Lieferungen im {ANNUAL_DELIVERY_INTERVAL_DAYS}-Tage-Rhythmus,
        {" "}{ANNUAL_DISCOUNT_PERCENT} % Rabatt auf den Matcha-Preis, einmal im Voraus bezahlt.
        {" "}Keine automatische Verlängerung: der Plan endet nach der letzten Lieferung.
        {" "}{ANNUAL_GERMANY_ONLY_NOTE}
      </p>

      {loading ? (
        <AccountEmptyState>Laden…</AccountEmptyState>
      ) : eligible.length === 0 ? (
        <AccountEmptyState action={<AccountAction href="/shop">ZUM SHOP</AccountAction>}>
          Aktuell ist keine Größe als Jahresplan hinterlegt.
        </AccountEmptyState>
      ) : germanAddresses.length === 0 ? (
        /*
          NO GERMAN ADDRESS, NO FORM. The route answers 409 for a
          non-German destination, so a submit button here could only
          produce that. The customer is told why and offered the one
          action that helps.
        */
        <AccountEmptyState action={<AccountAction href="/account/addresses">ADRESSE HINTERLEGEN</AccountAction>}>
          {addresses.length === 0
            ? "Für einen Jahresplan brauchen wir eine Lieferadresse in Deutschland."
            : "Für einen Jahresplan brauchen wir eine Lieferadresse in Deutschland. Deine hinterlegten Adressen liegen außerhalb Deutschlands."}
        </AccountEmptyState>
      ) : (
        <div className="sub-start">
          <fieldset className="sub-start-field">
            <legend>Größe</legend>
            <div className="sub-start-options" role="radiogroup" aria-label="Jahresplan-Größe wählen">
              {eligible.map(v => {
                const size = ANNUAL_LAUNCH_SIZE_BY_SKU[v.sku];
                const p = size ? buildAnnualPricing({ size, catalogUnitGrossCents: v.price_gross_cents }) : null;
                const cents = p?.ok ? p.pricing.totalGrossCents : null;
                return (
                  <label key={v.id} className={`sub-start-option${variantId === v.id ? " active" : ""}`}>
                    <input
                      type="radio" name="annual-variant" className="sr-only" value={v.id}
                      checked={variantId === v.id} onChange={() => setVariantChoice(v.id)}
                    />
                    <span className="sub-start-option-label">{product?.name} · {v.label}</span>
                    {cents !== null && (
                      <span className="sub-start-option-meta">{fmtCents(cents)} € einmalig · {ANNUAL_DELIVERY_COUNT} Lieferungen</span>
                    )}
                  </label>
                );
              })}
            </div>
          </fieldset>

          {/* THE FULL COMMERCIAL TRUTH OF THE SELECTED SIZE, from the
              same leaf the server prices with. */}
          {pricing && (
            <dl className="annual-start-lines">
              <div><dt>Rabatt</dt><dd>{pricing.discountPercentApplied} % auf den Matcha-Preis</dd></div>
              <div><dt>Matcha je Lieferung</dt><dd>{fmtCents(pricing.annualUnitGrossCents)} €</dd></div>
              <div><dt>Matcha gesamt</dt><dd>{fmtCents(pricing.merchandiseTotalGrossCents)} €</dd></div>
              <div><dt>Versand je Lieferung</dt><dd>{shipsFree ? "kostenlos" : `${fmtCents(pricing.shippingPerDeliveryGrossCents)} €`}</dd></div>
              <div><dt>Versand gesamt</dt><dd>{shipsFree ? "kostenlos" : `${fmtCents(pricing.shippingTotalGrossCents)} €`}</dd></div>
              <div><dt>Lieferungen</dt><dd>{pricing.deliveryCount} · alle {ANNUAL_DELIVERY_INTERVAL_DAYS} Tage</dd></div>
              <div className="annual-start-total"><dt>Gesamt, einmalig</dt><dd>{fmtCents(pricing.totalGrossCents)} €</dd></div>
            </dl>
          )}

          <fieldset className="sub-start-field">
            <legend>Lieferadresse (Deutschland)</legend>
            <select
              className="sub-start-select" value={addressId}
              onChange={e => setAddressChoice(e.target.value)} aria-label="Lieferadresse wählen"
            >
              {germanAddresses.map(a => (
                <option key={a.id} value={a.id}>
                  {[a.first_name, a.last_name].filter(Boolean).join(" ")}, {a.street} {a.house_number}, {a.zip} {a.city}
                </option>
              ))}
            </select>
            <p className="portal-note sub-start-shipping">
              {ANNUAL_GERMANY_ONLY_NOTE} Der Versand für alle {ANNUAL_DELIVERY_COUNT} Lieferungen ist im
              {" "}Gesamtbetrag enthalten; es folgt keine weitere Abbuchung.
            </p>
          </fieldset>

          {error && <p className="sub-start-error" role="alert">{error}</p>}

          <button
            type="button" className="cta sub-start-cta" onClick={() => void start()}
            disabled={busy || !variantId || !addressId}
          >
            {busy ? "WIRD GEÖFFNET…" : "ZUR ZAHLUNG"}
          </button>
        </div>
      )}
    </section>
  );
}

// ── Jahresplan: laufende Pläne ─────────────────────────────────────────

/**
 * THE CUSTOMER'S OWN PREPAID ANNUAL PLANS.
 *
 * Every value comes from lib/annualPlanAccount.ts, a pure leaf that was
 * written for exactly this and had never been rendered by anything. It
 * derives the view from the plan row and its thirteen delivery rows, and
 * this component adds no arithmetic of its own.
 *
 * ── WHAT THE BROWSER IS ALLOWED TO SEE ────────────────────────
 *
 * Migration 041 replaced the table-level SELECT with a COLUMN grant, so
 * the browser can read only the nineteen columns the account needs.
 * ANNUAL_PLAN_ACCOUNT_SELECT names exactly those; asking for anything
 * else is refused by the database rather than by this file. In
 * particular stripe_payment_intent_id, the addresses, the tax snapshots
 * and payment_checkout_attempt_id are unreachable from here.
 *
 * ── AND IT IS NOT AN ABO ──────────────────────────────────────
 *
 * A prepaid plan is a different contract from the recurring
 * subscription: it is paid once, runs a fixed thirteen deliveries and
 * ends. The copy never calls it an Abo and never offers a cancellation
 * cutoff, because neither applies.
 */
function PortalAnnualPlans({ onCount }: { onCount?: (n: number) => void }) {
  const [views, setViews] = useState<AnnualPlanAccountView[]>([]);
  const [loading, setLoading] = useState(() => !!supabase);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!supabase) return;
    let stale = false;
    (async () => {
      /*
        TWO READS, NOT ONE PER PLAN. The plans first, then every delivery
        row belonging to them in ONE `.in(...)`. RLS confines both to the
        caller's own rows, so the id list can only ever hold their own.
      */
      const planRead = await supabase
        .from("annual_plans").select(ANNUAL_PLAN_ACCOUNT_SELECT).order("purchased_at", { ascending: false });
      if (stale) return;
      if (planRead.error) {
        setError("Deine Jahrespläne konnten gerade nicht geladen werden.");
        setLoading(false);
        return;
      }
      const plans = (planRead.data ?? []) as unknown as AnnualPlanAccountRow[];
      let deliveries: (AnnualPlanDeliveryAccountRow & { annual_plan_id: string })[] = [];
      if (plans.length > 0) {
        const deliveryRead = await supabase
          .from("annual_plan_deliveries")
          .select(ANNUAL_PLAN_DELIVERY_ACCOUNT_SELECT)
          .in("annual_plan_id", plans.map(p => p.id))
          .order("delivery_number", { ascending: true });
        if (stale) return;
        if (!deliveryRead.error) {
          deliveries = (deliveryRead.data ?? []) as unknown as (AnnualPlanDeliveryAccountRow & { annual_plan_id: string })[];
        }
      }
      const built = plans
        .map(plan => buildAnnualPlanAccountView(plan, deliveries.filter(d => d.annual_plan_id === plan.id)))
        .filter((v): v is AnnualPlanAccountView => v !== null);
      setViews(built);
      onCount?.(built.length);
      setLoading(false);
    })();
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <p className="portal-loading">Laden…</p>;
  if (error) return <section className="portal-section"><AccountEmptyState>{error}</AccountEmptyState></section>;
  if (views.length === 0) return null;

  return (
    <section className="portal-section">
      <AccountSectionHeader label="DEIN JAHRESPLAN" />
      <div className="sub-list">
        {views.map(v => (
          <div key={v.id} className="sub-card annual-card">
            <div className="sub-card-head">
              <span className="sub-card-name">
                {v.product?.name ?? "GLOA Matcha"}{v.product?.variantLabel ? ` · ${v.product.variantLabel}` : ""}
              </span>
              <span className="sub-card-status">{annualStatusLabel(v)}</span>
            </div>
            <dl className="sub-card-facts">
              <div><dt>Gekauft am</dt><dd>{v.purchasedAt ? fmtDate(v.purchasedAt) : "—"}</dd></div>
              {/* COMPLETED / TOTAL, both from the view. deliveryCount is
                  the frozen 13; fulfilledDeliveries counts the rows the
                  maintenance job actually settled. */}
              <div><dt>Lieferungen</dt><dd>{v.fulfilledDeliveries} von {v.deliveryCount}</dd></div>
              <div><dt>Offen</dt><dd>{Math.max(0, v.deliveryCount - v.fulfilledDeliveries)}</dd></div>
              {v.nextDelivery && (
                <div><dt>Nächste Lieferung</dt><dd>{fmtDate(v.nextDelivery.scheduledFor)}</dd></div>
              )}
              <div><dt>Läuft bis</dt><dd>{v.planEndAt ? fmtDate(v.planEndAt) : "—"}</dd></div>
              <div><dt>Bezahlt</dt><dd>{fmtCents(v.totalGrossCents)} €</dd></div>
              <div>
                <dt>Versand</dt>
                <dd>{v.shippingTotalGrossCents === 0
                  ? "kostenlos"
                  : `${fmtCents(v.shippingTotalGrossCents)} € · enthalten`}</dd>
              </div>
              {v.refundedTotalCents > 0 && (
                <div><dt>Erstattet</dt><dd>{fmtCents(v.refundedTotalCents)} €</dd></div>
              )}
            </dl>
            <p className="portal-note">
              Einmal bezahlt, keine automatische Verlängerung. Der Plan endet nach der letzten
              {" "}der {v.deliveryCount} Lieferungen; es folgt keine weitere Abbuchung.
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The status word for a plan, derived from the view's own flags.
 *
 * A refunded plan is never reported as running, and a cancelled one is
 * never reported as active - the same discipline
 * resolveAnnualCheckoutReturnState applies on the return page.
 */
function annualStatusLabel(v: AnnualPlanAccountView): string {
  if (v.cancelledAt || v.status === "cancelled") return "Beendet";
  if (v.paymentStatus === "refunded") return "Erstattet";
  if (v.status === "completed") return "Abgeschlossen";
  if (v.status === "active") return "Aktiv";
  if (!v.purchasedAt) return "Zahlung wird verarbeitet";
  return "Offen";
}

/**
 * THE RETURN FROM STRIPE, FOR BOTH PRODUCTS.
 *
 * Nothing here celebrates a purchase the webhook has not confirmed. The
 * annual state is resolved by resolveAnnualCheckoutReturnState against
 * the customer's own rows; the subscription state has no id to resolve
 * against, so it reports the only honest thing - the payment was
 * submitted and activation is webhook-driven.
 *
 * ── AND NOTHING POLLS ─────────────────────────────────────────
 *
 * No interval, no retry loop and no Stripe call. A page that polled
 * would be asking a second source of truth about money; the customer is
 * told plainly that a reload may be needed in a moment.
 */
function CheckoutReturnBanner() {
  /*
    THE PARAMETERS ARE READ ONCE, IN A BROWSER.

    Both return URLs are the routes' own and unchanged:
      subscriptions  /account/subscriptions?subscription=processing|cancelled
      annual         /account?annual=…&annualPlanId=…  →  the account
                     landing forwards the query to /account/dashboard
    So this banner is mounted in the portal shell and appears on
    whichever page the customer actually lands on.
  */
  const [params] = useState<{ subscription: string | null; annual: string | null; annualPlanId: string | null }>(() => {
    if (typeof window === "undefined") return { subscription: null, annual: null, annualPlanId: null };
    const p = new URLSearchParams(window.location.search);
    return {
      subscription: p.get("subscription"),
      annual: p.get("annual"),
      annualPlanId: p.get(ANNUAL_CHECKOUT_RETURN_PARAM),
    };
  });

  const [annualState, setAnnualState] = useState<AnnualCheckoutReturnState | null>(null);

  useEffect(() => {
    if (!supabase || !params.annual || !params.annualPlanId) return;
    let stale = false;
    (async () => {
      /*
        ONE READ, AND THE STATE IS DECIDED BY THE LEAF.

        The id in the URL is untrusted and is only a selector: RLS returns
        the caller's own plans, resolveAnnualCheckoutReturnState looks for
        the target among them, and a stranger's id, a guess and a deleted
        row all answer "none" identically. Nothing asks Stripe.
      */
      const read = await supabase
        .from("annual_plans").select("id, status, payment_status, purchased_at");
      if (stale) return;
      setAnnualState(resolveAnnualCheckoutReturnState({
        targetAnnualPlanId: params.annualPlanId,
        plans: read.error ? [] : (read.data ?? []) as unknown as { id: string; status: string; payment_status: string; purchased_at: string | null }[],
      }));
    })();
    return () => { stale = true; };
  }, [params.annual, params.annualPlanId]);

  const subscriptionState: "processing" | "cancelled" | null =
    params.subscription === "processing" ? "processing"
      : params.subscription === "cancelled" ? "cancelled"
        : null;

  if (!annualState && !subscriptionState) return null;

  const copy: { tone: string; title: string; body: string } | null =
    subscriptionState === "processing"
      ? {
        tone: "processing",
        title: "Deine Zahlung wird verarbeitet.",
        body: "Dein Abo erscheint hier, sobald Stripe die Zahlung bestätigt hat. Das dauert meist nur einen Moment – lade die Seite dann einfach neu.",
      }
      : subscriptionState === "cancelled"
        ? {
          tone: "cancelled",
          title: "Du hast die Zahlung abgebrochen.",
          body: "Es wurde nichts abgebucht und kein Abo gestartet. Du kannst jederzeit neu starten.",
        }
        : annualState === "processing"
          ? {
            tone: "processing",
            title: "Deine Zahlung wird verarbeitet.",
            body: "Dein Jahresplan erscheint hier, sobald Stripe die Zahlung bestätigt hat. Das dauert meist nur einen Moment – lade die Seite dann einfach neu.",
          }
          : annualState === "active"
            ? {
              tone: "ok",
              title: "Dein Jahresplan läuft.",
              body: "Die erste Lieferung ist angelegt; die weiteren folgen automatisch im 28-Tage-Rhythmus.",
            }
            : annualState === "completed"
              ? { tone: "ok", title: "Dieser Jahresplan ist abgeschlossen.", body: "Alle Lieferungen wurden ausgeführt." }
              : annualState === "refunded"
                ? { tone: "cancelled", title: "Dieser Jahresplan wurde erstattet.", body: "Es besteht kein laufender Plan." }
                : annualState === "ended"
                  ? { tone: "cancelled", title: "Dieser Jahresplan ist beendet.", body: "Es folgen keine weiteren Lieferungen." }
                  : null;

  if (!copy) return null;

  return (
    <section className={`portal-section checkout-return checkout-return-${copy.tone}`} role="status">
      <p className="checkout-return-title">{copy.title}</p>
      <p className="checkout-return-body">{copy.body}</p>
    </section>
  );
}

// ── Abos ───────────────────────────────────────────────────────────────

function PortalSubscriptions() {
  const [subs, setSubs] = useState<SubscriptionRow[]>([]);
  const [loading, setLoading] = useState(() => !!supabase);
  const [error, setError] = useState("");
  // The catalog is no longer read here. SubscriptionStartForm owns it
  // now, because it is the component that actually needs a price next to
  // a choosable size; this one lists what already exists, and every
  // figure on a subscription card comes from that subscription's own
  // frozen columns.

  useEffect(() => {
    if (!supabase) return;
    supabase.from("subscriptions").select(SUBSCRIPTION_SELECT).order("created_at", { ascending: false })
      .then(({ data, error: err }) => {
        if (err) { setError("Deine Abos konnten gerade nicht geladen werden."); }
        else {
          // The explicit column list above is a runtime string, so the
          // typed client cannot infer the row shape from it the way it
          // does for a literal. The shape is SubscriptionRow by
          // construction - SUBSCRIPTION_SELECT names exactly its columns.
          const rows = (data ?? []) as unknown as SubscriptionRow[];
          // active zuerst, dann restliche Status, innerhalb neueste zuerst
          const sorted = [...rows].sort((a, b) => {
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
            : "Regelmäßige Lieferungen für deinen GLOA Matcha."}
        </p>
      </section>

      {loading ? (
        <p className="portal-loading">Laden…</p>
      ) : error ? (
        <section className="portal-section"><AccountEmptyState>{error}</AccountEmptyState></section>
      ) : hasSubs ? (
        /*
          A LIST OF CARDS, NOT A TABLE. The previous four-column grid hid
          its header on mobile, which left four unlabelled cells and no
          way to tell a delivery date from a billing date. Every value
          here carries its own label at every width, so nothing has to be
          squeezed and nothing loses its meaning below 430px.
        */
        <div className="sub-list">
          {subs.map(s => {
            const plan = s.plan_snapshot as Record<string, string>;
            const nextDelivery = getNextDeliveryAt(s);
            const endsAt = getEffectiveEndAt(s);
            return (
              <a key={s.id} href={`/account/subscriptions/${s.id}`} className="sub-card">
                <div className="sub-card-head">
                  <span className="sub-card-name">{plan.name || "Abo"}</span>
                  <span className="sub-card-status">{getSubscriptionStatusLabel(s)}</span>
                </div>
                <dl className="sub-card-facts">
                  <div><dt>Rhythmus</dt><dd>{SUBSCRIPTION_CADENCE_LABEL}</dd></div>
                  {nextDelivery && (
                    <div><dt>Nächste Lieferung</dt><dd>{fmtDate(nextDelivery)}</dd></div>
                  )}
                  {endsAt && (
                    <div><dt>{hasEnded(s) ? "Beendet am" : "Endet am"}</dt><dd>{fmtDate(endsAt)}</dd></div>
                  )}
                  <div><dt>Pro Lieferung</dt><dd>{fmtCents(s.total_gross_cents)} €</dd></div>
                </dl>
              </a>
            );
          })}
        </div>
      ) : (
        <section className="portal-section">
          <AccountSectionHeader label="STATUS" />
          <AccountEmptyState>Du hast aktuell kein Abonnement.</AccountEmptyState>
          <p className="portal-note">
            {SUBSCRIPTION_CADENCE_LABEL} eine Lieferung, zum normalen Shop-Preis. Unten kannst du
            ein Abo starten; einzelne Bestellungen gehen weiterhin über den Shop.
          </p>
        </section>
      )}

      {/*
        THE BOOKING FORM, SHOWN WITH OR WITHOUT AN EXISTING ABO.

        A customer whose subscription ended must be able to start another
        without a detour through the shop, and one running a 30 g abo may
        legitimately want a second in another size - migration 024's
        partial unique index is on (variant, interval) per PLAN, not per
        customer, and nothing in the schema forbids two subscriptions.
        So the form is a sibling of the list rather than an empty state.

        The one thing it never does is reimplement the checkout: it calls
        the same POST /api/subscriptions/checkout/session that has existed
        since Task 29D-D, with the same three fields.
      */}
      {!loading && !error && <SubscriptionStartForm />}

      {/*
        THE PREPAID ANNUAL PLAN, ON THE SAME PAGE AND UNDER ITS OWN NAME.

        It lives here because this is where a customer looks for regular
        Matcha, and because Stripe returns an annual purchase into the
        account. It is NEVER called an Abo in its own copy: it is paid
        once, runs a fixed thirteen deliveries and ends, so neither the
        recurring wording nor the 14-day cancellation cutoff applies.

        Both components read the existing leaf and the existing route.
        Nothing here is a second annual engine.
      */}
      <PortalAnnualPlans />
      <AnnualPlanStartForm />
    </>
  );
}

// ── Abo-Detail ──────────────────────────────────────────────────────

function SubscriptionDetail({ subscriptionId }: { subscriptionId: string }) {
  const { session } = useAuth();
  const [sub, setSub] = useState<SubscriptionRow | null>(null);
  const [items, setItems] = useState<SubscriptionItemRow[]>([]);
  const [loading, setLoading] = useState(() => !!supabase);
  const [notFound, setNotFound] = useState(!supabase);

  // ── Kündigung ──
  const [confirming, setConfirming] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState("");

  /*
    AUTHORIZATION IS THE SERVER'S, NOT THIS QUERY'S. The id in the URL is
    a browser-supplied value and is treated as one: this SELECT runs under
    the customer's own session, so migration 005's RLS policy
    ("auth.uid() = user_id and not is_business_user()") is what decides
    whether a row comes back. A foreign id returns nothing, exactly like a
    non-existent one, and the cancel endpoint re-proves ownership twice
    more before it writes anything.
  */
  const fetchSubscription = async (): Promise<{
    sub: SubscriptionRow | null;
    items: SubscriptionItemRow[];
  } | null> => {
    if (!supabase) return null;
    const [sRes, iRes] = await Promise.all([
      supabase.from("subscriptions").select(SUBSCRIPTION_SELECT).eq("id", subscriptionId).maybeSingle(),
      supabase.from("subscription_items").select("*").eq("subscription_id", subscriptionId).order("created_at"),
    ]);
    return {
      sub: (sRes.data as unknown as SubscriptionRow) ?? null,
      items: (iRes.data ?? []) as SubscriptionItemRow[],
    };
  };

  useEffect(() => {
    if (!supabase) return;
    let stale = false;
    fetchSubscription().then(result => {
      if (stale) return;
      if (!result?.sub) { setNotFound(true); }
      else { setSub(result.sub); setItems(result.items); }
      setLoading(false);
    });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptionId]);

  /*
    THE PAGE NEVER INVENTS THE RESULT. On success it re-reads the row and
    renders whatever the server actually persisted, so "Kündigung
    vorgemerkt" and its date can only appear once they are true in the
    database. An optimistic local state would have been able to show a
    cancellation that never reached Stripe.
  */
  const submitCancellation = async () => {
    if (!session?.access_token) { setCancelError("Bitte melde dich an."); return; }
    setCancelBusy(true);
    setCancelError("");
    try {
      const res = await fetch("/api/subscriptions/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ subscriptionId }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // Every refusal the route can produce already carries customer-safe
        // German copy. The fallback is generic on purpose: a raw server
        // string must never reach the page.
        setCancelError(typeof body?.error === "string" ? body.error : "Das hat gerade nicht geklappt.");
        return;
      }
      setConfirming(false);
      const refreshed = await fetchSubscription();
      if (refreshed?.sub) { setSub(refreshed.sub); setItems(refreshed.items); }
    } catch {
      setCancelError("Das hat gerade nicht geklappt.");
    } finally {
      setCancelBusy(false);
    }
  };

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

  /*
    EVERY SENTENCE BELOW COMES FROM the view helpers in
    lib/subscriptionCancellationRules.ts, which read six columns and
    cannot see cancel_at, last_paid_period_end or any Stripe identifier.
    The rhythm is the contract constant, never fmtInterval: that helper is
    shared with B2B supply agreements and can say "Monatlich", which for
    this contract is always wrong.
  */
  const statusLabel = getSubscriptionStatusLabel(sub);
  const statusNote = getSubscriptionStatusNote(sub);
  const nextBilling = getNextBillingAt(sub);
  const nextDelivery = getNextDeliveryAt(sub);
  const endsAt = getEffectiveEndAt(sub);
  const scheduled = isCancellationScheduled(sub);
  const ended = hasEnded(sub);
  const canCancel = canRequestSubscriptionCancellation(sub);
  const now = new Date();
  const cutoffAt = getCancellationCutoffAt(sub, now);
  const preview = getCancellationPreview(sub, now);

  return (
    <>
      <Link href="/account/subscriptions" className="portal-back-link">&larr; Abos</Link>

      <section className="portal-page-head">
        <p className="eyebrow">ABO</p>
        <h1>{(plan.name as string) || "Dein Abo"}</h1>
      </section>

      <div className="order-detail-meta">
        <div className="portal-profile-row"><span>Status</span><strong>{statusLabel}</strong></div>
        <div className="portal-profile-row"><span>Rhythmus</span><strong>{SUBSCRIPTION_CADENCE_LABEL}</strong></div>
        <div className="portal-profile-row"><span>Menge</span><strong>{SUBSCRIPTION_QUANTITY_LABEL}</strong></div>
        {nextBilling && <div className="portal-profile-row"><span>Nächste Abrechnung</span><strong>{fmtDate(nextBilling)}</strong></div>}
        {nextDelivery && <div className="portal-profile-row"><span>Nächste Lieferung</span><strong>{fmtDate(nextDelivery)}</strong></div>}
        {endsAt && (
          <div className="portal-profile-row">
            <span>{ended ? "Beendet am" : "Endet am"}</span><strong>{fmtDate(endsAt)}</strong>
          </div>
        )}
        {sub.started_at && <div className="portal-profile-row"><span>Laufzeit seit</span><strong>{fmtDate(sub.started_at)}</strong></div>}
      </div>

      {statusNote && <p className="portal-note">{statusNote}</p>}

      {/* ── Kündigung ── */}
      <section className="order-detail-section">
        <p className="eyebrow">KÜNDIGUNG</p>
        {/*
          ENDED IS TESTED FIRST, exactly as getSubscriptionStatusLabel
          tests it first. A subscription that completed a cancellation
          still carries cancellation_requested_at and
          cancellation_effective_at - that is what a finished cancellation
          LOOKS like - so asking "is one standing?" before "has it
          ended?" would tell a customer whose abo ended in July that a
          cancellation is vorgemerkt and that it "endet am" a past date,
          while the status line directly above it says Beendet.
        */}
        {ended ? (
          <p className="order-cancel-note">
            Dieses Abo ist beendet{endsAt ? ` (${fmtDate(endsAt)})` : ""}. Neue Lieferungen gibt es nicht mehr.
          </p>
        ) : scheduled && endsAt ? (
          /*
            A STANDING CANCELLATION, AND NO SECOND CTA. The customer has
            already asked and GLOA has already promised a date, so the only
            honest thing left to show is the promise. Nothing here mentions
            what Stripe currently holds, how the last cycle is proven paid,
            or that a sweep exists.
          */
          <div className="sub-cancel">
            <p className="sub-cancel-lead">Kündigung vorgemerkt.</p>
            <p className="order-cancel-note">
              Dein Abo endet am {fmtDate(endsAt)}.
              {nextDelivery ? " Die letzte Lieferung erhältst du noch wie gewohnt." : ""}
            </p>
          </div>
        ) : canCancel && preview ? (
          <div className="sub-cancel">
            {cutoffAt && (
              <p className="order-cancel-note">
                Kündbar für den nächsten Zyklus bis {fmtDate(cutoffAt)}.
              </p>
            )}
            {!confirming ? (
              <button
                type="button"
                className="cta order-cancel-cta"
                onClick={() => { setCancelError(""); setConfirming(true); }}
              >
                Abo kündigen
              </button>
            ) : (
              /*
                A DELIBERATE SECOND STEP. One stray click must not end a
                paid contract, and the consequence is stated with the SAME
                helper the server decides with - so the sentence the
                customer agrees to is the rule the backend will apply.
              */
              <div
                className="sub-cancel-confirm"
                role="group"
                aria-labelledby="sub-cancel-confirm-title"
              >
                <p id="sub-cancel-confirm-title" className="sub-cancel-lead">Abo wirklich kündigen?</p>
                <p className="order-cancel-note">{preview.consequence}</p>
                <p className="order-cancel-note">
                  <strong>Ende: {fmtDate(preview.schedule.effectiveCancelAt)}</strong>
                </p>
                {cancelError && <p className="order-cancel-error" role="alert">{cancelError}</p>}
                <div className="sub-cancel-actions">
                  <button
                    type="button"
                    className="cta order-cancel-cta"
                    onClick={submitCancellation}
                    disabled={cancelBusy}
                  >
                    {cancelBusy ? "Wird gesendet…" : "Jetzt kündigen"}
                  </button>
                  <button
                    type="button"
                    className="sub-cancel-back"
                    onClick={() => setConfirming(false)}
                    disabled={cancelBusy}
                  >
                    Doch nicht
                  </button>
                </div>
              </div>
            )}
            {!confirming && cancelError && <p className="order-cancel-error" role="alert">{cancelError}</p>}
          </div>
        ) : (
          <p className="order-cancel-note">
            Dieses Abo lässt sich gerade nicht über das Konto kündigen. Melde dich bei uns, dann klären wir das gemeinsam.
          </p>
        )}
      </section>

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
  const { user, addresses, refreshAddresses } = useAuth();
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
      <p>{getCountryLabel(normalizeCountryCode(a.country) ?? a.country)}</p>
    </div>
  );

  /*
    THE ROW NEEDS AN OWNER, AND IT COMES FROM THE SESSION.

    public.addresses.user_id is NOT NULL and has no default, and migration
    001's policy is `for insert with check (auth.uid() = user_id)`. An
    INSERT that omits the column compares auth.uid() to NULL, which is
    not true rather than false, so the policy refuses and PostgREST
    answers 403 - which the page could only report as "Fehler beim
    Speichern."

    The owner is read from useAuth(), which holds the user supabase-js
    resolved from the verified session. It is deliberately NOT taken from
    the form: FormData is whatever the browser sends, and an owner field
    a caller can choose is an owner field a caller can forge. RLS would
    still refuse a forged one - the policy is the enforcement, this is
    only the honest value to hand it.
  */
  const handleAdd = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!supabase) return;
    // Refused here as well as by the database. Without a session there is
    // no owner to write, and sending the insert anyway would turn a known
    // state into a 403 the customer sees as a save failure.
    if (!user) { setError("Bitte melde dich an."); return; }
    setSaving(true);
    setError("");
    const f = new FormData(e.currentTarget);
    const isFirst = addresses.length === 0;
    const { error: err } = await supabase.from("addresses").insert({
      user_id: user.id,
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
            <select required name="country" defaultValue="DE">
              {SHIPPING_COUNTRY_OPTIONS.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
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
    // redirectTo is REQUIRED, and its absence here is what broke password
    // recovery after the gloamatcha.com cutover. Without it Supabase does
    // not complain - it silently falls back to the project's Site URL, so
    // the customer landed on the homepage with a bare "#" instead of the
    // reset form, and could never finish. Same helper the public forgot
    // form uses; see lib/authRedirect.ts.
    const { error: err } = await supabase.auth.resetPasswordForEmail(user.email, {
      redirectTo: browserAuthRedirectUrl(PASSWORD_RESET_PATH),
    });
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

// 4A.4b: the row types and the price helpers that used to live here
// went with the sections that rendered them. They described
// b2b_product_sizes / b2b_offer_models / b2b_general_terms, which the
// portal no longer reads - and migration 053 takes the browser's
// access to them away, so nothing here can start reading them again
// by accident.


function PortalBusiness() {
  const { businessProfile } = useAuth();
  const [agreements, setAgreements] = useState<SupplyAgreementRow[]>([]);
  // 4A.4b: the `loading` flag that used to stand here went with the
  // commercial reads it gated. The supply agreements below have always
  // had their own, and the rest of this screen renders from props.
  const [supplyLoading, setSupplyLoading] = useState(() => !!supabase);
  const [supplyError, setSupplyError] = useState("");

  useEffect(() => {
    if (!supabase) return;
    // 4A.4b: the three commercial configuration tables are NO LONGER
    // read here. They still hold the first draft of a wholesale model -
    // a price per kilo and two discount tiers - and none of it is a
    // current GLOA offer. Reading them meant a signed-in business
    // account was shown terms nobody had approved.
    //
    // Nothing replaced the read, because the portal no longer needs it:
    // prices and conditions are agreed individually until the B2B
    // commerce package exists. Migration 053 removes the browser's
    // access to those tables as well, so this cannot come back by
    // accident.
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

      {/* ── Conditions: agreed, not published ── */}
      {/*
        4A.4b REMOVED FOUR SECTIONS FROM HERE: a price table, the offer
        models with their discount tiers, the calculator that multiplied
        the two together, and a general-terms list.

        All four rendered b2b_product_sizes / b2b_offer_models /
        b2b_general_terms straight from the browser, and what those
        tables hold is the FIRST DRAFT of a wholesale model - a single
        price per kilo, minus five percent, minus ten percent. None of
        it is a current GLOA offer, and the prices it produced were not
        the ones GLOA intends to charge.

        A signed-in business account was therefore being shown
        conditions nobody had approved, in the one place a customer
        would most reasonably treat them as binding. That is worse than
        showing nothing, so it now shows nothing - and says so plainly,
        which is also what the public page has always said.

        The real price list arrives with the B2B commerce package. It is
        not restored here by editing the old rows, because the old shape
        (a rate per kilo) cannot express the intended one.
      */}
      <section className="b2b-section">
        <p className="eyebrow">PREISE &amp; KONDITIONEN</p>
        <p className="b2b-section-lead">
          B2B-Preise und Konditionen stimmen wir individuell mit dir ab – abhängig von
          Menge, Rhythmus und deinem Betrieb.
        </p>
        <div className="portal-actions">
          <Link href="/for-cafes#lead" className="portal-action">KONDITIONEN ANFRAGEN</Link>
        </div>
      </section>

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

      {/* 4A.4b: the agreement's snapshotted discount is not rendered.
          It came from the same non-final offer model as the price table
          that used to stand above, and a percentage shown without the
          price it applies to told the customer even less than nothing.
          The snapshot itself is untouched on the row. */}

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
