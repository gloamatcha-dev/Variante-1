"use client";

import {useEffect, useRef, useState, type FormEvent} from "react";
import {portalRequest} from "./AdminPortalShared";

type Catalog = {id:string;sku:string;label:string;price_gross_cents:number};
type Order = {id:string;order_number:string;status:string;total_gross_cents:number;received_cents:number;
  customer_snapshot:{company:string};manual_b2b:{reference:string;payment:string}};
type Data = {canWrite:boolean;orders:Order[];customers:{user_id:string;company_name:string}[];catalog:Catalog[]};
type DeliveryData = {items:{id:string;sku:string;product_name:string;quantity:number}[];
  deliveries:{id:string;order_item_id:string;occurred_on:string;units:number;reference:string}[]};
type Customer = Data["customers"][number];
type OfferReference = {offer_id:string;offer_version:number;checkout_claimed:boolean;agreement_id:string|null;
  contract_status:string|null;started_at:string|null;ended_at:string|null;linked:boolean;
  terms:{planType?:string;deliveryIntervalMonths?:number;deliveryCount?:number;packNetCents?:number;
    charges?:{grossCents:number}[]}};
const euro = new Intl.NumberFormat("de-DE",{style:"currency",currency:"EUR"});
function decimalCents(value:string) {
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(value)) return NaN;
  const [units,cents=""] = value.split(/[.,]/);
  return Number(units)*100+Number(cents.padEnd(2,"0"));
}

const states:Record<string,string> = {pending:"Entwurf",confirmed:"Bestätigt",cancelled:"Storniert"};

