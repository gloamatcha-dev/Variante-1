"use client";
import {BusinessContext,Chip} from './AdminPortalShared';

import { useCallback, useEffect, useState } from "react";

/**
 * THE CONSUMER RIGHTS DESK.
 *
 * Four sections that are deliberately NOT merged, because the four
 * rights behind them are not the same thing and an operator who
 * confuses them costs the customer money:
 *
 *   WIDERRUF      a statutory right of withdrawal, with a deadline, a
 *                 possible Wertersatz and a refund
 *   REKLAMATION   a defect claim - WE carry the transport, and no
 *                 Wertersatz applies at all
 *   KÜNDIGUNG     ends a contract going forward. No refund, ever.
 *   KAUFSPERREN   manual, admin-created purchase restrictions
 *
 * ── EVERY BUTTON HERE IS A SERVER DECISION ───────────────────
 *
 * Nothing in this component computes a refund, a ceiling or a deadline.
 * It sends an intent to /api/admin/customer-rights, which calls one of
 * migration 070's audited SQL writers, and it renders whatever comes
 * back - including a refusal like 'above_ceiling' or 'return_outstanding'.
 * That is why the value-loss field can be typed into freely: the
 * database is what says no.
 *
 * ── AND THE PAYOUT IS A SECOND ENDPOINT ────────────────────
 *
 * "Erstattung vorbereiten" goes to the desk and only DECIDES. "Erstattung
 * auszahlen" goes to /api/admin/withdrawal-refund, the one route that
 * reaches Stripe, and it sends nothing but the case id - the amount is
 * re-read from the database there. Two buttons because they are two
 * different acts, and the second one cannot be reached by accident from
 * the first.
 */

type Json = Record<string, unknown>;

type Payload = {
  withdrawals: Json[];
  complaints: Json[];
  terminations: Json[];
  restrictions: Json[];
  orders: Json[];
  plans: Json[];
  orderItems: Json[];
};

const EMPTY: Payload = {
  withdrawals: [], complaints: [], terminations: [], restrictions: [], orders: [], plans: [],
  orderItems: [],
};

