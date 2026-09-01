"use client";
import { useState } from "react";
import Link from "next/link";
import type { LeadPayload } from "./content";
import { track } from "./analytics";

/* THE TWO ORDERING MODELS. One shape, two accents - the discount, the
   wording and the request handler are the ones that were already here.
   `mark` and `check` are single-path line drawings on a 24 grid; both
   are decorative, the labels beside them carry the meaning. */
const b2bModels=[
 {key:"flex",eyebrow:"FLEXIBEL",title:"Regelmäßige Belieferung",cta:"Konditionen anfragen",
  mark:"M3.6 7.4 12 3l8.4 4.4v9.2L12 21l-8.4-4.4V7.4ZM3.6 7.4 12 11.9l8.4-4.5M12 11.9V21M7.8 5.2l8.4 4.5",
  benefits:["5 % Preisvorteil gegenüber Einzelbestellung","Flexible monatliche Lieferung"]},
 {key:"plan",eyebrow:"PLANBAR",title:"12-Monats-Partnerschaft",cta:"Partnerschaft anfragen",
  mark:"M4 6.5h16v14H4zM4 11h16M8.5 3.5v4M15.5 3.5v4M8 15h2M14 15h2",
  benefits:["10 % Preisvorteil gegenüber Einzelbestellung","Planbare monatliche Belieferung"]},
];
/* THE B2B FLOW: four process steps and the route they end in, in ONE
   section. Every icon is a single path on a 24 grid, decorative, with
   the number and the title beside it carrying the meaning. */
const b2bFlowSteps:{n:string;title:string;body:[string,string];icon:string}[]=[
{n:"01",title:"Anfrage stellen",body:["Sag uns, was du brauchst.","Wir melden uns mit einem persönlichen Angebot."],
 icon:"M4 5.5h16v10h-8.4L7 19.5V15.5H4Z"},
{n:"02",title:"Modell wählen",body:["Einzelbestellung,","regelmäßige Belieferung oder 12-Monats-Partnerschaft."],
 icon:"M9 4.5H6.5a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V5.5a1 1 0 0 0-1-1H15M9 3h6v3H9zM8.5 11.5h7M8.5 15.5h7"},
{n:"03",title:"Lieferung erhalten",body:["Deine vereinbarte Menge wird","zuverlässig geliefert."],
 icon:"M3.6 7.4 12 3l8.4 4.4v9.2L12 21l-8.4-4.4V7.4ZM3.6 7.4 12 11.9l8.4-4.5M12 11.9V21"},
{n:"04",title:"Bedarf anpassen",body:["Zusätzliche Mengen können","bei Bedarf angefragt werden."],
 icon:"M4 8h9M17 8h3M4 16h3M11 16h9M15 5.5v5M7 13.5v5"},
];
/* SHIZUOKA -> GLOA -> DEIN CAFÉ. The middle node names the party that
   handles the order, not a warehouse location. */
const b2bFlowRoute:[string,string][]=[["SHIZUOKA","Herkunft"],["GLOA","Abwicklung"],["DEIN CAFÉ","Schnelle Nachbestellung"]];
/* THE FIVE SUPPORT MATERIALS. One row each: a line icon, its number, a
   title and a sentence. The "available at launch" note used to repeat
   under every one of them; it is one line at the foot of the section
   now. Icons are single paths on a 24 grid, decorative. */