export function AdminManualB2bOrders() {
  const [data,setData] = useState<Data|null>(null);
  const [open,setOpen] = useState(false);
  const [positions,setPositions] = useState([0]);
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState("");
  const operation = useRef<string|null>(null);
  const mutation = useRef(false);
  const paymentOperation = useRef<string|null>(null);
  const [paymentFor,setPaymentFor] = useState<string|null>(null);
  const [invoiceFor,setInvoiceFor] = useState<string|null>(null);
  const [customerEmail,setCustomerEmail] = useState("");
  const [selectedCustomer,setSelectedCustomer] = useState("");
  const [foundCustomer,setFoundCustomer] = useState<Customer|null>(null);
  const [offerFor,setOfferFor] = useState<string|null>(null);
  const [offers,setOffers] = useState<OfferReference[]>([]);
  const [deliveryFor,setDeliveryFor] = useState<string|null>(null);
  const [deliveryData,setDeliveryData] = useState<DeliveryData|null>(null);
  const deliveryOperation=useRef<string|null>(null);
  const load = async () => setData(await portalRequest("/api/admin/b2b/orders",{action:"list"}) as Data);
  useEffect(()=>{
    void portalRequest("/api/admin/b2b/orders",{action:"list"})
      .then(result=>setData(result as Data)).catch(error=>setNotice(error.message));
  },[]);
  async function save(action:string,id:string,fields:Record<string,unknown>={}) {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setNotice("");
    try {
      await portalRequest("/api/admin/b2b/orders",{action,id,...fields});
      if(action==="create"){operation.current=null;setOpen(false);setPositions([0]);setSelectedCustomer("");}
      if(action==="record_payment"){paymentOperation.current=null;setPaymentFor(null);}
      if(action==="record_delivery"){deliveryOperation.current=null;await loadDeliveries(id);}
      await load();
      setNotice("Auftrag gespeichert.");
    } catch(error) { setNotice(error instanceof Error ? error.message : "Auftrag konnte nicht gespeichert werden."); }
    finally {mutation.current=false;setBusy(false);}
  }
  async function findCustomer() {
    setBusy(true);setNotice("");
    try {
      const result=await portalRequest("/api/admin/b2b/orders",{action:"find_customer",email:customerEmail});
      const customer=result.customer as Customer;
      setFoundCustomer(customer);setSelectedCustomer(customer.user_id);
    }catch(error){setNotice(error instanceof Error?error.message:"Geschäftskonto nicht verfügbar.");}
    finally{setBusy(false);}
  }
  async function loadOffers(id:string,reference?:OfferReference) {
    if(mutation.current)return;
    mutation.current=true;setBusy(true);setNotice("");
    if(!reference){setOffers([]);setOfferFor(id);}
    try {
      const result=await portalRequest("/api/admin/b2b/orders",reference
        ? {action:"link_offer_reference",id,offerId:reference.offer_id,version:reference.offer_version,confirmed:true}
        : {action:"offer_context",id});
      setOffers(result.references as OfferReference[]);
    }catch(error){setNotice(error instanceof Error?error.message:"Vertragsreferenzen nicht verfügbar.");}
    finally{mutation.current=false;setBusy(false);}
  }
  async function loadDeliveries(id:string) {
    const result=await portalRequest("/api/admin/b2b/orders",{action:"deliveries",id});
    setDeliveryData(result as DeliveryData);
  }
  async function toggleDeliveries(id:string) {
    if(deliveryFor===id){setDeliveryFor(null);return;}
    setDeliveryFor(id);setDeliveryData(null);deliveryOperation.current=null;setBusy(true);
    try {await loadDeliveries(id);}
    catch(error){setNotice(error instanceof Error?error.message:"Lieferungen nicht verf?gbar.");}
    finally{setBusy(false);}
  }
  async function downloadDelivery(id:string,deliveryId:string) {
    try {
      const response=await fetch("/api/admin/b2b/orders",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action:"delivery_pdf",id,deliveryId})});
      if(!response.ok) throw new Error("Lieferschein nicht verf?gbar.");
      const url=URL.createObjectURL(await response.blob());
      const link=document.createElement("a");link.href=url;link.download="Lieferschein.pdf";link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){setNotice(error instanceof Error?error.message:"Lieferschein nicht verf?gbar.");}
  }
  async function invoiceDocument(event:FormEvent<HTMLFormElement>,id:string) {
    event.preventDefault();
    if(mutation.current)return;
    const fields=new FormData(event.currentTarget);
    mutation.current=true;setBusy(true);setNotice("");
    try {
      const mode=fields.get("mode");
      const response=await fetch("/api/admin/b2b/orders",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action:"invoice",id,mode,supplyOn:fields.get("supplyOn"),confirmed:fields.get("confirmed")==="yes"})});
      if(!response.ok) throw new Error((await response.json()).error);
      const pdf=mode==="issue"||mode==="correction"
        ? await fetch("/api/admin/documents",{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({action:"download",id:(await response.json()).id})})
        : response;
      if(!pdf.ok) throw new Error("PDF nicht verf?gbar. Erneut mit demselben Leistungsdatum abrufen.");
      const url=URL.createObjectURL(await pdf.blob());
      const link=document.createElement("a");link.href=url;link.download=String(mode)+".pdf";link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(error) {setNotice(error instanceof Error?error.message:"Dokument nicht verf?gbar.");}
    finally {mutation.current=false;setBusy(false);}
  }
  function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const get = (key:string)=>String(values.get(key)??"");
    const amount = (key:string)=>decimalCents(get(key));
    const address = (prefix:string)=>({street:get(prefix+"Street"),postalCode:get(prefix+"Zip"),
      city:get(prefix+"City"),country:"DE"});
    operation.current ??= crypto.randomUUID();
    void save("create",operation.current,{
      customer:get("customer"),contact:get("contact"),email:get("email"),reference:get("reference"),
      orderedOn:get("orderedOn"),source:get("source"),payment:get("payment"),delivery:get("delivery"),note:get("note"),
      billing:address("billing"),shipping:address("shipping"),shippingGross:amount("shippingGross"),
      lines:positions.map(key=>({variant:get("variant"+key),quantity:Number(get("quantity"+key)),
        unit:get("unit"+key)===""?undefined:amount("unit"+key)}))
    });
  }
  return <section className="admin-data-card" aria-label="Manuelle B2B-Bestellungen">
    <h3>Bestellungen</h3>
    {notice&&<p role="status">{notice}</p>}
    {data?.canWrite&&<button type="button" disabled={busy} onClick={()=>setOpen(!open)}>
      {open?"Formular schließen":"+ Manuelle Bestellung erstellen"}
    </button>}
    {open&&data?.canWrite&&<form className="portal-form" onSubmit={submit}>
      <fieldset disabled={busy}>
        <p>Manueller Auftrag für Deutschland in EUR. Ohne Bestandszusage. Der Entwurf erfasst keinen Zahlungseingang und veranlasst keine Lieferung.</p>
        <label>Geschäftskunde<select name="customer" required value={selectedCustomer} onChange={event=>setSelectedCustomer(event.target.value)}>
          <option value="">Konto auswählen</option>
          {data.customers.map(customer=><option key={customer.user_id} value={customer.user_id}>{customer.company_name}</option>)}
          {foundCustomer&&!data.customers.some(customer=>customer.user_id===foundCustomer.user_id)&&
            <option value={foundCustomer.user_id}>{foundCustomer.company_name}</option>}
        </select></label>
        <p>Die vertretungsberechtigte Person registriert das Geschäftskonto selbst und bestätigt ihre E-Mail-Adresse.</p>
        <p><a href="/account?type=business" target="_blank" rel="noopener noreferrer">Bestehende Geschäftsregistrierung öffnen</a></p>
        <label>Registrierte E-Mail-Adresse für die Kontosuche<input type="email" maxLength={254} value={customerEmail}
          onChange={event=>setCustomerEmail(event.target.value)}/></label>
        <button type="button" disabled={!customerEmail.trim()} onClick={()=>void findCustomer()}>Bestätigtes Konto übernehmen</button>
        <label>Ansprechpartner<input name="contact" maxLength={120} required /></label>
        <label>E-Mail<input name="email" type="email" maxLength={254} required /></label>
        <label>Bestelldatum<input name="orderedOn" type="date" required /></label>
        <label>Kundenreferenz<input name="reference" maxLength={120} required /></label>
        <label>Bestellquelle<select name="source">
          <option value="email">E-Mail</option><option value="phone">Telefon</option>
          <option value="in_person">Persönlich</option><option value="other">Sonstige</option>
        </select></label>
        <label>Vorgesehene Zahlungsart<select name="payment"><option value="bank">Banküberweisung</option>
          <option value="cash">Barzahlung</option></select></label>
        <label>Vorgesehene Lieferart<select name="delivery"><option value="personal">Persönliche Lieferung</option>
          <option value="pickup">Abholung</option><option value="carrier">Transportdienstleister</option></select></label>
        {[["billing","Rechnungsadresse"],["shipping","Lieferadresse"]].map(([prefix,title])=>
          <fieldset key={prefix}><legend>{title}</legend>
            <label>Straße und Hausnummer<input name={prefix+"Street"} required maxLength={160}/></label>
            <label>Postleitzahl<input name={prefix+"Zip"} required pattern="[0-9]{5}"/></label>
            <label>Ort<input name={prefix+"City"} required maxLength={100}/></label>
          </fieldset>)}
        {positions.map(key=><fieldset key={key}><legend>Produktposition</legend>
          <label>Produkt<select name={"variant"+key} required defaultValue=""><option value="">Produkt auswählen</option>
            {data.catalog.map(item=><option key={item.id} value={item.id}>{item.sku} · {item.label} · {euro.format(item.price_gross_cents/100)}</option>)}
          </select></label>
          <label>Menge<input name={"quantity"+key} type="number" defaultValue={1} min={1} max={1000} required/></label>
          <label>Vereinbarter Stückpreis brutto (EUR)<input name={"unit"+key} inputMode="decimal" pattern="[0-9]+([.,][0-9]{1,2})?"/></label>
          {positions.length>1&&<button type="button" onClick={()=>setPositions(list=>list.filter(item=>item!==key))}>Position entfernen</button>}
        </fieldset>)}
        <button type="button" disabled={positions.length>=20} onClick={()=>setPositions(list=>[...list,Math.max(...list)+1])}>Position hinzufügen</button>
        <label>Lieferkosten brutto (EUR)<input name="shippingGross" defaultValue="0,00" inputMode="decimal" pattern="[0-9]+([.,][0-9]{1,2})?" required/></label>
        <label>Interne Notiz<textarea name="note" maxLength={500}/></label>
        <button type="submit">Entwurf speichern</button>
      </fieldset>
    </form>}
    {!!data?.orders.length&&<ul>{data.orders.map(order=><li key={order.id}>
      <p>{order.order_number} · {order.customer_snapshot.company} · {order.manual_b2b.reference} · {states[order.status]}
        {order.status!=="cancelled"&&<> · Zahlung offen ({euro.format(order.total_gross_cents/100)})</>}</p>
      {data.canWrite&&<button type="button" disabled={busy} onClick={()=>offerFor===order.id?setOfferFor(null):void loadOffers(order.id)}>
        Angebote und Vertragsbezug
      </button>}
      {data.canWrite&&offerFor===order.id&&<section aria-label="Vertragsreferenzen">
        <p>Nur Referenz für diesen eigenständigen Auftrag. Automatische Vertragsübernahme wird nicht unterstützt.</p>
        {!offers.length&&!busy&&<p>Keine angenommenen Angebote dieses Kunden gefunden.</p>}
        {offers.map(offer=><div key={offer.offer_id+":"+offer.offer_version}>
          <p>Angebot {offer.offer_id} · Version {offer.offer_version} · {offer.terms.planType==="annual"?"Jahresvertrag":"Monatsvertrag"}</p>
          <p>Lieferintervall: {offer.terms.deliveryIntervalMonths??"unbekannt"} Monat(e) · Lieferanzahl: {offer.terms.deliveryCount??"offen"}
            {typeof offer.terms.packNetCents==="number"&&<> · Packpreis netto {euro.format(offer.terms.packNetCents/100)}</>}</p>
          {offer.terms.charges?.length?<p>Vertragliche Zahlbeträge: {offer.terms.charges.map(charge=>euro.format(charge.grossCents/100)).join(" / ")}</p>:null}
          {offer.agreement_id?<p>Bestehender Vertrag {offer.agreement_id} · {offer.contract_status}
            {offer.started_at&&<> · Beginn {offer.started_at.slice(0,10)}</>}{offer.ended_at&&<> · Ende {offer.ended_at.slice(0,10)}</>}</p>
            :<p>{offer.checkout_claimed?"Checkout bereits zugeordnet":"Kein Checkout zugeordnet"}</p>}
          {offer.linked?<p>Als Referenz gespeichert.</p>:order.status!=="cancelled"&&!offers.some(other=>other.linked)&&
            <button type="button" disabled={busy} onClick={()=>{
              if(window.confirm("Nur als Referenz zu einem eigenständigen Auftrag speichern? Der Vertrag bleibt unverändert."))void loadOffers(order.id,offer);
            }}>Nur als Referenz speichern</button>}
        </div>)}
      </section>}
      {data.canWrite&&order.status==="pending"&&<button type="button" disabled={busy} onClick={()=>void save("confirm",order.id)}>Bestellung bestätigen</button>}
      {data.canWrite&&order.status==="confirmed"&&<button type="button" disabled={busy}
        onClick={()=>setInvoiceFor(invoiceFor===order.id?null:order.id)}>Auftragsbest?tigung und Rechnung</button>}
      {data.canWrite&&invoiceFor===order.id&&order.status==="confirmed"&&<form className="portal-form" onSubmit={event=>void invoiceDocument(event,order.id)}>
        <fieldset disabled={busy}>
          <label>Dokument<select name="mode"><option value="order_confirmation">Auftragsbest?tigung</option>
            <option value="draft">Rechnungsentwurf</option><option value="issue">Rechnung ausstellen oder abrufen</option>
            {order.received_cents===0&&<option value="correction">Unbezahlte Rechnung vollst?ndig korrigieren</option>}</select></label>
          <label>Leistungsdatum<input type="date" name="supplyOn" required/></label>
          <label><input type="checkbox" name="confirmed" value="yes"/> Rechnungsdaten und tats?chliches Leistungsdatum zur Ausstellung best?tigt</label>
          <button type="submit">PDF abrufen</button>
        </fieldset>
      </form>}
      {data.canWrite&&order.status==="confirmed"&&<button type="button" disabled={busy} onClick={()=>{
        paymentOperation.current=null;
        setPaymentFor(paymentFor===order.id?null:order.id);
      }}>Best?tigten Zahlungseingang erfassen</button>}
      {data.canWrite&&paymentFor===order.id&&order.status==="confirmed"&&<form className="portal-form" onSubmit={event=>{
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        paymentOperation.current ??= crypto.randomUUID();
        void save("record_payment",order.id,{operation:paymentOperation.current,method:order.manual_b2b.payment,
          document:values.get("document"),reference:values.get("reference"),receivedOn:values.get("receivedOn"),
          confirmed:values.get("confirmed")==="yes",amount:decimalCents(String(values.get("amount")??""))});
      }}>
        <fieldset disabled={busy}>
          <p>{order.manual_b2b.payment==="bank"?"Bank?berweisung":"Barzahlung"}. Originalnachweis zuerst unter Finanzen ? Dokumente erfassen.</p>
          <label>Beleg-ID des Originalnachweises<input name="document" required maxLength={36}/></label>
          <label>Eindeutige Buchungs- oder Kassenbelegreferenz<input name="reference" required minLength={3} maxLength={120}/></label>
          <label>Datum des tats?chlichen Eingangs<input type="date" name="receivedOn" required/></label>
          <label>Vereinnahmter Betrag (EUR)<input name="amount" inputMode="decimal" pattern="[0-9]+([.,][0-9]{1,2})?" required/></label>
          <label><input type="checkbox" name="confirmed" value="yes" required/> Tats?chlichen Geldeingang am Original gepr?ft</label>
          <button type="submit">Zahlungseingang buchen</button>
        </fieldset>
      </form>}
      {data.canWrite&&order.status==="confirmed"&&<button type="button" disabled={busy}
        onClick={()=>void toggleDeliveries(order.id)}>Lieferungen und Lieferscheine</button>}
      {data.canWrite&&deliveryFor===order.id&&deliveryData&&<>
        <ul>{deliveryData.items.map(item=><li key={item.id}>{item.product_name} ? {
          deliveryData.deliveries.filter(row=>row.order_item_id===item.id).reduce((sum,row)=>sum+row.units,0)
        } / {item.quantity} ?bergeben oder versandt</li>)}</ul>
        {deliveryData.deliveries.map(row=><button key={row.id} type="button" disabled={busy}
          onClick={()=>void downloadDelivery(order.id,row.id)}>Lieferschein {row.reference}</button>)}
        {order.received_cents<order.total_gross_cents
          ? <p>Lieferung gesperrt, bis die Zahlung vollst?ndig best?tigt ist.</p>
          : <form className="portal-form" onSubmit={event=>{
            event.preventDefault();
            const values=new FormData(event.currentTarget);
            deliveryOperation.current??=crypto.randomUUID();
            void save("record_delivery",order.id,{operation:deliveryOperation.current,lineId:values.get("lineId"),lot:values.get("lot"),
              proof:values.get("proof"),deliveredOn:values.get("deliveredOn"),recipient:values.get("recipient"),reference:values.get("reference"),
              amount:Number(values.get("amount")),confirmed:values.get("confirmed")==="yes"});
          }}>
            <fieldset disabled={busy}>
              <label>Auftragsposition<select name="lineId" required defaultValue=""><option value="">Ausw?hlen</option>
                {deliveryData.items.map(item=><option key={item.id} value={item.id}>{item.sku} ? {item.product_name}</option>)}
              </select></label>
              <label>Chargen-Beleg-ID<input name="lot" maxLength={36} required/></label>
              <label>Beleg-ID f?r ?bergabe oder Versand<input name="proof" maxLength={36} required/></label>
              <label>Tats?chliches ?bergabe- oder Versanddatum<input name="deliveredOn" type="date" required/></label>
              <label>Empf?nger, Abholperson oder Transportdienstleister<input name="recipient" maxLength={80} required/></label>
              <label>?bergabe- oder Sendungsreferenz<input name="reference" maxLength={80} required/></label>
              <label>Menge aus dieser Charge<input name="amount" type="number" min={1} max={10000} required/></label>
              <label><input name="confirmed" type="checkbox" value="yes" required/> Tats?chliche ?bergabe oder Versand best?tigt</label>
              <button type="submit">?bergabe und Chargenbewegung buchen</button>
            </fieldset>
          </form>}
      </>}
      {data.canWrite&&order.status!=="cancelled"&&order.received_cents===0&&<button type="button" disabled={busy}
        onClick={()=>{if(window.confirm("Manuellen Auftrag stornieren?"))void save("cancel",order.id);}}>Auftrag stornieren</button>}
    </li>)}</ul>}
  </section>;
}