const euro = (c: unknown): string =>
  typeof c === "number" ? (c / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" }) : "–";

const dt = (v: unknown): string => {
  if (typeof v !== "string") return "–";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "–" : d.toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
};

const TIMELINESS_LABEL: Record<string, string> = {
  timely: "fristgerecht",
  late: "verspätet",
  receipt_unknown: "Zugang unbekannt",
  deadline_uncertain: "Frist unklar",
};

export function AdminCustomerRights({ onSessionLost, initialSection, initialFocus = "" }: { onSessionLost: () => void; initialSection?: "widerruf" | "reklamation" | "kuendigung" | "sperren"; initialFocus?:string }) {
  const [data, setData] = useState<Payload>(EMPTY);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [terminationNotes,setTerminationNotes]=useState<Record<string,string>>({});
  const [loaded,setLoaded]=useState(false);
  const [contextId,setContextId]=useState<string|null>(null);
  const [notice, setNotice] = useState("");
  const [section, setSection] = useState<"widerruf" | "reklamation" | "kuendigung" | "sperren">(initialSection ?? "widerruf");

  const post = useCallback(async (body: Json): Promise<Json | null> => {
    const res = await fetch("/api/admin/customer-rights", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 401) { onSessionLost(); return null; }
    const json = await res.json().catch(() => null);
    if (!res.ok) { setError((json?.error as string) || "Aktion fehlgeschlagen."); return null; }
    return json as Json;
  }, [onSessionLost]);

  // THE PAYOUT POSTER. A separate function to a separate route, so
  // that reaching Stripe from this screen requires naming it.
  const postPayout = useCallback(async (
    withdrawalId: string,
    action: "execute_refund" | "retry_completion_email" = "execute_refund"
  ): Promise<Json | null> => {
    const res = await fetch("/api/admin/withdrawal-refund", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // NO AMOUNT, in either action. The server re-reads what it approved.
      body: JSON.stringify({ action, withdrawalId }),
    });
    if (res.status === 401) { onSessionLost(); return null; }
    const json = await res.json().catch(() => null);
    if (!res.ok) { setError((json?.error as string) || "Auszahlung fehlgeschlagen."); return null; }
    return json as Json;
  }, [onSessionLost]);

  const reload = useCallback(async () => {
    setBusy(true); setError("");
    const json = await post({ action: "list" });
    if (json) {setData({ ...EMPTY, ...(json as Partial<Payload>) });setLoaded(true);}
    setBusy(false);
  }, [post]);

  // THE FIRST LOAD DOES NOT GO THROUGH reload().
  //
  // reload() sets `busy` as its first statement, and doing that
  // synchronously inside an effect is what triggers a cascading render.
  // So the mount path starts already busy - which is true, it is about
  // to fetch - and only touches state after the await.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const json = await post({ action: "list" });
      if (cancelled) return;
      if (json) {setData({ ...EMPTY, ...(json as Partial<Payload>) });setLoaded(true);}
      setBusy(false);
    })();
    return () => { cancelled = true; };
  }, [post]);

  const act = async (body: Json, label: string) => {
    setBusy(true); setError(""); setNotice("");
    const json = await post(body);
    if (json) {
      const result = String(json.result ?? "ok");
      // A refusal from the database is shown as it came back, not
      // translated into a success the operator would have to guess at.
      setNotice(`${label}: ${result}`);
      await reload();
    }
    setBusy(false);
  };

  const payout = async (withdrawalId: string) => {
    setBusy(true); setError(""); setNotice("");
    const json = await postPayout(withdrawalId);
    if (json) {
      // The mail outcome is shown too. A refund that went through while
      // its mail did not is exactly the state an operator has to see.
      const mail = json.completion_email ? ` · Mail: ${String(json.completion_email)}` : "";
      setNotice(`Auszahlung: ${String(json.result ?? "ok")}${mail}`);
      await reload();
    }
    setBusy(false);
  };

  // RETRIES THE MAIL AND NOTHING ELSE. It reaches no payment provider,
  // so pressing it twice cannot cost anything.
  const retryMail = async (withdrawalId: string) => {
    setBusy(true); setError(""); setNotice("");
    const json = await postPayout(withdrawalId, "retry_completion_email");
    if (json) {
      setNotice(`Erstattungsmail: ${String(json.completion_email ?? "ok")}`);
      await reload();
    }
    setBusy(false);
  };

  const order = (id: unknown) => data.orders.find(o => o.id === id);
  const plan = (id: unknown) => data.plans.find(p => p.id === id);

  // THE GOODS LINES OF A NORMAL ORDER, which is where a non-plan case's
  // Wertersatz ceiling comes from. One line means the database can price
  // it; several mean it returns manual_review_required, and the operator
  // needs to see that before pressing anything.
  const itemsOf = (orderId: unknown) =>
    typeof orderId === "string" ? data.orderItems.filter(i => i.order_id === orderId) : [];

  const visibleCase=(row:Json)=>/^[0-9a-f-]{36}$/i.test(initialFocus)?row.id===initialFocus:initialFocus==='extraordinary'?row.termination_kind==='extraordinary'&&['submitted','under_review'].includes(String(row.case_state)):initialFocus==='refund'?['approved_for_payout','failed'].includes(String(row.refund_state)):initialFocus==='open'?!['closed','refunded','resolved'].includes(String(row.case_state)):true;
  if(!loaded)return <section className="ops-panel" aria-busy={busy}>{error?<><p className="ops-error" role="alert">{error}</p><button type="button" onClick={()=>void reload()}>Erneut versuchen</button></>:<p role="status">Fälle werden geladen …</p>}</section>;
  return (
    <section className="ops-panel ops-customer-rights">
      <header className="ops-panel-head">
        <h2>Verbraucherrechte</h2>
        <button type="button" onClick={() => void reload()} disabled={busy}>
          {busy ? "Lädt …" : "Neu laden"}
        </button>
      </header>

      <nav className="ops-subnav" aria-label="Verbraucherrechte">
        {([["widerruf", `Widerruf (${data.withdrawals.length})`],
           ["reklamation", `Reklamation (${data.complaints.length})`],
           ["kuendigung", `Kündigung (${data.terminations.length})`],
           ["sperren", `Kaufsperren (${data.restrictions.length})`]] as const).map(([k, l]) => (
          <button key={k} type="button" className={section === k ? "is-active" : ""}
                  onClick={() => setSection(k)}>{l}</button>
        ))}
      </nav>

      {error && <p className="ops-error">{error}</p>}
      {notice && <p className="ops-notice">{notice}</p>}

      {/* ── WIDERRUF ───────────────────────────────────────────── */}
      {section === "widerruf" && (
        <div className="ops-list">
          {data.withdrawals.length === 0 && <p>Keine Widerrufsfälle.</p>}
          {data.withdrawals.filter(visibleCase).map(w => {
            const o = order(w.resolved_order_id) ?? {};
            const p = plan(w.resolved_annual_plan_id) ?? {};
            const items = itemsOf(w.resolved_order_id);
            const resolvedItem = items.find(i => i.id === w.resolved_order_item_id);
            const isPartial = w.scope === "partial";
            const id = String(w.id);
            return (
              <article key={id} className="ops-card">
                <h3>{String(w.customer_name)} · {String(w.order_reference)}</h3>
                <dl className="ops-facts">
                  <div><dt>E-Mail</dt><dd>{String(w.contact_email)}</dd></div>
                  <div><dt>Eingegangen</dt><dd>{dt(w.submitted_at)}</dd></div>
                  <div><dt>Zuordnung</dt><dd>{String(w.resolution_method ?? "unresolved")}</dd></div>
                  <div><dt>Bestellung</dt><dd>{String(o.order_number ?? "–")}</dd></div>
                  <div><dt>Versand</dt><dd>{dt(o.shipped_at)}</dd></div>
                  <div><dt>Zustellung</dt><dd>{dt(o.delivered_at)}</dd></div>
                  <div><dt>Zustellquelle</dt><dd>{String(o.delivery_receipt_source ?? "–")}</dd></div>
                  <div><dt>Fristbeginn</dt><dd>{dt(w.deadline_start_at)}</dd></div>
                  <div><dt>Frist bis</dt><dd>{String(w.deadline_date ?? "–")}</dd></div>
                  <div><dt>Fristgrundlage</dt><dd>{String(w.deadline_basis ?? "–")}</dd></div>
                  <div><dt>Status Frist</dt><dd>{TIMELINESS_LABEL[String(w.timeliness)] ?? String(w.timeliness)}</dd></div>
                  <div><dt>Fallstatus</dt><dd>{String(w.case_state)}</dd></div>
                  <div><dt>Plan</dt><dd>{String(p.schedule_model ?? "–")} · {String(p.delivery_count ?? "–")} Lieferungen</dd></div>
                  <div><dt>Gezahlt</dt><dd>{euro(p.total_gross_cents)}</dd></div>
                  <div><dt>Regulärer Preis (Snapshot)</dt><dd>{euro(p.catalog_unit_gross_cents)}</dd></div>
                  <div><dt>Bestellsumme</dt><dd>{euro(o.total_gross_cents)}</dd></div>
                  <div><dt>Positionen</dt><dd>{
                    items.length === 0
                      ? "–"
                      : items.length === 1
                        ? `${String(items[0].product_name ?? "?")} × ${String(items[0].quantity ?? "?")}`
                        : `${items.length} Positionen – Wertersatz nur manuell`
                  }</dd></div>
                  <div><dt>Warenwert (Snapshot)</dt><dd>{
                    items.length === 1
                      ? euro(Number(items[0].unit_price_gross_cents ?? 0) * Number(items[0].quantity ?? 0))
                      : "–"
                  }</dd></div>
                  <div><dt>Siegel</dt><dd>{String(w.seal_state ?? "–")}</dd></div>
                  <div><dt>Rücksendung</dt><dd>{String(w.return_requirement ?? "–")}</dd></div>
                  <div><dt>Versandnachweis</dt><dd>{dt(w.return_dispatch_proof_at)}</dd></div>
                  <div><dt>Rücksendung erhalten</dt><dd>{dt(w.return_received_at)}</dd></div>
                  <div><dt>Wertersatz Vorschlag</dt><dd>{euro(w.suggested_value_loss_cents)}</dd></div>
                  <div><dt>Wertersatz bestätigt</dt><dd>{euro(w.confirmed_value_loss_cents)}</dd></div>
                  <div><dt>Erstattung</dt><dd>{euro(w.refund_amount_cents)}</dd></div>
                  <div><dt>Erstattungsstatus</dt><dd>{String(w.refund_state)}</dd></div>
                  <div><dt>Zugeordnete Position</dt><dd>{
                    w.resolved_order_item_id
                      ? `${String(resolvedItem?.product_name ?? "?")} × ${String(w.resolved_item_quantity ?? "?")}`
                      : "– (nicht zugeordnet)"
                  }</dd></div>
                  <div><dt>Versandkosten (Teilwiderruf)</dt><dd>{
                    String(w.partial_shipping_treatment ?? "–")
                  }</dd></div>
                  <div><dt>Zuordnung am</dt><dd>{dt(w.item_resolution_at)}</dd></div>
                  <div><dt>Auszahlungsreferenz</dt><dd>{String(w.refund_provider_reference ?? "–")}</dd></div>
                  <div><dt>Erstattungsmail</dt><dd>{String(w.refund_completed_email_status ?? "–")}</dd></div>
                  <div><dt>Erstattungsmail am</dt><dd>{dt(w.refund_completed_email_sent_at)}</dd></div>
                  <div><dt>Ausgezahlt am</dt><dd>{dt(w.refund_executed_at)}</dd></div>
                  <div><dt>Auszahlungsfehler</dt><dd>{String(w.refund_failure_reason ?? "–")}</dd></div>
                  <div><dt>Lieferungen eingefroren</dt><dd>{dt(w.deliveries_frozen_at)}</dd></div>
                  <div><dt>Lieferungen endgültig gestoppt</dt><dd>{dt(w.deliveries_permanently_stopped_at)}</dd></div>
                  <div><dt>Interne Notiz</dt><dd>{String(w.internal_note ?? "–")}</dd></div>
                </dl>

                <div className="ops-actions">
                  <button type="button" disabled={busy}
                    onClick={() => void act({ action: "set_seal_state", withdrawalId: id, sealState: "sealed_unopened" }, "Siegel")}>
                    Originalversiegelt / ungeöffnet
                  </button>
                  <button type="button" disabled={busy}
                    onClick={() => void act({ action: "set_seal_state", withdrawalId: id, sealState: "opened_seal_broken" }, "Siegel")}>
                    Geöffnet / Siegel gebrochen
                  </button>
                  <button type="button" disabled={busy}
                    onClick={() => void act({ action: "set_return_requirement", withdrawalId: id, requirement: "return_requested" }, "Rücksendung")}>
                    Rücksendung angefordert
                  </button>
                  <button type="button" disabled={busy}
                    onClick={() => void act({ action: "set_return_requirement", withdrawalId: id, requirement: "return_not_required" }, "Rücksendung")}>
                    Rücksendung nicht nötig
                  </button>
                  <button type="button" disabled={busy}
                    onClick={() => void act({ action: "record_return", withdrawalId: id, event: "dispatch_proof" }, "Versandnachweis")}>
                    Versandnachweis erhalten
                  </button>
                  <button type="button" disabled={busy}
                    onClick={() => void act({ action: "record_return", withdrawalId: id, event: "received" }, "Rücksendung")}>
                    Rücksendung erhalten
                  </button>
                  {/* WHICH GOODS. The only structured way to say it, and the
                      only basis a partial refund is ever computed from. */}
                  <label>Position
                    <select id={`ri-${id}`} defaultValue={String(w.resolved_order_item_id ?? "")}>
                      <option value="">– wählen –</option>
                      {items.map(i => (
                        <option key={String(i.id)} value={String(i.id)}>
                          {String(i.product_name ?? "?")} (× {String(i.quantity ?? "?")})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>Menge
                    <input type="number" min={1} step={1} id={`rq-${id}`}
                           defaultValue={String(w.resolved_item_quantity ?? 1)}/>
                  </label>
                  {isPartial && (
                    <label>Versandkosten
                      <select id={`rs-${id}`}
                              defaultValue={String(w.partial_shipping_treatment ?? "")}>
                        <option value="">– wählen –</option>
                        <option value="refund_outbound_shipping">Hinversand erstatten</option>
                        <option value="retain_outbound_shipping">Hinversand behalten</option>
                      </select>
                    </label>
                  )}
                  <button type="button" disabled={busy}
                    onClick={() => {
                      const sel = document.getElementById(`ri-${id}`) as HTMLSelectElement | null;
                      const qty = document.getElementById(`rq-${id}`) as HTMLInputElement | null;
                      const shp = document.getElementById(`rs-${id}`) as HTMLSelectElement | null;
                      void act({ action: "resolve_item", withdrawalId: id,
                                 orderItemId: sel?.value ?? "",
                                 quantity: Number(qty?.value ?? 1),
                                 shippingTreatment: shp?.value ?? "" }, "Zuordnung");
                    }}>
                    Position zuordnen
                  </button>
                  <label>Wertersatz (Cent)
                    <input type="number" min={0} step={1} id={`vl-${id}`} defaultValue={0}/>
                  </label>
                  <button type="button" disabled={busy}
                    onClick={() => {
                      const el = document.getElementById(`vl-${id}`) as HTMLInputElement | null;
                      void act({ action: "confirm_value_loss", withdrawalId: id,
                                 confirmedCents: Number(el?.value ?? 0) }, "Wertersatz");
                    }}>
                    Wertersatz bestätigen
                  </button>
                  {/* NO AMOUNT IS SENT. The server derives it. */}
                  <button type="button" disabled={busy}
                    onClick={() => void act({ action: "approve_refund", withdrawalId: id }, "Erstattung")}>
                    Erstattung vorbereiten
                  </button>
                  {/* THE ONLY BUTTON ON THIS SCREEN THAT REACHES STRIPE. */}
                  <button type="button" className="ops-danger"
                    disabled={busy || w.refund_state !== "approved_for_payout" && w.refund_state !== "failed"}
                    onClick={() => void payout(id)}>
                    Erstattung auszahlen
                  </button>
                  {/* MAIL ONLY. No payment provider is reached by this. */}
                  <button type="button"
                    disabled={busy || w.refund_state !== "executed"
                              || w.refund_completed_email_status === "sent"}
                    onClick={() => void retryMail(id)}>
                    Erstattungsmail erneut senden
                  </button>
                </div>
                <p className="ops-note">
                  Bei einem <strong>Teilwiderruf</strong> muss zuerst die Position zugeordnet
                  werden – sonst wird nichts freigegeben. Die Erstattung wird dann aus dem
                  historischen Positionspreis berechnet, niemals aus der Bestellsumme.
                  Bei <strong>Menge &gt; 1</strong> und geöffneter Ware bleibt der Wertersatz
                  bewusst manuell: ein einziger Siegelstatus kann nicht zwei Packungen beschreiben.
                </p>
                <p className="ops-note">
                  „Erstattung vorbereiten“ berechnet den Betrag serverseitig, gibt ihn frei und
                  stoppt die Lieferungen dieses Vertrags endgültig – und verschickt keine Mail.
                  „Erstattung auszahlen“ ist der getrennte Schritt, der das Geld bei Stripe bewegt –
                  mit derselben Vorgangs-ID als Idempotenzschlüssel, sodass ein zweiter Klick keine
                  zweite Erstattung auslöst – und erst danach geht „Erstattung durchgeführt“ an die
                  Kundin oder den Kunden. Scheitert nur die Mail, bleibt die Erstattung bestehen
                  und „Erstattungsmail erneut senden“ wiederholt ausschließlich die Mail.
                </p>
              </article>
            );
          })}
        </div>
      )}

      {/* ── REKLAMATION ────────────────────────────────────────── */}
      {section === "reklamation" && (
        <div className="ops-list">
          {data.complaints.length === 0 && <p>Keine Reklamationen.</p>}
          {data.complaints.filter(visibleCase).map(c => {
            const id = String(c.id);
            return (
              <article key={id} className="ops-card">
                <h3>{String(c.customer_name)} · {String(c.order_reference)}</h3>
                <dl className="ops-facts">
                  <div><dt>E-Mail</dt><dd>{String(c.contact_email)}</dd></div>
                  <div><dt>Grund</dt><dd>{String(c.reason)}</dd></div>
                  <div><dt>Beschreibung</dt><dd>{String(c.customer_note ?? "–")}</dd></div>
                  <div><dt>Eingegangen</dt><dd>{dt(c.submitted_at)}</dd></div>
                  <div><dt>Status</dt><dd>{String(c.case_state)}</dd></div>
                  <div><dt>Rücksendekosten</dt>
                       <dd>{c.seller_bears_transport_cost ? "GLOA trägt sie (§ 439 Abs. 2 BGB)" : "–"}</dd></div>
                </dl>
                <div className="ops-actions">
                  {["under_review", "evidence_requested", "remedy_offered",
                    "replacement_sent", "refunded", "rejected", "closed"].map(s => (
                    <button key={s} type="button" disabled={busy}
                      onClick={() => void act({ action: "advance_complaint", complaintId: id, caseState: s }, "Reklamation")}>
                      {s}
                    </button>
                  ))}
                </div>
                <p className="ops-note">
                  Eine Reklamation ist kein Widerruf: kein Wertersatz, und die Rücksendekosten trägt GLOA.
                </p>
              </article>
            );
          })}
        </div>
      )}

      {/* ── KÜNDIGUNG ──────────────────────────────────────────── */}
      {section === "kuendigung" && (
        <div className="ops-list">
          {data.terminations.length === 0 && <p>Keine Kündigungen.</p>}
          {data.terminations.filter(visibleCase).map(t => {
            const id = String(t.id);
            return (
              <article key={id} className="ops-card">
                <h3>{String(t.customer_name)} · {String(t.contract_reference)}</h3><p className="portal-note">{t.resolved_annual_plan_id?(t.termination_kind==='extraordinary'?'Außerordentliche Jahresplan-Kündigung':'Ordentliche Jahresplan-Kündigung'):t.resolved_subscription_id?'Öffentliche Vertragskündigung eines 4-Wochen-Abos':'Öffentliche Vertragskündigung: Zuordnung offen'}</p>
                <dl className="ops-facts">
                  <div><dt>E-Mail</dt><dd>{String(t.contact_email)}</dd></div>
                  <div><dt>Art</dt><dd>{t.termination_kind === "extraordinary" ? "außerordentlich" : "ordentlich"}</dd></div>
                  <div><dt>Vertragsart</dt><dd>{String(t.contract_kind ?? "–")}</dd></div>
                  <div><dt>Gewünschtes Ende</dt><dd>{dt(t.requested_end_at)}</dd></div>
                  <div><dt>Grund</dt><dd>{String(t.extraordinary_reason ?? "–")}</dd></div>
                  <div><dt>Eingegangen</dt><dd>{dt(t.submitted_at)}</dd></div>
                  <div><dt>Entscheidungsstatus</dt><dd><Chip value={t.case_state}/></dd></div><div><dt>Refund</dt><dd>Separate Entscheidung, keine automatische Erstattung</dd></div><div><dt>Interne Notiz</dt><dd>{String(t.internal_note??"nicht erfasst")}</dd></div>
                </dl>
                {(typeof t.resolved_annual_plan_id==='string'||typeof t.resolved_subscription_id==='string')&&<><button type="button" onClick={()=>setContextId(contextId===id?null:id)}>Vertrag und Aktivität öffnen</button>{contextId===id&&<BusinessContext entity={t.resolved_annual_plan_id?'annual_plan':'subscription'} id={String(t.resolved_annual_plan_id??t.resolved_subscription_id)}/>}</>}
                <label>Interne Entscheidungsnotiz<textarea rows={2} maxLength={4000} value={terminationNotes[id]??String(t.internal_note??'')} onChange={e=>setTerminationNotes(current=>({...current,[id]:e.target.value}))}/></label>
                <div className="ops-actions">
                  {t.resolved_annual_plan_id ? (t.termination_kind === "extraordinary" ? [
                    ["accept_extraordinary", "Außerordentlich annehmen"], ["reject_extraordinary", "Ablehnen"], ["close", "Fall schließen"]
                  ] : [["note_ordinary", "Kündigung vormerken"], ["close", "Fall schließen"]]).map(([decision,title]) => (
                    <button key={decision} type="button" disabled={busy} onClick={() => {
                      if(window.confirm(decision==='accept_extraordinary'?'Plan beenden und zukünftige offene Lieferungen stoppen? Es wird keine Erstattung ausgelöst.':'Entscheidung verbindlich speichern?'))
                        void act({action:"decide_annual_termination",terminationId:id,decision,internalNote:terminationNotes[id]},"Kündigung");
                    }}>{title}</button>
                  )) : t.resolved_subscription_id ? <button type="button" disabled={busy} onClick={() => {
                    if(window.confirm('Öffentliche Vertragskündigung verbindlich ausführen? Der Server bestimmt das wirksame Ende.'))
                      void act({action:"execute_subscription_termination",terminationId:id},"Vertragskündigung");
                  }}>Vertragskündigung ausführen</button> : <p className="ops-note">Vertrag noch nicht eindeutig zugeordnet. Keine Vertragswirkung ausführbar.</p>}

                </div>
                <p className="ops-note">
                  Kündigung und Erstattung sind getrennte Entscheidungen. Bei ordentlicher Jahreskündigung laufen bezahlte Lieferungen bis zum regulären Vertragsende weiter. Die öffentliche Vertragskündigung ist vom normalen Kündigungsweg im Kundenkonto getrennt.
                </p>
              </article>
            );
          })}
        </div>
      )}

      {/* ── KAUFSPERREN ────────────────────────────────────────── */}
      {section === "sperren" && (
        <div className="ops-list">
          <form className="ops-card" onSubmit={e => {
            e.preventDefault();
            const f = new FormData(e.currentTarget as HTMLFormElement);
            void act({
              action: "create_restriction",
              userId: String(f.get("userId") ?? ""),
              scope: String(f.get("scope") ?? ""),
              reasonCategory: String(f.get("reasonCategory") ?? ""),
              internalNote: String(f.get("internalNote") ?? ""),
              expiresAt: String(f.get("expiresAt") ?? ""),
            }, "Kaufsperre");
          }}>
            <h3>Kaufsperre setzen</h3>
            <label>Kunden-ID (user_id)<input required name="userId"/></label>
            <label>Bereich
              <select name="scope" defaultValue="annual_plan">
                <option value="annual_plan">Jahresplan</option>
                <option value="recurring_subscription">Abo (4 Wochen)</option>
                <option value="all_new_plan_purchases">Alle neuen Pläne</option>
              </select>
            </label>
            <label>Grundkategorie
              <select name="reasonCategory" defaultValue="manual_review">
                <option value="repeated_withdrawal_pattern">Wiederholtes Widerrufsmuster</option>
                <option value="payment_abuse">Zahlungsmissbrauch</option>
                <option value="chargeback_history">Chargeback-Historie</option>
                <option value="manual_review">Manuelle Prüfung</option>
                <option value="other">Sonstiges</option>
              </select>
            </label>
            <label>Interne Notiz<textarea name="internalNote" rows={3} maxLength={4000}/></label>
            <label>Läuft ab am (optional)<input type="datetime-local" name="expiresAt"/></label>
            <button type="submit" disabled={busy}>Sperre setzen</button>
            <p className="ops-note">
              Sperren entstehen nur hier, von Hand. Ein Widerruf allein erzeugt nie eine Sperre.
              Gesperrte Kundinnen und Kunden können sich weiterhin anmelden, alte Bestellungen sehen,
              widerrufen, reklamieren, kündigen und Erstattungen erhalten.
            </p>
          </form>

          {data.restrictions.map(r => {
            const id = String(r.id);
            return (
              <article key={id} className="ops-card">
                <h3>{String(r.user_id)}</h3>
                <dl className="ops-facts">
                  <div><dt>Bereich</dt><dd>{String(r.scope)}</dd></div>
                  <div><dt>Grund</dt><dd>{String(r.reason_category)}</dd></div>
                  <div><dt>Notiz</dt><dd>{String(r.internal_note ?? "–")}</dd></div>
                  <div><dt>Gesetzt</dt><dd>{dt(r.created_at)}</dd></div>
                  <div><dt>Läuft ab</dt><dd>{dt(r.expires_at)}</dd></div>
                  <div><dt>Aktiv</dt><dd>{r.active ? "ja" : `nein (aufgehoben ${dt(r.lifted_at)})`}</dd></div>
                </dl>
                {Boolean(r.active) && (
                  <div className="ops-actions">
                    <button type="button" disabled={busy}
                      onClick={() => void act({ action: "lift_restriction", restrictionId: id }, "Kaufsperre")}>
                      Sperre aufheben
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
