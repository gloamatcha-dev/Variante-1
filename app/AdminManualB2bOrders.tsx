"use client";

import {useEffect, useRef, useState, type FormEvent} from "react";
import {portalRequest} from "./AdminPortalShared";

type Catalog = {id:string;sku:string;label:string;price_gross_cents:number};
type Order = {id:string;order_number:string;status:string;total_gross_cents:number;
  customer_snapshot:{company:string};manual_b2b:{reference:string;payment:string}};
type Data = {canWrite:boolean;orders:Order[];customers:{user_id:string;company_name:string}[];catalog:Catalog[]};
const euro = new Intl.NumberFormat("de-DE",{style:"currency",currency:"EUR"});
const states:Record<string,string> = {pending:"Entwurf",confirmed:"Bestätigt",cancelled:"Storniert"};

export function AdminManualB2bOrders() {
  const [data,setData] = useState<Data|null>(null);
  const [open,setOpen] = useState(false);
  const [positions,setPositions] = useState([0]);
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState("");
  const operation = useRef<string|null>(null);
  const mutation = useRef(false);
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
      if(action==="create"){operation.current=null;setOpen(false);setPositions([0]);}
      await load();
      setNotice("Auftrag gespeichert.");
    } catch(error) { setNotice(error instanceof Error ? error.message : "Auftrag konnte nicht gespeichert werden."); }
    finally {mutation.current=false;setBusy(false);}
  }
  function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const get = (key:string)=>String(values.get(key)??"");
    const amount = (key:string)=>{
      const value=get(key).replace(",",".");
      if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return NaN;
      const [units,cents=""] = value.split(".");
      return Number(units)*100+Number(cents.padEnd(2,"0"));
    };
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
        <p>Manueller Auftrag für Deutschland in EUR. Ohne Bestandszusage. Zahlungen und Lieferungen werden hier noch nicht verarbeitet.</p>
        <label>Geschäftskunde<select name="customer" required defaultValue="">
          <option value="">Konto auswählen</option>
          {data.customers.map(customer=><option key={customer.user_id} value={customer.user_id}>{customer.company_name}</option>)}
        </select></label>
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
      {data.canWrite&&order.status==="pending"&&<button type="button" disabled={busy} onClick={()=>void save("confirm",order.id)}>Bestellung bestätigen</button>}
      {data.canWrite&&order.status!=="cancelled"&&<button type="button" disabled={busy}
        onClick={()=>{if(window.confirm("Manuellen Auftrag stornieren?"))void save("cancel",order.id);}}>Auftrag stornieren</button>}
    </li>)}</ul>}
  </section>;
}
