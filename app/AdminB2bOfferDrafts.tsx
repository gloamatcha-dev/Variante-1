"use client";

import { useRef, useState, type FormEvent } from "react";
import { portalRequest } from "./AdminPortalShared";

const endpoint = "/api/admin/b2b/offers";
type Version = { version: number; state: string; pack_count: number; net_unit_cents: number; expires_at: string | null };
type Draft = {
  id: string;
  versions?: Version[];
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

  async function updateOffer(event: FormEvent<HTMLFormElement>, draft: Draft, latest?: Version) {
    event.preventDefault();
    if (running.current) return;
    const fields = new FormData(event.currentTarget);
    const evidence = String(fields.get("evidence") ?? "");
    const payload = evidence ? { action: "publish", version: latest?.version, evidence,
      planType: fields.get("planType"), postcode: String(fields.get("postcode") ?? "").trim(),
      instalmentCount: fields.get("instalmentCount") ? Number(fields.get("instalmentCount")) : null } : {
      action: "revise", expectedVersion: latest?.version ?? 0, packCount: Number(fields.get("quantity")),
      netUnitCents: Number(fields.get("price")),
    };
    running.current = true;
    setBusy(true);
    try {
      const update = await portalRequest(endpoint, { id: draft.id, ...payload });
      const result = await portalRequest(endpoint, { action: "list" });
      setDrafts(result.drafts as Draft[]);
      setFeedback(evidence ? update.notification === "sent" ? "Angebot veröffentlicht und Benachrichtigung gesendet."
        : "Angebot veröffentlicht. Benachrichtigung nicht als zugestellt bestätigt." : "Neue Version gespeichert.");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Aktion nicht bestätigt.");
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
    {drafts.length > 0 && <ul>{drafts.map(draft => {
      const latest = draft.versions?.reduce<Version | undefined>((current, row) =>
        !current || row.version > current.version ? row : current, undefined);
      return <li key={draft.id}>
        <p>{draft.inquiry_reference} · {draft.destination_country} · {latest?.state ?? "Entwurf"}
          {latest && " · Version " + latest.version}</p>
        {latest?.expires_at && <p>Gültig bis {new Date(latest.expires_at).toLocaleString("de-DE")}</p>}
        {latest?.state === "accepted" ? <p>Annahme liegt zur Vertragsprüfung vor.</p> :
          <form onSubmit={event => void updateOffer(event, draft, latest)} key={latest?.version ?? 0}>
            <label>Anzahl 500-g-Beutel <input name="quantity" type="number" min={1} max={100000}
              defaultValue={latest?.pack_count ?? draft.pack_count} required /></label>
            <label>Nettopreis je Beutel (Cent) <input name="price" type="number" min={1} max={10000000}
              defaultValue={latest?.net_unit_cents ?? draft.net_unit_cents} required /></label>
            <button disabled={busy}>Version speichern</button>
          </form>}
        {latest?.state === "draft" && draft.destination_country === "DE" &&
          <form onSubmit={event => void updateOffer(event, draft, latest)}>
            <label>Referenz des geprüften Steuernachweises <input name="evidence" required maxLength={200} /></label>
            <label>Liefer-PLZ <input name="postcode" required pattern="[0-9]{5}" maxLength={5} /></label>
            <label>Vertragsmodell <select name="planType" required defaultValue="">
              <option value="" disabled>Bitte auswählen</option>
              <option value="monthly">Monatlich</option>
              <option value="annual">Jahresvertrag</option>
            </select></label>
            <label>Zahlungen beim Jahresvertrag <select name="instalmentCount" defaultValue="">
              <option value="">Keine Raten (monatlicher Vertrag)</option>
              <option value="1">1 Zahlung</option><option value="2">2 Zahlungen</option><option value="4">4 Zahlungen</option>
            </select></label>
            <button disabled={busy}>Im Kundenkonto ver?ffentlichen</button>
          </form>}
        {draft.destination_country !== "DE" && <p>Internationale Steuerfreigabe ausstehend.</p>}
      </li>;
    })}</ul>}
  </details>;
}
