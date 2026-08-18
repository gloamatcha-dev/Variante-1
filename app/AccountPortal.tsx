"use client";
import { useState, useEffect } from "react";
import type { CustomerType } from "./content";
import { COUNTRIES } from "./content";

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
  const [customerType, setCustomerType] = useState<CustomerType>("private");

  useEffect(() => {
    const saved = localStorage.getItem("gloa_preview_type") as CustomerType | null;
    if (saved === "private" || saved === "business") setCustomerType(saved);
  }, []);

  const toggle = (t: CustomerType) => {
    setCustomerType(t);
    localStorage.setItem("gloa_preview_type", t);
  };

  const navItems = NAV.filter(n => !n.b2bOnly || customerType === "business");
  const firstName = customerType === "business" ? "Anna" : "Max";

  return (
    <main className="portal">
      <div className="portal-preview-bar">
        <span>FRONTEND PREVIEW</span>
        <div className="portal-preview-toggle">
          <button className={customerType === "private" ? "active" : ""} onClick={() => toggle("private")}>Privatkunde</button>
          <button className={customerType === "business" ? "active" : ""} onClick={() => toggle("business")}>Geschäftskunde</button>
        </div>
      </div>

      <nav className="portal-nav">
        {navItems.map(n => (
          <a key={n.key} href={`/account/${n.key}`} className={page === n.key ? "active" : ""}>{n.label}</a>
        ))}
        <span className="portal-nav-spacer" />
        <button className="portal-logout" onClick={() => { window.location.href = "/account"; }}>Abmelden</button>
      </nav>

      <div className="portal-content">
        {page === "dashboard" && <PortalDashboard firstName={firstName} customerType={customerType} />}
        {page === "orders" && <PortalOrders />}
        {page === "subscriptions" && <PortalSubscriptions />}
        {page === "addresses" && <PortalAddresses />}
        {page === "profile" && <PortalProfile firstName={firstName} customerType={customerType} />}
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
  const [showForm, setShowForm] = useState(false);

  return (
    <>
      <section className="portal-page-head">
        <p className="eyebrow">ADRESSEN</p>
        <h1>Adressen.</h1>
      </section>

      <div className="portal-addresses-grid">
        <section className="portal-address-block">
          <p className="eyebrow">STANDARD-LIEFERADRESSE</p>
          <p className="portal-empty">Keine Adresse hinterlegt.</p>
        </section>
        <section className="portal-address-block">
          <p className="eyebrow">RECHNUNGSADRESSE</p>
          <p className="portal-empty">Keine Adresse hinterlegt.</p>
        </section>
      </div>

      {!showForm ? (
        <button className="cta portal-add-address-btn" onClick={() => setShowForm(true)}>ADRESSE HINZUFÜGEN</button>
      ) : (
        <form className="portal-address-form account-form" onSubmit={e => e.preventDefault()}>
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
          <div className="portal-form-actions">
            <button type="submit" className="cta">ADRESSE SPEICHERN</button>
            <button type="button" className="portal-cancel-btn" onClick={() => setShowForm(false)}>Abbrechen</button>
          </div>
        </form>
      )}
    </>
  );
}

// ── Kontodaten / Profil ────────────────────────────────────────────────

function PortalProfile({ firstName, customerType }: { firstName: string; customerType: CustomerType }) {
  const lastName = customerType === "business" ? "Müller" : "Mustermann";
  const email = customerType === "business" ? "anna@cafe-matcha.de" : "max@example.de";

  return (
    <>
      <section className="portal-page-head">
        <p className="eyebrow">KONTODATEN</p>
        <h1>Kontodaten.</h1>
      </section>

      <div className="portal-profile-sections">
        <section className="portal-profile-block">
          <p className="eyebrow">PERSÖNLICHE DATEN</p>
          <div className="portal-profile-row"><span>Vorname</span><strong>{firstName}</strong></div>
          <div className="portal-profile-row"><span>Nachname</span><strong>{lastName}</strong></div>
          <div className="portal-profile-row"><span>E-Mail</span><strong>{email}</strong></div>
          <div className="portal-profile-row"><span>Telefon</span><strong>—</strong></div>
        </section>

        <section className="portal-profile-block">
          <p className="eyebrow">PASSWORT</p>
          <button className="cta" onClick={() => {}}>PASSWORT ÄNDERN</button>
        </section>

        <section className="portal-profile-block">
          <p className="eyebrow">NEWSLETTER</p>
          <label className="portal-newsletter-toggle">
            <input type="checkbox" />
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
