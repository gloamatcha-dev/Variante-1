"use client";
import { useState, useEffect } from "react";
import type { CustomerType } from "./content";
import { COUNTRIES } from "./content";
import { useAuth } from "../lib/auth";
import type { AddressRow } from "../lib/auth";
import { supabase } from "../lib/supabase";

type PortalPage = "dashboard" | "orders" | "subscriptions" | "addresses" | "profile" | "business" | "order-detail";

const NAV: { key: PortalPage; label: string; b2bOnly?: boolean }[] = [
  { key: "dashboard", label: "Übersicht" },
  { key: "orders", label: "Bestellungen" },
  { key: "subscriptions", label: "Abos" },
  { key: "addresses", label: "Adressen" },
  { key: "profile", label: "Kontodaten" },
  { key: "business", label: "B2B", b2bOnly: true },
];

export function AccountPortal({ page, orderId }: { page: PortalPage; orderId?: string }) {
  const { user, profile, loading, signOut } = useAuth();
  const customerType: CustomerType = profile?.customer_type ?? "private";

  // Not logged in → redirect
  if (!loading && !user) {
    if (typeof window !== "undefined") window.location.href = "/account";
    return null;
  }

  // Business-only page guard
  if (!loading && page === "business" && customerType !== "business") {
    if (typeof window !== "undefined") window.location.href = "/account/dashboard";
    return null;
  }

  if (loading) {
    return <main className="portal"><p className="portal-loading">Laden…</p></main>;
  }

  const navItems = NAV.filter(n => !n.b2bOnly || customerType === "business");
  const firstName = profile?.first_name || "—";

  const handleLogout = async () => {
    await signOut();
    window.location.href = "/account";
  };

  return (
    <main className="portal">
      <nav className="portal-nav">
        {navItems.map(n => (
          <a key={n.key} href={`/account/${n.key}`} className={page === n.key || (n.key === "orders" && page === "order-detail") ? "active" : ""}>{n.label}</a>
        ))}
        <span className="portal-nav-spacer" />
        <button className="portal-logout" onClick={handleLogout}>Abmelden</button>
      </nav>

      <div className="portal-content">
        {page === "dashboard" && <PortalDashboard firstName={firstName} customerType={customerType} />}
        {page === "orders" && <PortalOrders />}
        {page === "order-detail" && <OrderDetail orderId={orderId!} />}
        {page === "subscriptions" && <PortalSubscriptions />}
        {page === "addresses" && <PortalAddresses />}
        {page === "profile" && <PortalProfile />}
        {page === "business" && <PortalBusiness />}
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
  placed_at: string | null;
  created_at: string;
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

const STATUS_DE: Record<string, string> = {
  pending: "Eingegangen",
  confirmed: "Bestätigt",
  processing: "In Bearbeitung",
  shipped: "Versendet",
  delivered: "Zugestellt",
  cancelled: "Storniert",
  refunded: "Erstattet",
};

const fmtCents = (cents: number) => (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });

// ── Dashboard ──────────────────────────────────────────────────────────

function PortalDashboard({ firstName, customerType }: { firstName: string; customerType: CustomerType }) {
  const [lastOrder, setLastOrder] = useState<OrderRow | null>(null);
  const [orderLoading, setOrderLoading] = useState(true);

  useEffect(() => {
    if (!supabase) { setOrderLoading(false); return; }
    supabase.from("orders").select("*").order("created_at", { ascending: false }).limit(1)
      .then(({ data }) => { setLastOrder(data?.[0] ?? null); setOrderLoading(false); });
  }, []);

  return (
    <>
      <section className="portal-greeting">
        <p className="eyebrow">DEIN GLOA</p>
        <h1>Hallo, {firstName}.</h1>
      </section>

      <div className="portal-dashboard-grid">
        <section className="portal-dash-block portal-dash-wide">
          <p className="eyebrow">NÄCHSTE LIEFERUNG</p>
          <p className="portal-empty">Keine geplante Lieferung.</p>
        </section>

        <section className="portal-dash-block">
          <p className="eyebrow">LETZTE BESTELLUNG</p>
          {orderLoading ? (
            <p className="portal-empty">Laden…</p>
          ) : lastOrder ? (
            <div className="portal-dash-order">
              <div className="portal-dash-order-row"><span>{lastOrder.order_number}</span><span>{fmtDate(lastOrder.placed_at || lastOrder.created_at)}</span></div>
              <div className="portal-dash-order-row"><span>{STATUS_DE[lastOrder.status] || lastOrder.status}</span><strong>{fmtCents(lastOrder.customer_type === "business" ? lastOrder.total_net_cents : lastOrder.total_gross_cents)} €{lastOrder.customer_type === "business" ? " netto" : ""}</strong></div>
              <a href={`/account/orders/${lastOrder.id}`} className="portal-dash-order-link">BESTELLUNG ANSEHEN</a>
            </div>
          ) : (
            <p className="portal-empty">Du hast noch keine Bestellung.</p>
          )}
        </section>

        <section className="portal-dash-block">
          <p className="eyebrow">DEIN ABO</p>
          <p className="portal-empty">Du hast aktuell kein aktives Abo.</p>
        </section>
      </div>

      <section className="portal-quicklinks">
        <p className="eyebrow">SCHNELLZUGRIFFE</p>
        <div className="portal-quicklinks-grid">
          <a href="/account/orders">Bestellungen</a>
          <a href="/account/subscriptions">Abos</a>
          <a href="/account/addresses">Adressen</a>
          <a href="/account/profile">Kontodaten</a>
          {customerType === "business" && <a href="/account/business">B2B</a>}
        </div>
      </section>
    </>
  );
}

// ── Bestellungen ───────────────────────────────────────────────────────

function PortalOrders() {
  const { profile } = useAuth();
  const isBusiness = profile?.customer_type === "business";
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!supabase) { setLoading(false); return; }
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
          <a className="cta" href="/shop">ZUM SHOP</a>
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
              <span>{STATUS_DE[o.status] || o.status}</span>
              <span className="order-list-total">{fmtCents(isBusiness ? o.total_net_cents : o.total_gross_cents)} €{isBusiness ? " netto" : ""}</span>
            </a>
          ))}
        </div>
      )}
    </>
  );
}