const b2bSupport:{n:string;title:string;body:string;icon:string}[]=[
{n:"01",title:"REZEPT-GUIDES",body:"Standardisierte Rezepte für gleichbleibende Drinks.",
 icon:"M12 6.5S9.5 4.5 4 4.5v13c5.5 0 8 2 8 2s2.5-2 8-2v-13c-5.5 0-8 2-8 2ZM12 6.5v13"},
{n:"02",title:"BAR-SOPS",body:"Klare Abläufe für dein Team.",
 icon:"M9 4.5H6.5a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V5.5a1 1 0 0 0-1-1H15M9 3h6v3H9zM8.5 12.5l1.4 1.4 2.6-2.6M8.5 17l1.4 1.4 2.6-2.6"},
{n:"03",title:"TEAM-TRAINING",body:"Kompakte Schulungsmaterialien.",
 icon:"M2.5 9 12 4.5 21.5 9 12 13.5 2.5 9ZM6.5 11v5c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5v-5"},
{n:"04",title:"MENÜ-SUPPORT",body:"Hilfe bei der Integration in deine Karte.",
 icon:"M6 3.5h12a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1ZM8.5 8h7M8.5 12h7M8.5 16h4"},
{n:"05",title:"SOCIAL TOOLKIT",body:"Content für deinen GLOA Launch.",
 icon:"M8 2.5h8a1 1 0 0 1 1 1v17a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1ZM10.5 5h3M11 18.5h2"},
];
export function BusinessCalculator(){
 const [intent,setIntent]=useState<"wholesale"|"sample">(() => {
   if (typeof window === 'undefined') return "wholesale";
   return new URLSearchParams(window.location.search).get("intent") === "sample" ? "sample" : "wholesale";
 }),[success,setSuccess]=useState(false);
 const choose=(i:"wholesale"|"sample")=>{setIntent(i);track(i==="sample"?"sample_request_start":"wholesale_request_start");document.getElementById("lead")?.scrollIntoView({behavior:"smooth"})};
 const submit=(e:React.FormEvent<HTMLFormElement>)=>{e.preventDefault();const f=new FormData(e.currentTarget);const payload:LeadPayload={lead_type:intent,contact_name:String(f.get("contact_name")),business_name:String(f.get("business_name")),email:String(f.get("email")),city:String(f.get("city")),business_type:String(f.get("business_type")),locations:String(f.get("locations")),pricing_interest:String(f.get("pricing_interest")||""),estimated_monthly_demand:String(f.get("demand")||""),current_supplier:String(f.get("supplier")||""),message:String(f.get("message")||""),created_at:new Date().toISOString()};window.dispatchEvent(new CustomEvent("gloa:b2b-lead",{detail:payload}));track(intent==="sample"?"sample_request_submit":"wholesale_request_submit");setSuccess(true)};
 return <><section className="b2b-compare"><div className="b2b-compare-inner home-rail"><div className="b2b-compare-intro"><p className="eyebrow b2b-compare-eyebrow">FLEXIBEL &amp; PLANBAR</p><h2 className="b2b-compare-headline"><span className="b2b-compare-line">Flexibel bestellen</span><i className="b2b-compare-line b2b-compare-line-accent">oder langfristig profitieren.</i></h2><p className="b2b-compare-note">Je länger wir deinen Bedarf planen können, desto größer ist dein Preisvorteil. Preise und Konditionen erhältst du auf Anfrage.</p></div>{b2bModels.map(m=><div className={`b2b-model b2b-model-${m.key}`} key={m.key}><span className="b2b-model-mark"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={m.mark}/></svg></span><p className="eyebrow b2b-model-eyebrow">{m.eyebrow}</p><h3 className="b2b-model-title">{m.title}</h3><span className="b2b-model-rule" aria-hidden="true"/><ul className="b2b-model-benefits">{m.benefits.map(b=><li key={b}><svg className="b2b-model-check" viewBox="0 0 20 20" width="19" height="19" fill="none" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="9.25" stroke="currentColor" strokeOpacity=".55" strokeWidth="1"/><path d="m6 10.3 2.7 2.7 5.4-5.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg><span>{b}</span></li>)}</ul><button className="cta b2b-model-cta" onClick={()=>choose("wholesale")}>{m.cta} <span aria-hidden="true">→</span></button></div>)}</div></section>

<section className="b2b-portal-hint"><div className="b2b-portal-inner home-rail"><div className="b2b-portal-copy"><span className="b2b-portal-rule" aria-hidden="true"/><p className="eyebrow b2b-portal-eyebrow">B2B KUNDENPORTAL</p><h2 className="b2b-portal-headline"><span className="b2b-portal-line">Preise, Konditionen</span><i className="b2b-portal-line b2b-portal-line-accent">und dein Dashboard.</i></h2><p className="b2b-portal-lead">Preise, individuelle Konditionen und dein B2B-Dashboard.</p><p className="b2b-portal-sub">Alles gebündelt in deinem GLOA Geschäftskonto.</p><div className="b2b-portal-hint-actions"><Link className="cta b2b-portal-cta" href="/account?type=business">Geschäftskonto erstellen</Link><button className="cta b2b-portal-cta b2b-portal-cta-secondary" onClick={()=>choose("wholesale")}>B2B-Anfrage starten</button></div></div></div></section>

<section className="b2b-flow"><div className="b2b-flow-inner home-rail"><div className="b2b-flow-top"><div className="b2b-flow-intro"><p className="eyebrow b2b-flow-eyebrow">SO FUNKTIONIERT&apos;S</p><h2 className="b2b-flow-headline"><span className="b2b-flow-line">Matcha, bevor</span><i className="b2b-flow-line b2b-flow-line-accent">er ausgeht.</i></h2><p className="b2b-flow-support">In vier einfachen Schritten zu deinem Matcha,<br/>passend zu deinem Bedarf.</p></div><ol className="b2b-flow-steps">{b2bFlowSteps.map((s,i)=><li className="b2b-flow-step" key={s.n}>{i>0&&<span className="b2b-flow-step-arrow" aria-hidden="true">→</span>}<span className="b2b-flow-step-mark"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={s.icon}/></svg></span><span className="b2b-flow-step-number">{s.n}</span><h3 className="b2b-flow-step-title">{s.title}</h3><p className="b2b-flow-step-body">{s.body[0]}<br/>{s.body[1]}</p></li>)}</ol></div><span className="b2b-flow-divider" aria-hidden="true"/><div className="b2b-flow-route"><p className="eyebrow b2b-flow-route-eyebrow">AUS SHIZUOKA.<br/>FÜR DEINE KARTE.</p><div className="b2b-flow-path">{b2bFlowRoute.map(([main,sub],i)=><div className="b2b-flow-node" key={main}>{i>0&&<span className="b2b-flow-node-arrow" aria-hidden="true">→</span>}<span className="b2b-flow-node-main">{main}</span><span className="b2b-flow-node-sub">{sub}</span></div>)}</div><span className="b2b-flow-note-rule" aria-hidden="true"/><p className="b2b-flow-note">Lieferzeit und Verfügbarkeit werden bei Bestellung bestätigt.</p></div></div></section>

<section className="b2b-support"><div className="b2b-support-rail home-rail"><div className="b2b-support-grid"><div className="b2b-support-intro"><p className="eyebrow b2b-support-eyebrow">MEHR ALS MATCHA</p><h2 className="b2b-support-headline"><span className="b2b-support-line">Mehr als Matcha.</span><i className="b2b-support-line b2b-support-line-accent">Alles für deine Karte.</i></h2><p className="b2b-support-body">Von Rezepten bis Team-Training: Wir helfen dir dabei, GLOA sauber in deinen Alltag und deine Karte zu integrieren.</p></div><span className="b2b-support-seam" aria-hidden="true"/>{b2bSupport.map(s=><article className="b2b-support-item" key={s.n}><span className="b2b-support-mark"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={s.icon}/></svg></span><span className="b2b-support-number">{s.n}</span><h3 className="b2b-support-title">{s.title}</h3><p className="b2b-support-text">{s.body}</p></article>)}</div><span className="b2b-support-rule" aria-hidden="true"/><p className="b2b-support-note">ALLE SUPPORT-MATERIALIEN AB LAUNCH VERFÜGBAR.</p></div></section>

<section className="sample-callout"><div><p className="eyebrow">PROBIER&apos;S ERSTMAL.</p><h2>Test it with<br/>your team.</h2></div><div><p>Bestell ein Sample, bevor du deine erste größere Bestellung aufgibst. Konditionen klären wir individuell.</p><button className="cta" onClick={()=>choose("sample")}>Sample anfragen</button></div></section>

<section id="lead" className="lead-section">{success?<div className="form-success"><p className="eyebrow">GLOA FOR BUSINESS</p><h2>{intent==="sample"?"Deine Sample-Anfrage ist drin.":"Danke. Wir melden uns."}</h2><p>Wir haben deine Anfrage erhalten und melden uns mit den nächsten Schritten.</p></div>:<form className="lead-form" onSubmit={submit}><p className="eyebrow wide">GLOA FOR BUSINESS</p><h2>Let&apos;s talk<br/><i>Matcha.</i></h2><div className="intent-tabs"><button type="button" className={intent==="wholesale"?"active":""} onClick={()=>setIntent("wholesale")}>B2B-Anfrage</button><button type="button" className={intent==="sample"?"active":""} onClick={()=>setIntent("sample")}>Sample</button></div><label>Ansprechpartner/in*<input required name="contact_name"/></label><label>Unternehmen / Café*<input required name="business_name"/></label><label>E-Mail*<input required type="email" name="email"/></label><label>Stadt*<input required name="city"/></label><label>Unternehmenstyp*<select required name="business_type" defaultValue=""><option value="" disabled>Bitte auswählen</option>{["Eigenständiges Café","Café-Gruppe","Restaurant","Hotel","Büro / Office","Fitness / Pilates / Wellness","Einzelhandel","Sonstiges"].map(x=><option key={x}>{x}</option>)}</select></label><label>Anzahl Standorte*<input required min="1" type="number" name="locations"/></label><label>Interesse an<select name="pricing_interest"><option>Noch nicht sicher</option><option>Einzelbestellung</option><option>Regelmäßige Belieferung · 5 %</option><option>12-Monats-Partnerschaft · 10 %</option><option>Sample</option></select></label><label>Geplanter monatlicher Bedarf<select name="demand"><option>Noch nicht sicher</option><option>Unter 1 kg</option><option>1-2 kg</option><option>3-5 kg</option><option>6-10 kg</option><option>10+ kg</option></select></label><label>Aktueller Matcha-Lieferant<input name="supplier"/></label><label className="wide">Nachricht<textarea name="message"/></label><label className="consent wide"><input required type="checkbox"/> Ich stimme zu, dass GLOA meine Angaben zur Bearbeitung meiner Anfrage verwenden darf.</label><button className="cta cream wide">{intent==="sample"?"Sample-Anfrage senden":"B2B-Konditionen anfragen"}</button></form>}</section></>
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
// → B2B-Preise kommen aus Supabase (b2b_offer_models + b2b_product_sizes)

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
