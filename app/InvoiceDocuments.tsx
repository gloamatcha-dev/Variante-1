"use client";

import { useState } from "react";

export function InvoiceDocuments({ access }: {
  access: { token: string; orderId: string } | { token: string; annualPlanId: string } | { token: string; agreementId: string } | { guestToken: string };
}) {
  const [rows, setRows] = useState<{ id: string; number: string; original_id: string | null; format?: string }[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function load(id?: string, number?: string, format?: string) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      let response: Response;
      if ("guestToken" in access) {
        response = await fetch("/api/orders/guest", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: access.guestToken, invoiceId: id ?? null }),
        });
      } else {
        const params = new URLSearchParams("orderId" in access
          ? { orderId: access.orderId } : "annualPlanId" in access ? { annualPlanId: access.annualPlanId } : { agreementId: access.agreementId });
        if (id) params.set("id", id);
        response = await fetch("/api/orders/invoices?" + params, {
          headers: { Authorization: "Bearer " + access.token },
        });
      }
      if (!response.ok) throw new Error("invoice_unavailable");
      if (!id) {
        const data = await response.json();
        setRows(data.invoices);
        if (!data.invoices.length) setMessage("Noch keine Rechnungsdokumente verfügbar.");
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = number + (format === "xrechnung" ? ".xml" : ".pdf");
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setMessage("Rechnungsdokumente konnten nicht geladen werden.");
    } finally {
      setBusy(false);
    }
  }

  return <section className="portal-note">
    <h2>Rechnungsdokumente</h2>
    <button type="button" className="portal-action" disabled={busy} onClick={() => void load()}>Dokumente laden</button>
    {message && <p role="status">{message}</p>}
    <ul>{rows.map(row => <li key={row.id}>
      <button type="button" disabled={busy} onClick={() => void load(row.id, row.number, row.format)}>
        {row.original_id ? "Rechnungskorrektur " : "Rechnung "}{row.number} herunterladen
      </button>
    </li>)}</ul>
  </section>;
}
