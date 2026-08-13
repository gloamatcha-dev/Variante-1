"use client";
import { useEffect, useMemo, useState } from "react";
import type { LeadPayload } from "./content";
import { B2B_PRICING } from "./content";
import { track } from "./analytics";

const euro=new Intl.NumberFormat("de-DE",{style:"currency",currency:"EUR",maximumFractionDigits:0});
const euroFull=new Intl.NumberFormat("de-DE",{style:"currency",currency:"EUR",minimumFractionDigits:2,maximumFractionDigits:2});
const number=new Intl.NumberFormat("de-DE");
const fmtPrice=(p:number)=>p%1===0?`${p}`:`${p.toLocaleString("de-DE",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
function Range({label,min,max,step,value,suffix,onChange}:{label:string;min:number;max:number;step:number;value:number;suffix:string;onChange:(n:number)=>void}){return <label className="range"><span>{label}<b>{value.toLocaleString("de-DE")}{suffix}</b></span><input type="range" min={min} max={max} step={step} value={value} onChange={e=>onChange(Number(e.target.value))}/><small>{min}{suffix} <i>{max}{suffix}</i></small></label>}
type Model="single"|"recurring"|"annual";
export function BusinessCalculator(){
 const [price,setPrice]=useState(6.5),[drinks,setDrinks]=useState(30),[days,setDays]=useState(26),[grams,setGrams]=useState(3),[model,setModel]=useState<Model>("single"),[intent,setIntent]=useState<"wholesale"|"sample">("wholesale"),[success,setSuccess]=useState(false),[started,setStarted]=useState(false);
 const kgPrice=B2B_PRICING[model].price;
 const calc=useMemo(()=>{const monthly=drinks*days,demand=monthly*grams/1000,revenue=monthly*price,costPerDrink=kgPrice/1000*grams,supplyCost=demand*kgPrice,extra=10*days*price;return{monthly,demand,revenue,annual:revenue*12,costPerDrink,supplyCost,extra}},[price,drinks,days,grams,kgPrice]);
 const example=useMemo(()=>{const kg=3,s=kg*B2B_PRICING.single.price,r=kg*B2B_PRICING.recurring.price,a=kg*B2B_PRICING.annual.price;return{single:s,recurring:r,annual:a,rMonth:s-r,rYear:(s-r)*12,aMonth:s-a,aYear:(s-a)*12}},[]);
 useEffect(()=>{if(new URLSearchParams(window.location.search).get("intent")==="sample")setIntent("sample")},[]);
 const update=(fn:(n:number)=>void)=>(n:number)=>{if(!started){track("calculator_start");setStarted(true)}fn(n)};
 const choose=(i:"wholesale"|"sample")=>{setIntent(i);track(i==="sample"?"sample_request_start":"wholesale_request_start");document.getElementById("lead")?.scrollIntoView({behavior:"smooth"})};
 const submit=(e:React.FormEvent<HTMLFormElement>)=>{e.preventDefault();const f=new FormData(e.currentTarget);const payload:LeadPayload={lead_type:intent,contact_name:String(f.get("contact_name")),business_name:String(f.get("business_name")),email:String(f.get("email")),city:String(f.get("city")),business_type:String(f.get("business_type")),locations:String(f.get("locations")),pricing_interest:String(f.get("pricing_interest")||""),estimated_monthly_demand:String(f.get("demand")||""),current_supplier:String(f.get("supplier")||""),message:String(f.get("message")||""),calculator_selling_price:price,calculator_drinks_per_day:drinks,calculator_opening_days:days,calculator_grams_per_drink:grams,calculator_monthly_drinks:calc.monthly,calculator_monthly_demand:calc.demand,calculator_monthly_revenue:calc.revenue,created_at:new Date().toISOString()};window.dispatchEvent(new CustomEvent("gloa:b2b-lead",{detail:payload}));track(intent==="sample"?"sample_request_submit":"wholesale_request_submit");setSuccess(true)};
 return <><section id="calculator" className="calculator"><div className="calc-intro"><p className="eyebrow">UMSATZPOTENZIAL</p><h2>Was bringt Matcha<br/>auf deiner Karte?</h2><p>Berechne dein mögliches Verkaufsvolumen, deinen Matcha-Bedarf und das daraus entstehende Umsatzpotenzial.</p></div><div className="calc-panel"><div className="ranges"><Range label="Verkaufspreis pro Drink" min={4} max={9} step={.1} value={price} suffix=" €" onChange={update(setPrice)}/><Range label="Matcha-Drinks pro Tag" min={5} max={100} step={1} value={drinks} suffix="" onChange={update(setDrinks)}/><Range label="Öffnungstage pro Monat" min={15} max={31} step={1} value={days} suffix="" onChange={update(setDays)}/><Range label="Matcha pro Drink" min={2} max={5} step={.5} value={grams} suffix=" g" onChange={update(setGrams)}/><div className="model-tabs"><p className="eyebrow">BEZUGSMODELL</p>{(["single","recurring","annual"] as Model[]).map(m=><button key={m} type="button" className={model===m?"active":""} onClick={()=>setModel(m)}>{B2B_PRICING[m].label}<span>{fmtPrice(B2B_PRICING[m].price)} €/kg</span></button>)}</div></div><div className="results" aria-live="polite">{[["Drinks / Monat",`${number.format(calc.monthly)} Drinks`],["Matcha-Bedarf / Monat",`${calc.demand.toLocaleString("de-DE",{minimumFractionDigits:2,maximumFractionDigits:2})} kg`],["Umsatzpotenzial / Monat",euro.format(calc.revenue)],["Matcha-Kosten / Drink",euroFull.format(calc.costPerDrink)],["Matcha-Wareneinsatz / Monat",euroFull.format(calc.supplyCost)],["Potenzieller Umsatz / Jahr",euro.format(calc.annual)]].map(([l,v])=><div key={l}><span>{l}</span><strong>{v}</strong></div>)}<div className="scenario"><span>+10 DRINKS PRO TAG?</span><strong>+{euro.format(calc.extra)} potenzieller Monatsumsatz</strong></div><button onClick={()=>{track("calculator_complete");choose("wholesale")}} className="cta cream">B2B-Konditionen anfragen</button><small>Der Rechner zeigt Umsatzpotenzial und Matcha-Wareneinsatz. Weitere Zutaten, Personal- und Betriebskosten sind nicht berücksichtigt.</small></div></div><div className="calc-method"><p className="eyebrow">SO RECHNEN WIR</p><div><div><span>DRINKS PRO MONAT</span><strong>Drinks pro Tag × Öffnungstage</strong></div><div><span>MATCHA-BEDARF</span><strong>Drinks pro Monat × Matcha pro Drink</strong></div><div><span>UMSATZPOTENZIAL</span><strong>Drinks pro Monat × Verkaufspreis pro Drink</strong></div><div><span>MATCHA-KOSTEN / DRINK</span><strong>Kilopreis ÷ 1.000 × Gramm pro Drink</strong></div><div><span>WARENEINSATZ / MONAT</span><strong>Matcha-Bedarf in kg × Kilopreis</strong></div></div><small>Keine Gewinn- oder Margenberechnung. Weitere Kosten (Milch, Becher, Personal) sind nicht berücksichtigt.</small></div><div className="calc-roi-placeholder"><div><span>ROI & MARGE</span><strong>○ IN VORBEREITUNG</strong></div><p>Sobald alle relevanten Kostenparameter definiert sind, erweitern wir den Rechner um Deckungsbeitrag, Marge, Break-even und ROI.</p></div></section>

<div className="stack-pair"><section className="b2b-pricing"><p className="eyebrow">B2B · BELIEFERUNG</p><h2>So viel Flexibilität,<br/><i>wie dein Café braucht.</i></h2><p className="b2b-pricing-lead">Einmal bestellen oder regelmäßig beliefert werden. Bei planbarer monatlicher Abnahme wird dein Kilopreis günstiger.</p><div className="b2b-pricing-grid"><div className="b2b-pricing-card"><p className="eyebrow">EINZELBESTELLUNG</p><div className="b2b-pricing-price"><b>{fmtPrice(B2B_PRICING.single.price)} €</b><span>/ KG</span></div><p className="b2b-pricing-desc">Für flexible Bestellungen nach Bedarf.</p><ul className="b2b-pricing-details"><li>Keine Vertragsbindung</li><li>Bestellung nach Bedarf</li><li>500 g & 1 kg Gastroformate</li></ul><button className="cta" onClick={()=>choose("wholesale")}>B2B anfragen</button></div><div className="b2b-pricing-card"><p className="eyebrow">REGELMÄSSIGE BELIEFERUNG</p><span className="b2b-pricing-discount">5 % PREISVORTEIL</span><div className="b2b-pricing-price"><b>{fmtPrice(B2B_PRICING.recurring.price)} €</b><span>/ KG</span></div><p className="b2b-pricing-desc">Für Cafés mit regelmäßigem Matcha-Bedarf.</p><ul className="b2b-pricing-details"><li>Ab 3 kg / Monat</li><li>3 Monate Mindestlaufzeit</li><li>Danach monatlich kündbar</li><li>Monatliche Lieferung</li><li>Monatliche Abrechnung</li><li>Menge für zukünftige Lieferungen anpassbar</li></ul><button className="cta" onClick={()=>choose("wholesale")}>Regelmäßige Belieferung anfragen</button></div><div className="b2b-pricing-card highlight"><p className="eyebrow">12-MONATS-PARTNERSCHAFT</p><span className="b2b-pricing-discount">10 % PREISVORTEIL</span><div className="b2b-pricing-price"><b>{fmtPrice(B2B_PRICING.annual.price)} €</b><span>/ KG</span></div><p className="b2b-pricing-desc">Für Cafés mit dauerhaft planbarem Matcha-Bedarf.</p><ul className="b2b-pricing-details"><li>Ab 3 kg / Monat</li><li>12 Monate Mindestlaufzeit</li><li>Monatliche Lieferung</li><li>Monatliche Abrechnung</li><li>Vereinbarte Mindestabnahme bleibt bestehen</li><li>Zusätzliche Mengen jederzeit anfragbar</li></ul><button className="cta cream" onClick={()=>choose("wholesale")}>Partnerschaft anfragen</button></div></div></section>

<section className="b2b-example"><p className="eyebrow">BEISPIEL · 3 KG PRO MONAT</p><div className="b2b-example-grid"><div className="b2b-example-card"><span>EINZELBESTELLUNG</span><strong>{euroFull.format(example.single)} / Monat</strong></div><div className="b2b-example-card"><span>REGELMÄSSIGE BELIEFERUNG</span><strong>{euroFull.format(example.recurring)} / Monat</strong><small>5 % Preisvorteil · {euroFull.format(example.rMonth)} weniger pro Monat · {euroFull.format(example.rYear)} Preisvorteil pro Jahr gegenüber Einzelbestellung</small></div><div className="b2b-example-card"><span>12-MONATS-PARTNERSCHAFT</span><strong>{euroFull.format(example.annual)} / Monat</strong><small>10 % Preisvorteil · {euroFull.format(example.aMonth)} weniger pro Monat · {euroFull.format(example.aYear)} Preisvorteil pro Jahr gegenüber Einzelbestellung</small></div></div></section></div>

<section className="b2b-steps"><p className="eyebrow">HOW IT WORKS</p><h2>Matcha, bevor<br/><i>er ausgeht.</i></h2><div className="b2b-steps-grid"><article><span>01</span><h3>Menge festlegen</h3><p>Du bestimmst deinen geplanten monatlichen Bedarf.</p></article><article><span>02</span><h3>Modell wählen</h3><p>Regelmäßige Belieferung oder 12-Monats-Partnerschaft.</p></article><article><span>03</span><h3>Monatlich geliefert</h3><p>Deine vereinbarte Menge wird regelmäßig geliefert.</p></article><article><span>04</span><h3>Bedarf anpassen</h3><p>Zusätzliche Mengen können bei Bedarf angefragt werden.</p></article></div></section>

<section className="b2b-compare"><div className="b2b-compare-grid"><div className="b2b-compare-card"><p className="eyebrow">FLEXIBEL</p><h3>Regelmäßige Belieferung</h3><ul><li>5 % Preisvorteil</li><li>3 Monate Mindestlaufzeit</li><li>Danach monatlich kündbar</li></ul></div><div className="b2b-compare-card"><p className="eyebrow">PLANBAR</p><h3>12-Monats-Partnerschaft</h3><ul><li>10 % Preisvorteil</li><li>12 Monate Mindestlaufzeit</li><li>Monatliche Lieferung und Abrechnung</li></ul></div></div><p className="b2b-compare-note">Je länger wir deinen Bedarf planen können, desto größer ist dein Preisvorteil.</p><small className="b2b-compare-micro">12 Monate Laufzeit. Lieferung und Abrechnung erfolgen monatlich.</small></section>

<div className="stack-pair"><section className="supply"><p className="eyebrow">AUS JAPAN. LAGER IN DEUTSCHLAND.</p><div className="supply-path"><strong>SHIZUOKA<small>Origin</small></strong><i>→</i><strong>DEUTSCHLAND<small>Lokaler Bestand</small></strong><i>→</i><strong>DEIN CAFÉ<small>Schnelle Nachbestellung</small></strong></div><p>Lieferzeit und Verfügbarkeit werden bei Bestellung bestätigt.</p></section>

<section className="business-support"><p className="eyebrow">MEHR ALS MATCHA</p><h2>Wir helfen dir,<br/><i>Matcha auf die Karte zu bringen.</i></h2><div>{[["REZEPT-GUIDES","Standardisierte Rezepte für gleichbleibende Drinks."],["BAR-SOPs","Klare Abläufe für dein Team."],["TEAM-TRAINING","Kompakte Schulungsmaterialien."],["MENÜ-SUPPORT","Hilfe bei der Integration in deine Karte."],["SOCIAL TOOLKIT","Fertiger Content für deinen Launch."]].map(([a,b])=><article key={a}><h3>{a}</h3><p>{b}</p><small>Verfügbar ab Launch</small></article>)}</div></section></div>

<section className="sample-callout"><div><p className="eyebrow">PROBIER'S ERSTMAL.</p><h2>Test it with<br/>your team.</h2></div><div><p>Bestell ein Sample, bevor du deine erste größere Bestellung aufgibst. Konditionen klären wir individuell.</p><button className="cta" onClick={()=>choose("sample")}>Sample anfragen</button></div></section>

<section id="lead" className="lead-section">{success?<div className="form-success"><p className="eyebrow">GLOA FOR BUSINESS</p><h2>{intent==="sample"?"Deine Sample-Anfrage ist drin.":"Danke. Wir melden uns."}</h2><p>Wir haben deine Anfrage erhalten und melden uns mit den nächsten Schritten.</p></div>:<form className="lead-form" onSubmit={submit}><p className="eyebrow wide">GLOA FOR BUSINESS</p><h2>Let's talk<br/><i>Matcha.</i></h2><div className="intent-tabs"><button type="button" className={intent==="wholesale"?"active":""} onClick={()=>setIntent("wholesale")}>B2B-Anfrage</button><button type="button" className={intent==="sample"?"active":""} onClick={()=>setIntent("sample")}>Sample</button></div><label>Ansprechpartner/in*<input required name="contact_name"/></label><label>Unternehmen / Café*<input required name="business_name"/></label><label>E-Mail*<input required type="email" name="email"/></label><label>Stadt*<input required name="city"/></label><label>Unternehmenstyp*<select required name="business_type" defaultValue=""><option value="" disabled>Bitte auswählen</option>{["Eigenständiges Café","Café-Gruppe","Restaurant","Hotel","Büro / Office","Fitness / Pilates / Wellness","Einzelhandel","Sonstiges"].map(x=><option key={x}>{x}</option>)}</select></label><label>Anzahl Standorte*<input required min="1" type="number" name="locations"/></label><label>Interesse an<select name="pricing_interest"><option>Noch nicht sicher</option><option>Einzelbestellung</option><option>Regelmäßige Belieferung · 5 %</option><option>12-Monats-Partnerschaft · 10 %</option><option>Sample</option></select></label><label>Geplanter monatlicher Bedarf<select name="demand"><option>Noch nicht sicher</option><option>Unter 1 kg</option><option>1–2 kg</option><option>3–5 kg</option><option>6–10 kg</option><option>10+ kg</option></select></label><label>Aktueller Matcha-Lieferant<input name="supplier"/></label><label className="wide">Nachricht<textarea name="message"/></label><div className="calc-summary wide">Deine Berechnung: {calc.monthly} Drinks/Monat · {calc.demand.toFixed(2)} kg Bedarf · {euro.format(calc.revenue)} Umsatzpotenzial · {euroFull.format(calc.costPerDrink)} Matcha-Kosten/Drink</div><label className="consent wide"><input required type="checkbox"/> Ich stimme zu, dass GLOA meine Angaben zur Bearbeitung meiner Anfrage verwenden darf.</label><button className="cta wide">{intent==="sample"?"Sample-Anfrage senden":"B2B-Konditionen anfragen"}</button></form>}</section></>
}

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
