import { requireAdminIdentity } from "../../../../../lib/adminActionRoute.ts";
import { uuid } from "../../../../../lib/adminPortalModel.ts";
import { getSupabaseAdmin } from "../../../../../lib/supabaseAdmin";
import { calculateCartTax } from "../../../../../lib/tax.ts";
import { resolveTaxJurisdiction } from "../../../../../lib/taxJurisdiction.ts";

const json = (body: unknown, status = 200) => Response.json(body, {status, headers: {"Cache-Control": "no-store"}});
const invalid = () => json({error: "Auftragsdaten prüfen. Derzeit sind nur bestätigte deutsche EUR-Adressdaten zulässig."}, 400);
const text = (value: unknown, limit: number) =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= limit ? value.trim() : null;
const int = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

function address(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const street = text(input.street, 160), city = text(input.city, 100), postalCode = text(input.postalCode, 5);
  if (!street || !city || !postalCode || !/^\d{5}$/.test(postalCode) || input.country !== "DE") return null;
  return {street, city, postalCode, country: "DE"};
}

export async function POST(request: Request) {
  const identity = await requireAdminIdentity(request, "read_sensitive");
  if (!identity.ok) return identity.response;
  if (request.headers.get("origin") !== new URL(request.url).origin) return json({error: "Anfrageursprung ungültig."}, 403);
  const reader = request.body?.getReader();
  if (!reader) return invalid();
  let raw = "", bytes = 0;
  const decoder = new TextDecoder();
  let body: Record<string, unknown>;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 12000) { await reader.cancel(); return invalid(); }
      raw += decoder.decode(value, {stream: true});
    }
    body = JSON.parse(raw + decoder.decode());
    if (!body || typeof body !== "object" || Array.isArray(body)) return invalid();
  } catch { return invalid(); }
  const db = getSupabaseAdmin();
  if (!db) return json({error: "Bestellverwaltung nicht verfügbar."}, 503);
  const canWrite = identity.identity.role === "owner";
  if (body.action === "list") {
    const [orders, customers, catalog] = await Promise.all([
      db.from("orders").select("id,order_number,status,total_gross_cents,manual_b2b,customer_snapshot").not("manual_b2b","is",null)
        .order("created_at",{ascending:false}).limit(100),
      canWrite ? db.rpc("manual_b2b_verified_customers_v1",{actor:identity.session.userId}) : { data: [], error: null },
      canWrite ? db.from("product_variants").select("id,sku,label,price_gross_cents,products!inner(name)")
        .eq("is_active",true).eq("products.is_active",true).not("tax_category","is",null).not("price_gross_cents","is",null).limit(250)
        : { data: [], error: null },
    ]);
    if(orders.error || customers.error || catalog.error) return json({error:"Bestelldaten konnten nicht geladen werden."},503);
    const listed = orders.data ?? [];
    const totals = listed.length ? await db.rpc("read_manual_b2b_payment_totals_v1",{ids:listed.map(order=>order.id)})
      : {data:[],error:null};
    if (totals.error || !Array.isArray(totals.data)) return json({error:"Zahlungsst?nde nicht verf?gbar."},503);
    const received = new Map(totals.data.map(row=>[row.order_id, Number(row.received_cents)]));
    if ([...received.values()].some(value=>!Number.isSafeInteger(value)||value<0))
      return json({error:"Zahlungsst?nde nicht verf?gbar."},503);
    return json({canWrite, orders:listed.map(order=>({...order,received_cents:received.get(order.id)??0})),
      customers:customers.data, catalog:catalog.data});
  }
  if (!canWrite) return json({error:"Nur der Owner darf manuelle Aufträge bearbeiten."},403);
  if (body.action === "find_customer") {
    const email=text(body.email,254);
    if(!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return invalid();
    const result=await db.rpc("manual_b2b_verified_customers_v1",{actor:identity.session.userId,exact_email:email});
    if(result.error) return json({error:"Geschäftskonto konnte nicht geprüft werden."},503);
    if(result.data?.length!==1) return json({error:"Kein eindeutig bestätigtes Geschäftskonto gefunden. Registrierung, E-Mail-Bestätigung und Unternehmensvertretung prüfen."},409);
    return json({customer:result.data[0]});
  }
  if (!uuid(body.id)) return invalid();
  if(body.action==="offer_context"||body.action==="link_offer_reference") {
    const linking=body.action==="link_offer_reference";
    if(linking&&(!uuid(body.offerId)||!int(body.version,1,2147483647)||body.confirmed!==true)) return invalid();
    const result=await db.rpc("manual_b2b_offer_context_v1",{actor:identity.session.userId,target:body.id,
      ...(linking?{draft:body.offerId,revision:body.version}:{})});
    if(result.error) return json({error:"Angebotsreferenz nicht verfügbar. Kundenbezug, Freigabe oder bestehende Zuordnung prüfen."},409);
    return json({references:result.data??[]});
  }

  if (body.action === "deliveries" || body.action === "delivery_pdf") {
    const order = await db.from("orders").select("id,order_number,customer_snapshot,shipping_address_snapshot,manual_b2b")
      .eq("id",body.id).maybeSingle();
    if (order.error||!order.data?.manual_b2b) return json({error:"Manueller Auftrag nicht verf?gbar."},404);
    const [items, deliveries] = await Promise.all([
      db.from("order_items").select("id,sku,product_name,variant_name,quantity").eq("order_id",body.id),
      db.from("manual_b2b_deliveries").select("id,order_item_id,receipt_id,method,occurred_on,units,recipient,reference")
        .eq("order_id",body.id).order("created_at").limit(1001),
    ]);
    if (items.error||deliveries.error||!items.data||!deliveries.data||deliveries.data.length>1000)
      return json({error:"Lieferdaten nicht vollst?ndig verf?gbar."},503);
    if (body.action==="deliveries") return json({items:items.data,deliveries:deliveries.data});
    if(!uuid(body.deliveryId)) return invalid();
    const delivery=deliveries.data.find(row=>row.id===body.deliveryId);
    const line=items.data.find(row=>row.id===delivery?.order_item_id);
    if(!delivery||!line)return json({error:"Liefernachweis nicht gefunden."},404);
    const {renderBusinessDocumentPdf}=await import("../../../../../lib/invoicePdf");
    const shipping=order.data.shipping_address_snapshot;
    try {
      const pdf=renderBusinessDocumentPdf(["Lieferschein", "Auftrag: "+order.data.order_number,
        "Lieferbeleg: "+delivery.id,"",String(order.data.customer_snapshot.company),
        String(shipping.street),shipping.postalCode+" "+shipping.city,
        "Lieferdatum: "+delivery.occurred_on,
        "Art: "+({personal:"Pers?nliche Lieferung",pickup:"Abholung",carrier:"Versand"}[delivery.method as "personal"|"pickup"|"carrier"]),
        "Empf?nger oder Dienstleister: "+delivery.recipient,"Referenz: "+delivery.reference,
        line.sku+" | Menge: "+delivery.units, "Chargenbeleg: "+delivery.receipt_id]);
      return new Response(new Uint8Array(pdf),{headers:{"Content-Type":"application/pdf","Cache-Control":"no-store","Content-Disposition":"attachment"}});
    }catch {return json({error:"Lieferdaten k?nnen nicht als PDF dargestellt werden."},409);}
  }
  if (body.action === "record_delivery") {
    const deliveredOn=text(body.deliveredOn,10), recipient=text(body.recipient,80), reference=text(body.reference,80);
    if (body.confirmed!==true||!uuid(body.operation)||!uuid(body.lineId)||!uuid(body.lot)||!uuid(body.proof)
      ||!deliveredOn||!/^\d{4}-\d{2}-\d{2}$/.test(deliveredOn)||!recipient||!reference||!int(body.amount,1,10000))return invalid();
    const result=await db.rpc("record_manual_b2b_delivery_v1",{actor:identity.session.userId,target:body.id,
      operation:body.operation,line_id:body.lineId,lot:body.lot,proof:body.proof,amount:body.amount,
      delivered_on:deliveredOn,recipient,reference});
    if(result.error)return json({error:"Lieferung nicht erfasst. Zahlung, Bestand, Charge und Originalnachweis pr?fen."},
      result.error.code==="42501"?403:result.error.message==="release_writes_disabled"?503:409);
    return json({id:result.data});
  }
  if (body.action === "invoice") {
    const supplyOn = text(body.supplyOn,10), mode = body.mode;
    if (!supplyOn || !/^\d{4}-\d{2}-\d{2}$/.test(supplyOn) ||
      (mode!=="draft"&&mode!=="order_confirmation"&&mode!=="issue"&&mode!=="correction") ||
      ((mode==="issue"||mode==="correction")&&body.confirmed!==true)) return invalid();
    try {
      const {manualB2bInvoice}=await import("../../../../../lib/gloaInvoice.server");
      const result=await manualB2bInvoice(db,identity.session.userId,String(body.id),supplyOn,mode);
      if (result.pdf) return new Response(new Uint8Array(result.pdf),{headers:{
        "Content-Type":"application/pdf","Cache-Control":"no-store","Content-Disposition":"attachment",
      }});
      return json({id:result.id});
    } catch {
      return json({error:"Dokument nicht verf?gbar. Best?tigung, Leistungsdatum, Aussteller und Rechnungsfreigabe pr?fen."},409);
    }
  }
  if (body.action === "record_payment") {
    const reference = text(body.reference,120), receivedOn = text(body.receivedOn,10);
    if (body.confirmed!==true || !uuid(body.operation) || !uuid(body.document) || !reference || reference.length<3
      || !receivedOn || !/^\d{4}-\d{2}-\d{2}$/.test(receivedOn)
      || !int(body.amount,1,100000000) || (body.method!=="bank"&&body.method!=="cash")) return invalid();
    const result = await db.rpc("record_manual_b2b_payment_v1",{actor:identity.session.userId,target:body.id,
      operation:body.operation,document:body.document,method:body.method,reference,received_on:receivedOn,amount:body.amount});
    if (result.error) return json({error:"Zahlung nicht erfasst. Freigabe, Originalnachweis, Datum und eindeutige Referenz pr?fen."},
      result.error.code==="42501"?403:result.error.message==="release_writes_disabled"?503:409);
    return json({id:result.data});
  }
  let payload: Record<string, unknown> = {};
  if (body.action === "create") {
    const reference = text(body.reference,120), contact = text(body.contact,120), email = text(body.email,254);
    const orderedOn = text(body.orderedOn,10), note = body.note === "" ? null : text(body.note,500);
    const billing = address(body.billing), shipping = address(body.shipping);
    if (!uuid(body.customer) || !reference || !contact || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      || !orderedOn || !/^\d{4}-\d{2}-\d{2}$/.test(orderedOn) || !billing || !shipping || (body.note && !note)
      || !["email","phone","in_person","other"].includes(String(body.source))
      || !["bank","cash"].includes(String(body.payment)) || !["personal","pickup","carrier"].includes(String(body.delivery))
      || !Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > 20 || !int(body.shippingGross,0,1000000)) return invalid();
    const items = body.lines as {variant: unknown; quantity: unknown; unit?: unknown}[];
    if (!items.every(item=>item && uuid(item.variant) && int(item.quantity,1,1000)
      && (item.unit === undefined || int(item.unit,1,100000)))) return invalid();
    const ids = items.map(item=>String(item.variant));
    if (new Set(ids).size !== ids.length) return invalid();
    const result = await db.from("product_variants")
      .select("id,sku,price_gross_cents,tax_category,products!inner(slug)").eq("is_active",true).eq("products.is_active",true).in("id",ids);
    if (result.error) return json({error:"Produktdaten konnten nicht geladen werden."},503);
    const variants = new Map((result.data ?? []).map(row=>[row.id,row]));
    const priced = items.flatMap(item=>{
      const row = variants.get(item.variant);
      const unit = item.unit ?? row?.price_gross_cents;
      if (!row || !int(unit,1,100000) || !int(item.quantity,1,1000)) return [];
      return [{variantId:row.id, sku:row.sku, productSlug:"", catalogTaxCategory:row.tax_category,
        quantity:item.quantity, unitGrossCents:unit, lineGrossCents:unit*item.quantity}];
    });
    const jurisdiction = resolveTaxJurisdiction("DE");
    if (!jurisdiction.supported || priced.length !== items.length) return invalid();
    const tax = calculateCartTax({jurisdiction:jurisdiction.jurisdiction,treatment:"de_domestic",items:priced,shippingGrossCents:body.shippingGross});
    if (!tax.ok || tax.snapshot.totals.totalGrossCents > 100000000) return invalid();
    payload = {reference,contact,email,orderedOn,note,billing,shipping,customer:body.customer,source:body.source,
      payment:body.payment,delivery:body.delivery,taxVersion:tax.snapshot.calculationVersion,
      shippingNet:tax.snapshot.shipping.netCents,shippingGross:body.shippingGross,shippingTax:tax.snapshot.shipping.allocations,
      lines:tax.snapshot.items.map(item=>({variant:item.variantId,quantity:item.quantity,unit:item.unitGrossCents,
        rate:item.taxRatePercent,unit_net:item.unitNetCents,line_net:item.lineNetCents}))};
  } else if (body.action !== "confirm" && body.action !== "cancel") return invalid();
  const result = await db.rpc("admin_manual_b2b_order_v1",{actor:identity.session.userId,target:body.id,action:body.action,payload});
  if (result.error) {
    if (result.error.message === "release_writes_disabled") return json({error:"Manuelle B2B-Schreibaktionen sind noch nicht freigegeben."},503);
    return json({error:"Auftrag konnte nicht gespeichert werden. Referenz, Kundenkonto und Auftragsstatus prüfen."},result.error.code === "42501" ? 403 : 409);
  }
  return json({id:result.data});
}
