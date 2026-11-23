"use client";

import { useRef, useState, type FormEvent } from "react";
import { date, money, text, type PortalRow } from "../lib/adminPortalModel.ts";
import { portalRequest } from "./AdminPortalShared";

const endpoint = "/api/admin/creators/payouts";
const states: Record<string, string> = {
  draft: "Vorgeschlagen", approved: "Freigegeben", cancelled: "Abgelehnt", paid: "Zahlung dokumentiert",
};
const actions: Record<string, string> = { create: "Erstellt", approve: "Freigegeben", reject: "Abgelehnt", paid: "Zahlung dokumentiert" };
const rows = (data: PortalRow | null, key: string): PortalRow[] =>
  Array.isArray(data?.[key]) ? data[key] as PortalRow[] : [];

export function AdminCreatorPayouts({ creators }: { creators: PortalRow[] }) {
  const [creatorId, setCreatorId] = useState("");
  const [month, setMonth] = useState("");
  const [data, setData] = useState<PortalRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [evidence, setEvidence] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [documents, setDocuments] = useState<PortalRow[]>([]);
  const running = useRef(false);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const payout = data?.payout as PortalRow | null;
  const positions = rows(data, payout?.id ? "positions" : "candidates");
  const total = positions.reduce((sum, row) => sum + Number(row.cents), 0);
  const loaded = data?.creatorId === creatorId && data.month === month + "-01";

  async function act(action: string) {
    if (running.current || !creatorId || !month) return;
    const needsEvidence = action === "reject" || action === "paid";
    if (needsEvidence && !evidence.trim()) { setMessage("Bitte Begründung oder Zahlungsbelegreferenz eingeben."); return; }
    const isRead = action === "read" || action === "export";
    const paymentTime = action === "paid" ? new Date(paidAt) : null;
    if (paymentTime && !Number.isFinite(paymentTime.getTime())) { setMessage("Bitte den Zahlungszeitpunkt eingeben."); return; }
    const paidAtIso = paymentTime?.toISOString();
    if (action === "paid" && !documentId) { setMessage("Bitte das geschützte Original des Zahlungsbelegs auswählen."); return; }
    const key = JSON.stringify([creatorId, month, action, needsEvidence ? evidence.trim() : null, paidAtIso,
      action === "paid" ? documentId : null]);
    if (!isRead && pending.current && pending.current.key !== key) {
      setMessage("Der letzte Schreibvorgang ist unklar. Bitte dieselbe Aktion mit denselben Angaben erneut senden.");
      return;
    }
    if (!isRead) pending.current ??= { key, id: crypto.randomUUID() };
    running.current = true;
    setBusy(true);
    setMessage("");
    try {
      if (action === "export") {
        const result = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ creatorId, month, action }) });
        if (!result.ok) throw new Error("Interner Export nicht verfügbar.");
        const url = URL.createObjectURL(await result.blob());
        const link = document.createElement("a");
        link.href = url;
        link.download = `creator-abrechnung-${month}.json`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
      }
      if (!isRead) {
        await portalRequest(endpoint, { creatorId, month, action, operationId: pending.current?.id,
          evidence: needsEvidence ? evidence.trim() : undefined, paidAt: paidAtIso,
          documentId: action === "paid" ? documentId : undefined });
        pending.current = null;
        setEvidence("");
        setPaidAt("");
        setDocumentId("");
        setMessage("Vorgang dokumentiert.");
      }
      setData(await portalRequest(endpoint, { creatorId, month, action: "read" }));
    } catch (error) {
      if (error instanceof Error && "status" in error && [400,403,409].includes(Number(error.status))) pending.current = null;
      setMessage(error instanceof Error ? error.message : "Abrechnungsstand nicht bestätigt.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function loadDocuments() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const data = await portalRequest("/api/admin/documents", { action: "list" });
      setDocuments(rows(data, "documents").filter(row => row.kind === "other" && !!row.storage_path &&
        !!row.file_sha256 && !row.cleanup_operation_id));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Belege konnten nicht geladen werden.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return <section className="admin-data-card" aria-label="Monatsabrechnung für Creator">
    <h3>Monatsabrechnung</h3>
    <p>Wähle einen abgeschlossenen Monat. Nicht ausgeglichene Positionen werden in späteren Monaten berücksichtigt.</p>
    <form className="portal-controls" onSubmit={(event: FormEvent) => { event.preventDefault(); void act("read"); }}>
      <label>Creator<select required value={creatorId} disabled={busy || !!pending.current} onChange={event => setCreatorId(event.target.value)}>
        <option value="">Creator auswählen</option>
        {creators.map(row => <option key={String(row.id)} value={String(row.id)}>{text(row.display_name)}</option>)}
      </select></label>
      <label>Monat<input type="month" required value={month} disabled={busy || !!pending.current} onChange={event => setMonth(event.target.value)} /></label>
      <button type="submit" disabled={busy}>Abrechnung laden</button>
    </form>
    {loaded && <>
      <p>{payout?.id ? states[String(payout.state)] : "Berechtigte Positionen"} · {money(total)}</p>
      {data?.needsReview === true && <p role="alert">Refund oder Storno hat den Vorschlag verändert. Diesen Betrag nicht mehr zur Auszahlung verwenden.</p>}
      <ul>{positions.map(row => <li key={String(row.commission_id)}>
        {row.kind === "reversal" ? "Refund-Verrechnung" : "Provision"} · {money(row.cents)} · Bestellung {text(row.order_id)}
      </li>)}</ul>
      {!payout?.id && <button type="button" disabled={busy || total <= 0} onClick={() => void act("create")}>Auszahlungsvorschlag erstellen</button>}
      {["draft","approved"].includes(String(payout?.state)) && <>
        <label>{payout?.state === "approved" ? "Zahlungsbelegreferenz oder Ablehnungsgrund" : "Ablehnungsgrund"}
          <input value={evidence} maxLength={255} disabled={busy} onChange={event => setEvidence(event.target.value)} />
        </label>
        {payout?.state === "draft" && <button type="button" disabled={busy || data?.needsReview === true}
          onClick={() => { if (window.confirm("Vorschlag freigeben? Die Freigabe löst keine Auszahlung aus.")) void act("approve"); }}>Freigeben</button>}
        <button type="button" disabled={busy} onClick={() => void act("reject")}>Ablehnen</button>
        {payout?.state === "approved" && <><label>Zahlungszeitpunkt (Ortszeit)
          <input type="datetime-local" step="1" value={paidAt} disabled={busy} onChange={event => setPaidAt(event.target.value)} />
        </label>
          <p>Das Original in Finanzen → Dokumente als „Sonstiges“ hochladen.</p>
          <button type="button" disabled={busy} onClick={() => void loadDocuments()}>Zahlungsbelege laden</button>
          <label>Geschützter Zahlungsbeleg<select value={documentId} disabled={busy} onChange={event => setDocumentId(event.target.value)}>
            <option value="">Original auswählen</option>
            {documents.map(row => <option key={String(row.id)} value={String(row.id)}>{text(row.title)}</option>)}
          </select></label>
        </>}
        {payout?.state === "approved" && <button type="button" disabled={busy}
          onClick={() => { if (window.confirm("Liegt ein separater Nachweis für die tatsächlich ausgeführte Zahlung vor?")) void act("paid"); }}>
          Zahlung dokumentieren
        </button>}
      </>}
      {!!payout?.id && <button type="button" disabled={busy} onClick={() => void act("export")}>Interne Abrechnung exportieren</button>}
      <p>Steuerliche Abrechnungsdokumente sind bis zur Freigabe der Pflichtangaben gesperrt.</p>
      <h4>Vorgangsverlauf</h4>
      <ul>{rows(data,"events").map(row => <li key={String(row.operation_id)}>
        {date(row.occurred_at)} · {actions[String(row.action)]} · {text(row.actor)}{row.evidence ? " · " + text(row.evidence) : ""}
      </li>)}</ul>
      <h4>Abrechnungshistorie</h4>
      <ul>{rows(data,"history").map(row => <li key={String(row.id)}>{text(row.month)} · {states[String(row.state)]} · {money(row.total_cents)}</li>)}</ul>
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