// ── Bestelldetail ─────────────────────────────────────────────────────

function OrderDetail({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<OrderRow | null>(null);
  const [items, setItems] = useState<OrderItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!supabase) { setLoading(false); setNotFound(true); return; }
    Promise.all([
      supabase.from("orders").select("*").eq("id", orderId).maybeSingle(),
      supabase.from("order_items").select("*").eq("order_id", orderId).order("created_at"),
    ]).then(([oRes, iRes]) => {
      if (!oRes.data) { setNotFound(true); }
      else { setOrder(oRes.data); setItems(iRes.data ?? []); }
      setLoading(false);
    });
  }, [orderId]);

  if (loading) return <p className="portal-loading">Laden…</p>;

  if (notFound || !order) return (
    <>
      <section className="portal-page-head">
        <p className="eyebrow">BESTELLUNG</p>
        <h1>Bestellung nicht gefunden.</h1>
      </section>
      <a href="/account/orders" className="portal-back-link">&larr; Zurück zu Bestellungen</a>
    </>
  );

  const isBusiness = order.customer_type === "business";
  const ship = order.shipping_address_snapshot as Record<string, string>;
  const bill = order.billing_address_snapshot as Record<string, string>;

  return (
    <>
      <a href="/account/orders" className="portal-back-link">&larr; Bestellungen</a>

      <section className="portal-page-head">
        <p className="eyebrow">BESTELLUNG {order.order_number}</p>
        <h1>{order.order_number}</h1>
      </section>

      <div className="order-detail-meta">
        <div className="portal-profile-row"><span>Datum</span><strong>{fmtDate(order.placed_at || order.created_at)}</strong></div>
        <div className="portal-profile-row"><span>Status</span><strong>{STATUS_DE[order.status] || order.status}</strong></div>
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
                <span className="order-item-unit">{fmtCents(isBusiness ? item.unit_price_net_cents : item.unit_price_gross_cents)} €</span>
                <span className="order-item-total">{fmtCents(isBusiness ? item.line_total_net_cents : item.line_total_gross_cents)} €</span>
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
            <p>{ship.country}</p>
          </div>
        </section>
        <section className="order-detail-section">
          <p className="eyebrow">RECHNUNGSADRESSE</p>
          <div className="portal-address-display">
            <p>{bill.first_name} {bill.last_name}</p>
            {bill.company && <p>{bill.company}</p>}
            <p>{bill.street} {bill.house_number}</p>
            <p>{bill.zip} {bill.city}</p>
            <p>{bill.country}</p>
          </div>
        </section>
      </div>

      {/* ── Totals ── */}
      <section className="order-detail-section">
        <p className="eyebrow">SUMME</p>
        <div className="order-totals">
          <div className="portal-profile-row"><span>Zwischensumme</span><strong>{fmtCents(isBusiness ? order.subtotal_net_cents : order.subtotal_gross_cents)} €</strong></div>
          {order.discount_total_cents > 0 && (
            <div className="portal-profile-row"><span>Rabatt</span><strong>&minus;{fmtCents(order.discount_total_cents)} €</strong></div>
          )}
          {(order.shipping_net_cents > 0 || order.shipping_gross_cents > 0) && (
            <div className="portal-profile-row"><span>Versand</span><strong>{fmtCents(isBusiness ? order.shipping_net_cents : order.shipping_gross_cents)} €</strong></div>
          )}
          {order.tax_total_cents > 0 && (
            <div className="portal-profile-row"><span>MwSt.</span><strong>{fmtCents(order.tax_total_cents)} €</strong></div>
          )}
          <div className="portal-profile-row order-total-final">
            <span>Gesamt{isBusiness ? " netto" : ""}</span>
            <strong>{fmtCents(isBusiness ? order.total_net_cents : order.total_gross_cents)} €</strong>
          </div>
        </div>
      </section>
    </>
  );
}

