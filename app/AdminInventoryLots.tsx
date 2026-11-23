"use client";

import { useRef, useState, type FormEvent } from "react";
import { portalRequest } from "./AdminPortalShared";

type Lot = { receipt_id: string; lot_code: string; sku: string; remaining_quantity: number;
  received_quantity: number; blocked: boolean; eligible: boolean; best_before: string; supplier: string | null; occurred_at: string };
type Trace = {
  lots: Lot[];
  sources: { packed_code: string; raw_code: string; raw_receipt_id: string; grams: number }[];
  shipments: { lot_code: string; quantity: number; order_number: string | null;
    delivery_id: string | null; customer_id: string | null; customer_email: string | null }[];
  history: { id: number; receipt_id: string; blocked: boolean; reason: string; actor: string; recorded_at: string }[];
  corrections: { movement_id: string; code: string; quantity: number; reason: string; actor: string; occurred_at: string }[];
};
const endpoint = "/api/admin/inventory/lots";

export function AdminInventoryLots() {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [selected, setSelected] = useState<Lot | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const running = useRef(false);
  const pending = useRef<{ id: string; fingerprint: string } | null>(null);

  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Chargenvorgang nicht bestätigt."); }
    finally { running.current = false; setBusy(false); }
  }

  async function search(value: string) {
    const result = await portalRequest(endpoint, { action: "read", code: value });
    setTrace(result as unknown as Trace);
  }

  function submitStatus(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const fields = new FormData(event.currentTarget);
    const reason = String(fields.get("reason") ?? "").trim();
    const quantity = String(fields.get("quantity") ?? "").replace(",", ".");
    const fingerprint = JSON.stringify([selected.receipt_id, selected.blocked, reason, correcting, quantity]);
    if (!reason) return;
    if (pending.current && pending.current.fingerprint !== fingerprint) {
      setError("Status noch unklar. Bitte denselben Vorgang erneut senden.");
      return;
    }
    pending.current ??= { id: crypto.randomUUID(), fingerprint };
    const operationId = pending.current.id;
    void run(async () => {
      try {
        await portalRequest(endpoint, { action: correcting ? "correct" : "status", receiptId: selected.receipt_id,
          blocked: !selected.blocked, operationId, reason, quantity });
      } catch (cause) {
        if (cause instanceof Error && "status" in cause && [400, 409].includes(Number(cause.status))) pending.current = null;
        throw cause;
      }
      pending.current = null;
      setSelected(null);
      setTrace(null);
      await search(code.trim());
    });
  }

  return <details className="admin-data-card">
    <summary>Chargenverfolgung und Rückruf</summary>
    <p>Suche nach Chargenkennung, Abpack-ID, SKU, Bestellnummer oder B2B-Liefer-ID. Chargen mit dem frühesten MHD stehen oben. Herkunft ohne gespeicherten Chargennachweis ist unbekannt.</p>
    <form onSubmit={event => {
      event.preventDefault();
      void run(async () => { setTrace(null); setSelected(null); await search(code.trim()); });
    }}>
      <label>Charge, SKU oder Sendung <input value={code} onChange={event => setCode(event.target.value)}
        disabled={busy || !!pending.current} required maxLength={80} /></label>
      <button disabled={busy || !!pending.current || !code.trim()}>Nachverfolgen</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {trace && <>
      {!trace.lots.length && <p>Keine belegte Chargenzuordnung gefunden.</p>}
      <ul>{trace.lots.map(lot => <li key={lot.receipt_id}>
        <strong>{lot.lot_code}</strong> · {lot.sku} · MHD {lot.best_before} · {lot.remaining_quantity} von {lot.received_quantity}
        {" "}{lot.sku === "GLOA-MATCHA-RAW" ? "g" : "Stück"} · {lot.blocked ? "Gesperrt" : lot.remaining_quantity === 0 ? "Verbraucht" : lot.eligible ? "Verfügbar" : "Nicht zur Entnahme geeignet"}
        {lot.supplier && <> · {lot.supplier}</>} · Eingang {new Date(lot.occurred_at).toLocaleDateString("de-DE")} · Beleg-ID <code>{lot.receipt_id}</code>
        {" "}<button type="button" disabled={busy || !!pending.current}
          onClick={() => { setCorrecting(false); setSelected(lot); }}>{lot.blocked ? "Entsperren" : "Sperren"}</button>
        {" "}<button type="button" disabled={busy || !!pending.current || lot.remaining_quantity <= 0}
          onClick={() => { setCorrecting(true); setSelected(lot); }}>Menge reduzieren</button>
      </li>)}</ul>
      <h3>Rohchargen und Abpackung</h3>
      <ul>{trace.sources.map(row => <li key={row.packed_code + row.raw_receipt_id}>{row.raw_code} → {row.packed_code} · {row.grams} g</li>)}</ul>
      <h3>Betroffene Sendungen</h3>
      {!trace.shipments.length && <p>Keine belegten Sendungen zu dieser Charge.</p>}
      <ul>{trace.shipments.map(row => <li key={row.lot_code + (row.order_number ?? row.delivery_id)}>
        {row.order_number ?? row.delivery_id} · {row.quantity} Stück · {row.lot_code} · Kunde {row.customer_email ?? row.customer_id ?? "unbekannt"}
      </li>)}</ul>
      <h3>Sperrhistorie</h3>
      <ul>{trace.history.map(row => <li key={row.id}>{new Date(row.recorded_at).toLocaleString("de-DE")} ·
        {" "}{row.blocked ? "Gesperrt" : "Entsperrt"} · {row.reason} · {row.actor}</li>)}</ul>
      <h3>Korrekturbuchungen</h3>
      <ul>{trace.corrections.map(row => <li key={row.movement_id}>{new Date(row.occurred_at).toLocaleString("de-DE")} ·
        {" "}{row.code} · −{row.quantity} · {row.reason} · {row.actor}</li>)}</ul>
    </>}
    {selected && <form onSubmit={submitStatus} key={selected.receipt_id + String(correcting)}>
      {correcting && <label>Abzuziehende Menge ({selected.sku === "GLOA-MATCHA-RAW" ? "Gramm" : "Stück"})
        <input name="quantity" type="number" required min={selected.sku === "GLOA-MATCHA-RAW" ? 0.001 : 1}
          step={selected.sku === "GLOA-MATCHA-RAW" ? 0.001 : 1} max={selected.remaining_quantity} disabled={busy} />
      </label>}
      <label>Grund für {correcting ? "Korrektur" : selected.blocked ? "Entsperrung" : "Sperre"} von {selected.lot_code}
        <input name="reason" required maxLength={500} disabled={busy} /></label>
      <button disabled={busy}>{correcting ? "Menge korrigieren" : "Status speichern"}</button>
      <button type="button" disabled={busy || !!pending.current} onClick={() => setSelected(null)}>Abbrechen</button>
    </form>}
    <h3>Kommissionierung bestätigen</h3>
    <p>Erfasse die tatsächlich gepackten Chargen vor der Versandbestätigung. Pro Zeile eine Beleg-ID und die Stückzahl, getrennt durch ein Leerzeichen.</p>
    <form onSubmit={event => {
      event.preventDefault();
      const fields = new FormData(event.currentTarget);
      const lines = String(fields.get("lines")).trim().split(/\r?\n/).map(line => {
        const [receiptId, units, extra] = line.trim().split(/\s+/);
        return { receiptId, units: extra === undefined ? Number(units) : 0 };
      });
      void run(async () => {
        await portalRequest(endpoint, { action: "pick", reference: String(fields.get("reference")),
          sku: String(fields.get("sku")), lines });
        setNotice("Kommissionierung gespeichert. Der Versand kann jetzt über die bisherige Versandaktion bestätigt werden.");
      });
    }}>
      <fieldset disabled={busy || !!pending.current}>
        <label>Bestellnummer oder B2B-Liefer-ID <input name="reference" required maxLength={120} /></label>
        <label>SKU <select name="sku">
          {["GLOA-MATCHA-30G", "GLOA-MATCHA-50G", "GLOA-MATCHA-100G", "GLOA-MATCHA-B2B-500G"].map(sku => <option key={sku}>{sku}</option>)}
        </select></label>
        <label>Beleg-IDs und Stückzahlen <textarea name="lines" required maxLength={950} /></label>
        <button>Kommissionierung speichern</button>
      </fieldset>
    </form>
    {notice && <p role="status">{notice}</p>}
  </details>;
}
