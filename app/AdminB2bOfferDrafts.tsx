"use client";

import { useRef, useState, type FormEvent } from "react";
import { portalRequest } from "./AdminPortalShared";

const endpoint = "/api/admin/b2b/offers";
type Draft = {
  id: string;
  inquiry_reference: string;
  destination_country: string;
  pack_count: number;
  net_unit_cents: number;
};

export function AdminB2bOfferDrafts() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const pending = useRef<{ fingerprint: string; id: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (running.current) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const values = {
      customerId: String(fields.get("customerId") ?? "").trim(),
      inquiryReference: String(fields.get("inquiryReference") ?? "").trim(),
      destinationCountry: String(fields.get("destinationCountry") ?? "").trim().toUpperCase(),
      packCount: Number(fields.get("packCount")),
      netUnitCents: Number(fields.get("netUnitCents")),
    };
    const fingerprint = JSON.stringify(values);
    if (pending.current && pending.current.fingerprint !== fingerprint) {
      setFeedback("Speicherung unklar. Bitte die ursprünglichen Werte erneut senden.");
      return;
    }
    pending.current ??= { fingerprint, id: crypto.randomUUID() };
    running.current = true;
    setBusy(true);
    setFeedback("");
    try {
      const result = await portalRequest(endpoint, { action: "create", id: pending.current.id, ...values });
      const draft = result.draft as Draft;
      setDrafts(previous => [draft, ...previous.filter(row => row.id !== draft.id)].slice(0, 30));
      pending.current = null;
      form.reset();
      setFeedback("Entwurf gespeichert.");
    } catch (error) {
      if (error instanceof Error && "status" in error &&
          (error.status === 400 || error.status === 403 || error.status === 409)) pending.current = null;
      setFeedback(error instanceof Error ? error.message : "Speicherung nicht bestätigt.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function loadDrafts() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setFeedback("");
    try {
      const result = await portalRequest(endpoint, { action: "list" });
      const rows = result.drafts as Draft[];
      setDrafts(rows);
      if (rows.length === 0) setFeedback("Keine Angebotsentwürfe vorhanden.");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Entwürfe nicht verfügbar.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return <details className="admin-data-card">
    <summary>B2B-Angebotsentwürfe</summary>
    <p>Interne Vorbereitung für 500-g-Fertigware. Vorgesehene Angebotsgültigkeit: 14 Tage. Vor Versand ist eine Steuerprüfung erforderlich.</p>
    <form onSubmit={submit}>
      <fieldset className="ops-toolbar" disabled={busy}>
        <label className="ops-field">Geschäftskunden-ID<input name="customerId" required maxLength={36} /></label>
        <label className="ops-field">Anfrage-Referenz<input name="inquiryReference" required maxLength={200} /></label>
        <label className="ops-field">Zielland (ISO-Code)<input name="destinationCountry" required pattern="[A-Za-z]{2}" maxLength={2} /></label>
        <label className="ops-field">Anzahl 500-g-Beutel<input name="packCount" type="number" required min={1} max={100000} /></label>
        <label className="ops-field">Nettopreis je Beutel (Cent)<input name="netUnitCents" type="number" required min={1} max={10000000} /></label>
        <button type="submit">Entwurf speichern</button>
      </fieldset>
    </form>
    <button type="button" disabled={busy} onClick={() => void loadDrafts()}>Letzte 30 Entwürfe laden</button>
    {feedback && <p role="status">{feedback}</p>}
    {drafts.length > 0 && <ul>{drafts.map(draft => <li key={draft.id}>
      {draft.inquiry_reference} · {draft.destination_country} · {draft.pack_count} × 500 g · {draft.net_unit_cents} Cent netto je Beutel
    </li>)}</ul>}
  </details>;
}
