"use client";
import { useState } from "react";
import type { CustomerType } from "./content";
import { COUNTRIES } from "./content";
import { useAuth } from "../lib/auth";
import type { AddressRow } from "../lib/auth";
import { supabase } from "../lib/supabase";

type PortalPage = "dashboard" | "orders" | "subscriptions" | "addresses" | "profile" | "business";

const NAV: { key: PortalPage; label: string; b2bOnly?: boolean }[] = [
  { key: "dashboard", label: "Übersicht" },
  { key: "orders", label: "Bestellungen" },
  { key: "subscriptions", label: "Abos" },
  { key: "addresses", label: "Adressen" },
  { key: "profile", label: "Kontodaten" },
  { key: "business", label: "B2B", b2bOnly: true },
];

export function AccountPortal({ page }: { page: PortalPage }) {
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
          <a key={n.key} href={`/account/${n.key}`} className={page === n.key ? "active" : ""}>{n.label}</a>
        ))}
        <span className="portal-nav-spacer" />
        <button className="portal-logout" onClick={handleLogout}>Abmelden</button>
      </nav>

      <div className="portal-content">
        {page === "dashboard" && <PortalDashboard firstName={firstName} customerType={customerType} />}
        {page === "orders" && <PortalOrders />}
        {page === "subscriptions" && <PortalSubscriptions />}
        {page === "addresses" && <PortalAddresses />}
        {page === "profile" && <PortalProfile />}
        {page === "business" && <PortalBusiness />}
      </div>
    </main>
  );
}

// ── Dashboard ──────────────────────────────────────────────────────────

function PortalDashboard({ firstName, customerType }: { firstName: string; customerType: CustomerType }) {
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
          <p className="portal-empty">Du hast noch keine Bestellung.</p>
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
  return (
    <>
      <section className="portal-page-head">
        <p className="eyebrow">BESTELLUNGEN</p>
        <h1>Bestellungen.</h1>
        <p className="portal-page-lead">Hier findest du deine bisherigen Bestellungen.</p>
      </section>
      <section className="portal-empty-state">
        <p>Du hast noch keine Bestellungen.</p>
        <a className="cta" href="/shop">ZUM SHOP</a>
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
    await supabase.from("addresses").delete().eq("id", id);
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

function PortalBusiness() {
  const sections: [string, string, string[]][] = [
    ["PREISE & KONDITIONEN", "Deine B2B-Preise, Bezugsmodelle und Konditionen.", ["Einkaufspreise", "Rabattstaffelung", "Bezugsmodelle", "Vollständige Konditionen"]],
    ["BELIEFERUNG", "Regelmäßige Belieferung und Partnerschaften verwalten.", ["Regelmäßige Belieferung", "12-Monats-Partnerschaft", "Lieferintervalle", "Lieferstatus"]],
    ["BESTELLUNGEN", "Deine B2B-Bestellungen an einem Ort.", ["Aktuelle Bestellungen", "Bestellhistorie", "Wiederkehrende Bestellungen", "Rechnungen"]],
    ["ROI & KALKULATION", "Kalkuliere später mit deinen tatsächlichen Einkaufs- und Verkaufspreisen.", ["Einkaufspreis", "Verkaufspreis pro Drink", "Wareneinsatz", "Umsatz & Deckungsbeitrag"]],
    ["UNTERNEHMENSDATEN", "Firmendaten, Steuerdaten und Adressen verwalten.", ["Firmenname & Ansprechpartner", "Rechnungsadresse", "Lieferadresse", "Steuernummer & USt-IdNr."]],
  ];

  return (
    <>
      <section className="portal-page-head">
        <p className="eyebrow">B2B</p>
        <h1>B2B bei GLOA.</h1>
        <p className="portal-page-lead">Alles für deine Zusammenarbeit mit GLOA an einem Ort.</p>
      </section>

      <div className="portal-business-grid">
        {sections.map(([title, desc, items]) => (
          <div key={title} className="portal-business-card">
            <p className="eyebrow">{title}</p>
            <p className="portal-business-card-desc">{desc}</p>
            <ul>{items.map(item => <li key={item}>{item}</li>)}</ul>
          </div>
        ))}
      </div>

      <p className="portal-status-note">Verfügbar nach technischer Anbindung des Kundenkontos.</p>
    </>
  );
}