// ── Abos ───────────────────────────────────────────────────────────────

function PortalSubscriptions() {
  return (
    <>
      <section className="portal-page-head">
        <p className="eyebrow">ABOS</p>
        <h1>Deine Abos.</h1>
        <p className="portal-page-lead">Verwalte hier deine regelmäßigen Lieferungen.</p>
      </section>
      <section className="portal-empty-state">
        <p>Du hast aktuell kein aktives Abo.</p>
        <a className="cta" href="/shop">MATCHA ENTDECKEN</a>
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

  const handleNewsletter = async (checked: boolean) => {
    if (!supabase || !user) return;
    await supabase.from("profiles").update({ newsletter_opt_in: checked }).eq("user_id", user.id);
    await refreshProfile();
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
              <div className="portal-profile-row"><span>Vorname</span><strong>{profile?.first_name || "—"}</strong></div>
              <div className="portal-profile-row"><span>Nachname</span><strong>{profile?.last_name || "—"}</strong></div>
              <div className="portal-profile-row"><span>E-Mail</span><strong>{user?.email || "—"}</strong></div>
              <div className="portal-profile-row"><span>Telefon</span><strong>{profile?.phone || "—"}</strong></div>
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
            <div className="portal-profile-row"><span>Firma</span><strong>{businessProfile.company_name || "—"}</strong></div>
            {businessProfile.legal_form && <div className="portal-profile-row"><span>Rechtsform</span><strong>{businessProfile.legal_form}</strong></div>}
            <div className="portal-profile-row"><span>Steuernummer</span><strong>{businessProfile.tax_number || "—"}</strong></div>
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
          <p className="eyebrow">NEWSLETTER</p>
          <label className="portal-newsletter-toggle">
            <input
              type="checkbox"
              checked={profile?.newsletter_opt_in ?? false}
              onChange={e => handleNewsletter(e.target.checked)}
            />
            Ich möchte Neuigkeiten und Angebote von GLOA erhalten.
          </label>
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabase) { setLoading(false); return; }
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
  }, []);

  if (loading) return <p className="portal-loading">Laden…</p>;

  return (
    <>
      <section className="portal-page-head">
        <p className="eyebrow">B2B</p>
        <h1>B2B bei GLOA.</h1>
        <p className="portal-page-lead">Preise, Bezugsmodelle und Konditionen für dein Unternehmen.</p>
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
          <div className="b2b-company-data">
            <div className="portal-profile-row"><span>Firma</span><strong>{businessProfile.company_name || "\u2014"}</strong></div>
            {businessProfile.legal_form && <div className="portal-profile-row"><span>Rechtsform</span><strong>{businessProfile.legal_form}</strong></div>}
            <div className="portal-profile-row"><span>Steuernummer</span><strong>{businessProfile.tax_number || "\u2014"}</strong></div>
            {businessProfile.vat_id && <div className="portal-profile-row"><span>USt-IdNr.</span><strong>{businessProfile.vat_id}</strong></div>}
            {businessProfile.website && <div className="portal-profile-row"><span>Website</span><strong>{businessProfile.website}</strong></div>}
          </div>
          <a href="/account/profile" className="b2b-edit-link">Kontodaten bearbeiten →</a>
        </section>
      )}
    </>
  );
}
