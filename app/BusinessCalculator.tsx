"use client";
import { useEffect, useState } from "react";
import type { LeadPayload } from "./content";
import { track } from "./analytics";

export function BusinessCalculator(){
 const [intent,setIntent]=useState<"wholesale"|"sample">("wholesale"),[success,setSuccess]=useState(false);
 useEffect(()=>{if(new URLSearchParams(window.location.search).get("intent")==="sample")setIntent("sample")},[]);
 const choose=(i:"wholesale"|"sample")=>{setIntent(i);track(i==="sample"?"sample_request_start":"wholesale_request_start");document.getElementById("lead")?.scrollIntoView({behavior:"smooth"})};
 const submit=(e:React.FormEvent<HTMLFormElement>)=>{e.preventDefault();const f=new FormData(e.currentTarget);const payload:LeadPayload={lead_type:intent,contact_name:String(f.get("contact_name")),business_name:String(f.get("business_name")),email:String(f.get("email")),city:String(f.get("city")),business_type:String(f.get("business_type")),locations:String(f.get("locations")),pricing_interest:String(f.get("pricing_interest")||""),estimated_monthly_demand:String(f.get("demand")||""),current_supplier:String(f.get("supplier")||""),message:String(f.get("message")||""),created_at:new Date().toISOString()};window.dispatchEvent(new CustomEvent("gloa:b2b-lead",{detail:payload}));track(intent==="sample"?"sample_request_submit":"wholesale_request_submit");setSuccess(true)};
 return <><section className="b2b-compare"><p className="eyebrow">BEZUGSMODELLE</p><h2>Flexibel bestellen<br/><i>oder langfristig profitieren.</i></h2><div className="b2b-compare-grid"><div className="b2b-compare-card"><p className="eyebrow">FLEXIBEL</p><h3>Regelmäßige Belieferung</h3><ul><li>5 % Preisvorteil gegenüber Einzelbestellung</li><li>Flexible monatliche Lieferung</li></ul><button className="cta" onClick={()=>choose("wholesale")}>Konditionen anfragen</button></div><div className="b2b-compare-card"><p className="eyebrow">PLANBAR</p><h3>12-Monats-Partnerschaft</h3><ul><li>10 % Preisvorteil gegenüber Einzelbestellung</li><li>Planbare monatliche Belieferung</li></ul><button className="cta dark" onClick={()=>choose("wholesale")}>Partnerschaft anfragen</button></div></div><p className="b2b-compare-note">Je länger wir deinen Bedarf planen können, desto größer ist dein Preisvorteil. Preise und Konditionen erhältst du auf Anfrage.</p></section>

<section className="b2b-portal-hint"><div><p className="eyebrow">B2B KUNDENPORTAL</p><h2>Preise, Konditionen<br/><i>und dein Dashboard.</i></h2><p>Detaillierte Preise, individuelle Konditionen und ein eigenes B2B-Dashboard — alles in deinem GLOA Geschäftskonto.</p><div className="b2b-portal-hint-actions"><a className="cta cream" href="/account?type=business">Geschäftskonto erstellen</a><button className="cta dark" onClick={()=>choose("wholesale")}>B2B-Anfrage starten</button></div></div></section>

<section className="b2b-steps"><p className="eyebrow">HOW IT WORKS</p><h2>Matcha, bevor<br/><i>er ausgeht.</i></h2><div className="b2b-steps-grid"><article><span>01</span><h3>Anfrage stellen</h3><p>Sag uns, was du brauchst. Wir melden uns mit einem persönlichen Angebot.</p></article><article><span>02</span><h3>Modell wählen</h3><p>Einzelbestellung, regelmäßige Belieferung oder 12-Monats-Partnerschaft.</p></article><article><span>03</span><h3>Monatlich geliefert</h3><p>Deine vereinbarte Menge wird regelmäßig geliefert.</p></article><article><span>04</span><h3>Bedarf anpassen</h3><p>Zusätzliche Mengen können bei Bedarf angefragt werden.</p></article></div></section>

<section className="supply"><p className="eyebrow">AUS JAPAN. LAGER IN DEUTSCHLAND.</p><div className="supply-path"><strong>SHIZUOKA<small>Origin</small></strong><i>&rarr;</i><strong>DEUTSCHLAND<small>Lokaler Bestand</small></strong><i>&rarr;</i><strong>DEIN CAF&Eacute;<small>Schnelle Nachbestellung</small></strong></div><p>Lieferzeit und Verfügbarkeit werden bei Bestellung bestätigt.</p></section>

<section className="business-support"><p className="eyebrow">MEHR ALS MATCHA</p><h2>Wir helfen dir,<br/><i>Matcha auf die Karte zu bringen.</i></h2><div>{[["REZEPT-GUIDES","Standardisierte Rezepte für gleichbleibende Drinks."],["BAR-SOPs","Klare Abläufe für dein Team."],["TEAM-TRAINING","Kompakte Schulungsmaterialien."],["MENÜ-SUPPORT","Hilfe bei der Integration in deine Karte."],["SOCIAL TOOLKIT","Fertiger Content für deinen Launch."]].map(([a,b])=><article key={a}><h3>{a}</h3><p>{b}</p><small>Verfügbar ab Launch</small></article>)}</div></section>

<section className="sample-callout"><div><p className="eyebrow">PROBIER'S ERSTMAL.</p><h2>Test it with<br/>your team.</h2></div><div><p>Bestell ein Sample, bevor du deine erste größere Bestellung aufgibst. Konditionen klären wir individuell.</p><button className="cta" onClick={()=>choose("sample")}>Sample anfragen</button></div></section>

<section id="lead" className="lead-section">{success?<div className="form-success"><p className="eyebrow">GLOA FOR BUSINESS</p><h2>{intent==="sample"?"Deine Sample-Anfrage ist drin.":"Danke. Wir melden uns."}</h2><p>Wir haben deine Anfrage erhalten und melden uns mit den nächsten Schritten.</p></div>:<form className="lead-form" onSubmit={submit}><p className="eyebrow wide">GLOA FOR BUSINESS</p><h2>Let's talk<br/><i>Matcha.</i></h2><div className="intent-tabs"><button type="button" className={intent==="wholesale"?"active":""} onClick={()=>setIntent("wholesale")}>B2B-Anfrage</button><button type="button" className={intent==="sample"?"active":""} onClick={()=>setIntent("sample")}>Sample</button></div><label>Ansprechpartner/in*<input required name="contact_name"/></label><label>Unternehmen / Café*<input required name="business_name"/></label><label>E-Mail*<input required type="email" name="email"/></label><label>Stadt*<input required name="city"/></label><label>Unternehmenstyp*<select required name="business_type" defaultValue=""><option value="" disabled>Bitte auswählen</option>{["Eigenständiges Café","Café-Gruppe","Restaurant","Hotel","Büro / Office","Fitness / Pilates / Wellness","Einzelhandel","Sonstiges"].map(x=><option key={x}>{x}</option>)}</select></label><label>Anzahl Standorte*<input required min="1" type="number" name="locations"/></label><label>Interesse an<select name="pricing_interest"><option>Noch nicht sicher</option><option>Einzelbestellung</option><option>Regelmäßige Belieferung · 5 %</option><option>12-Monats-Partnerschaft · 10 %</option><option>Sample</option></select></label><label>Geplanter monatlicher Bedarf<select name="demand"><option>Noch nicht sicher</option><option>Unter 1 kg</option><option>1–2 kg</option><option>3–5 kg</option><option>6–10 kg</option><option>10+ kg</option></select></label><label>Aktueller Matcha-Lieferant<input name="supplier"/></label><label className="wide">Nachricht<textarea name="message"/></label><label className="consent wide"><input required type="checkbox"/> Ich stimme zu, dass GLOA meine Angaben zur Bearbeitung meiner Anfrage verwenden darf.</label><button className="cta cream wide">{intent==="sample"?"Sample-Anfrage senden":"B2B-Konditionen anfragen"}</button></form>}</section></>
}

// ──────────────────────────────────────────────────────────────────────
// ARCHIVIERT: Calculator, Pricing Cards, Beispielrechnung
// Diese Sektionen werden öffentlich nicht mehr angezeigt.
// Preise und Konditionen sind vertraulich und werden individuell kommuniziert.
// Die Daten bleiben für den B2B-Bereich unter /account/business erhalten.
// ──────────────────────────────────────────────────────────────────────

// ARCHIVIERT: Calculator Section (id="calculator")
// Enthielt: Range-Slider für Verkaufspreis, Drinks/Tag, Öffnungstage, Gramm/Drink
// Model-Tabs (single/recurring/annual) mit €/kg-Preisen
// Ergebnisse: Drinks/Monat, Matcha-Bedarf, Umsatzpotenzial, Kosten/Drink
// Formel-Erklärung (calc-method) und ROI-Placeholder

// ARCHIVIERT: B2B Pricing Cards (class="b2b-pricing")
// Enthielt: 3 Preiskarten mit €/kg (130€, 123,50€, 117€)
// Vertragsbedingungen (Mindestlaufzeit, Kündigungsfristen)
// → Preise bleiben in content.ts (B2B_PRICING) für späteres Portal

// ARCHIVIERT: Beispielrechnung (class="b2b-example")
// Enthielt: 3 kg/Monat Beispiel mit konkreten €/Monat-Beträgen
// Preisvorteil-Berechnung pro Monat und pro Jahr

// ARCHIVIERT: calc-summary im Lead-Formular
// Enthielt: Berechnungsergebnisse als Zusammenfassung im Formular
// Calculator-Felder (calculator_selling_price etc.) werden nicht mehr übermittelt

// TODO: MATCHA BUSINESS CALCULATOR V2
// Später ergänzen:
// - Milch / Pflanzendrink Kosten
// - Sirup / Zusatzkosten
// - Becher / Take-away-Kosten
// - sonstiger Wareneinsatz
// - Gesamtwareneinsatz pro Drink
// - Deckungsbeitrag pro Drink
// - Deckungsbeitragsmarge
// - monatlicher Deckungsbeitrag
// - Break-even Drinks
// - einmalige Investitionskosten
// - ROI
// - Jahresprojektion
// NICHT jetzt mit erfundenen Werten implementieren.

// TODO: CUSTOMER SUBSCRIPTIONS / B2B SUPPLY
// Später technisch implementieren:
// - aktive regelmäßige Belieferungen (Kunde, Menge, Lieferintervall, nächste Lieferung)
// - Preisplan, Vertragsbeginn, Mindestlaufzeit, Status
// - Menge anpassen, Zusatzbestellung, Pause, Kündigung
// - Rechnungsstatus, Versandstatus
// Aktuell nur Anfrage-Workflow. Kein echtes Subscription Backend.

// TODO: SUPPLIER REPLENISHMENT
// Später:
// - regelmäßige Lieferantenbestellungen
// - aktuelle Lagermenge, Sicherheitsbestand
// - erwarteter Kundenverbrauch aus aktiven B2B-Belieferungen
// - Nachbestellpunkt, Bestellmenge, Lieferzeit
// - Charge, MHD
// - Bestellung ausgelöst → unterwegs → eingelagert
// Langfristiges Ziel: Kunden-Belieferungen → Lagerprognose → Beschaffungsplanung

// TODO: B2C SUBSCRIPTIONS
// Subscription-Datenmodell:
// - subscription_id, customer_id, plan (flex | annual), status (active | paused | canceled)
// - billing_interval: monthly, next_billing_date, next_shipping_date
// - price_per_delivery, discount_percent
// - created_at, canceled_at, pause_start, pause_end

// Flex-Abo:
// - Monatlich kündbar, monatliche Lieferung + Abrechnung
// - Pausieren möglich (1–3 Monate)
// - Einzellieferung überspringen
// - Kein Mindestlaufzeit

// 12-Monats-Abo:
// - 12 Monate Laufzeit, monatliche Lieferung + Abrechnung
// - Kündigung zum Ende der Laufzeit
// - Pausieren innerhalb der Laufzeit (max. 2 Monate kumuliert)
// - Automatische Verlängerung um 1 Monat (Flex) nach Ablauf

// Customer Account:
// - Abo-Status einsehen
// - Nächste Lieferung / nächste Abrechnung
// - Abo pausieren / fortsetzen
// - Abo kündigen (Flex: sofort, Annual: zum Laufzeitende)
// - Lieferadresse ändern
// - Zahlungsmethode ändern
// Aktuell nur Pre-Launch Waitlist. Kein echtes Subscription Backend.
