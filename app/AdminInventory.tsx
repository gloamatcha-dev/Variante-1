"use client";
import { useCallback, useEffect, useState } from "react";
import {
  AREA_LABEL,
  INVENTORY_AREAS,
  MOVEMENT_REASON_LABEL,
  MOVEMENT_REASONS,
  MOVEMENT_TYPE_LABEL,
  REASONS_FOR_TYPE,
  STOCK_STATUSES,
  STOCK_STATUS_LABEL,
  formatDelta,
  formatQuantity,
  parseQuantity,
  stockStatus,
  type InventoryArea,
  type MovementReason,
  type RequestableMovementType,
  type StockStatus,
} from "../lib/inventoryRules";

/**
 * THE INVENTORY, AND EVERY NUMBER IN IT HAS A ROW BEHIND IT.
 *
 * ── MANUAL, ON PURPOSE ────────────────────────────────────────
 *
 * Nothing on this screen happens because an order did something.
 * Shipping removes nothing, a refund returns nothing, a new order
 * reserves nothing. Stock moves because somebody counted, packed or
 * unpacked and then typed it in. Joining the two is a later, deliberate
 * decision; guessing at it now would produce a stock figure nobody
 * trusts and everybody has to check by hand anyway.
 *
 * ── AND NO PRICE FIELD EITHER ─────────────────────────────────
 *
 * Nothing on this screen asks what something cost, and nothing displays
 * it. Money belongs to accounting and arrives with its own package -
 * what an operator needs here is where a batch came from and when it
 * stops being usable, which is why supplier, batch and best-before
 * stayed.
 *
 * ── THERE IS NO STOCK FIELD ───────────────────────────────────
 *
 * The edit form has a name, a SKU, a category, a unit, areas, a
 * threshold, a supplier and a note - and no quantity. Stock
 * changes through a receipt, a withdrawal, a correction or a count, each
 * of which writes a row saying what changed and what it left behind.
 * That is not a UI convention: migration 050 grants the server no UPDATE
 * on the quantity column at all.
 *
 * ── NOTHING IS ASSUMED TO HAVE WORKED ─────────────────────────
 *
 * No optimistic state anywhere. A form goes busy, the server answers,
 * and only then does the screen change - by re-reading, not by patching
 * a local copy. Every booking carries an operation id chosen before the
 * request, so a double click, a retry and a lost response are one
 * movement.
 */

type Item = {
  id: string;
  name: string;
  sku: string | null;
  category_id: string;
  unit: string;
  current_quantity: number | string | null;
  low_stock_threshold: number | string | null;
  supplier: string | null;
  notes: string | null;
  is_active: boolean;
  updated_at: string;
};

type Category = { id: string; name: string; is_active: boolean };

type Movement = {
  id: string;
  quantity_delta: number | string;
  balance_after: number | string;
  movement_type: string;
  reason: string;
  area: string | null;
  note: string | null;
  reference: string | null;
  supplier: string | null;
  batch_number: string | null;
  best_before_date: string | null;
  occurred_at: string;
  actor_email: string | null;
};

type ItemsPayload = {
  rows: Item[];
  areasByItem: Record<string, InventoryArea[]>;
  lastMovementByItem: Record<string, string>;
  categories: Category[];
  total: number;
  page: number;
  pageSize: number;
  summary: { total: number | null; low: number | null; out: number | null; negative: number | null };
  fetchedAt: string;
};

type Detail = { item: Item; areas: InventoryArea[]; movements: Movement[]; categories: Category[] };

type Query = {
  area: InventoryArea | "all";
  status: StockStatus | "all";
  categoryId: string;
  archived: "active" | "archived" | "all";
  search: string;
  page: number;
};

/** A fresh id per intended booking. The browser's half of idempotency. */
const newOperationId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function post(path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data };
}

export function AdminInventory({ onSessionLost }: { onSessionLost: () => void }) {
  const [data, setData] = useState<ItemsPayload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);

  const [area, setArea] = useState<InventoryArea | "all">("all");
  const [status, setStatus] = useState<StockStatus | "all">("all");
  const [categoryId, setCategoryId] = useState("all");
  const [archived, setArchived] = useState<"active" | "archived" | "all">("active");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [creating, setCreating] = useState(false);

  // NOTHING IS SET BEFORE THE FIRST AWAIT. A synchronous setState inside
  // an effect starts a cascading render, so the query travels as an
  // argument and the busy flag belongs to the button that raised it.
  const load = useCallback(async (query: Query, cancelled: () => boolean = () => false) => {
    try {
      const res = await fetch("/api/admin/inventory/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(query),
      });
      if (cancelled()) return;
      if (res.status === 401) { onSessionLost(); return; }
      if (!res.ok) { setLoadError("Das Inventar konnte nicht geladen werden."); return; }
      const payload = (await res.json()) as ItemsPayload;
      if (cancelled()) return;
      setData(payload);
      setLoadError("");
    } catch {
      if (!cancelled()) setLoadError("Das Inventar konnte nicht geladen werden.");
    }
  }, [onSessionLost]);

  const query: Query = { area, status, categoryId, archived, search, page };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await load({ area, status, categoryId, archived, search, page }, () => cancelled);
    })();
    return () => { cancelled = true; };
  }, [load, area, status, categoryId, archived, search, page]);

  const refresh = useCallback(async (q: Query) => {
    setBusy(true);
    try { await load(q); } finally { setBusy(false); }
  }, [load]);

  const openItem = useCallback(async (id: string) => {
    setOpenId(id);
    setDetail(null);
    setDetailError("");
    try {
      const { status: code, data: body } = await post("/api/admin/inventory/items/detail", { id });
      if (code === 401) { onSessionLost(); return; }
      if (code === 404) { setDetailError("Diesen Artikel gibt es nicht mehr."); return; }
      if (code !== 200) { setDetailError("Der Artikel konnte nicht geladen werden."); return; }
      setDetail(body as unknown as Detail);
    } catch {
      setDetailError("Der Artikel konnte nicht geladen werden.");
    }
  }, [onSessionLost]);

  const closeDetail = useCallback(() => { setOpenId(null); setDetail(null); setDetailError(""); }, []);

  useEffect(() => {
    if (!openId && !creating) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (creating) setCreating(false);
      else closeDetail();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openId, creating, closeDetail]);

  // AFTER A BOOKING THE SERVER IS ASKED AGAIN - both for the open item
  // and for the page behind it. Nothing is patched locally: an operator
  // who just booked a withdrawal must see what the item actually says
  // now, not what this tab predicted it would say.
  const reloadAll = useCallback(async () => {
    const id = openId;
    await load({ area, status, categoryId, archived, search, page });
    if (!id) return;
    try {
      const { status: code, data: body } = await post("/api/admin/inventory/items/detail", { id });
      if (code === 401) { onSessionLost(); return; }
      if (code === 200) setDetail(body as unknown as Detail);
    } catch {
      // The booking already succeeded and said so. A failed re-read is
      // not a failed booking.
    }
  }, [load, openId, area, status, categoryId, archived, search, page, onSessionLost]);

  const reset = (next: Partial<Query>) => {
    if (next.area !== undefined) setArea(next.area);
    if (next.status !== undefined) setStatus(next.status);
    if (next.categoryId !== undefined) setCategoryId(next.categoryId);
    if (next.archived !== undefined) setArchived(next.archived);
    if (next.search !== undefined) setSearch(next.search);
    setPage(1);
  };

  if (loadError && !data) {
    return (
      <section className="ops-panel">
        <p className="ops-error" role="alert">{loadError}</p>
        <button type="button" className="ops-refresh" onClick={() => void refresh(query)}>Erneut versuchen</button>
      </section>
    );
  }
  if (!data) return <p className="ops-loading">Wird geladen…</p>;

  const categories = data.categories.filter(c => c.is_active || c.id === categoryId);
  const filtered = area !== "all" || status !== "all" || categoryId !== "all" || archived !== "active" || search !== "";
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <>
      <section className="ops-summary">
        <div><dt>Artikel</dt><dd>{data.summary.total ?? "—"}</dd></div>
        <div><dt>Niedriger Bestand</dt><dd>{data.summary.low ?? "—"}</dd></div>
        <div><dt>Nicht verfügbar</dt><dd>{data.summary.out ?? "—"}</dd></div>
        <div><dt>Negativ</dt><dd className={(data.summary.negative ?? 0) > 0 ? "ops-open-refund" : undefined}>
          {data.summary.negative ?? "—"}</dd></div>
      </section>

      <div className="ops-refresh-bar">
        <button type="button" className="ops-btn ops-btn-primary" onClick={() => setCreating(true)}>
          Artikel hinzufügen
        </button>
        <button type="button" className="ops-refresh" onClick={() => void refresh(query)} disabled={busy}>
          {busy ? "Wird aktualisiert…" : "Aktualisieren"}
        </button>
        <span className="ops-refresh-at">Zuletzt aktualisiert {fmtDateTime(data.fetchedAt)}</span>
        {loadError && <span className="ops-error" role="alert">{loadError}</span>}
      </div>

      <section className="ops-filter-row" aria-label="Filter">
        <div>
          <label htmlFor="inv-area">Bereich</label>
          <select id="inv-area" value={area} onChange={e => reset({ area: e.target.value as InventoryArea | "all" })}>
            <option value="all">Alle</option>
            {INVENTORY_AREAS.map(a => <option key={a} value={a}>{AREA_LABEL[a]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="inv-status">Bestand</label>
          <select id="inv-status" value={status} onChange={e => reset({ status: e.target.value as StockStatus | "all" })}>
            <option value="all">Alle</option>
            {STOCK_STATUSES.map(s => <option key={s} value={s}>{STOCK_STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="inv-category">Kategorie</label>
          <select id="inv-category" value={categoryId} onChange={e => reset({ categoryId: e.target.value })}>
            <option value="all">Alle</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="inv-archived">Status</label>
          <select id="inv-archived" value={archived}
            onChange={e => reset({ archived: e.target.value as "active" | "archived" | "all" })}>
            <option value="active">Aktiv</option>
            <option value="archived">Archiviert</option>
            <option value="all">Alle</option>
          </select>
        </div>
        <form className="ops-search" onSubmit={e => { e.preventDefault(); reset({ search: searchInput }); }}>
          <label htmlFor="inv-search">Suche</label>
          <input id="inv-search" type="search" placeholder="Artikel, SKU oder Lieferant"
            value={searchInput} onChange={e => setSearchInput(e.target.value)} />
          <button type="submit">Suchen</button>
        </form>
      </section>

      {data.rows.length === 0 ? (
        <section className="ops-empty-state">
          {filtered ? (
            <>
              <h3>Kein Artikel passt zu diesem Filter.</h3>
              <p>Setze die Filter zurück, um alle Artikel zu sehen.</p>
            </>
          ) : (
            <>
              <h3>Dein Inventar ist noch leer.</h3>
              <p>
                Lege deinen ersten Artikel an, um Bestände und Bewegungen zu verwalten.
                Jede Änderung wird als Bewegung festgehalten – der Bestand lässt sich nicht
                einfach überschreiben.
              </p>
              <button type="button" className="ops-btn ops-btn-primary" onClick={() => setCreating(true)}>
                Artikel hinzufügen
              </button>
            </>
          )}
        </section>
      ) : (
        <div className="ops-table-wrap">
          <table className="ops-table ops-inventory">
            <thead>
              <tr>
                <th scope="col">Artikel</th>
                <th scope="col">Kategorie</th>
                <th scope="col">Bereich</th>
                <th scope="col">Bestand</th>
                <th scope="col">Mindestbestand</th>
                <th scope="col">Status</th>
                <th scope="col">Letzte Bewegung</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map(item => {
                const s = stockStatus(item);
                const areas = data.areasByItem[item.id] ?? [];
                const category = data.categories.find(c => c.id === item.category_id);
                return (
                  <tr key={item.id} className="ops-order-row" onClick={() => void openItem(item.id)}>
                    <td data-label="Artikel">
                      <button type="button" className="ops-order-open"
                        onClick={e => { e.stopPropagation(); void openItem(item.id); }}>{item.name}</button>
                      {item.sku && <span className="ops-mail">{item.sku}</span>}
                      {!item.is_active && <span className="ops-flag ops-flag-cancel">Archiviert</span>}
                    </td>
                    <td data-label="Kategorie">{category?.name ?? "—"}</td>
                    <td data-label="Bereich">
                      {areas.length ? areas.map(a => AREA_LABEL[a]).join(" · ") : "—"}
                    </td>
                    <td data-label="Bestand">
                      <span className="ops-order-name">{formatQuantity(item.current_quantity)} {item.unit}</span>
                    </td>
                    <td data-label="Mindestbestand">
                      {item.low_stock_threshold === null ? "—" : `${formatQuantity(item.low_stock_threshold)} ${item.unit}`}
                    </td>
                    <td data-label="Status">
                      <span className={`ops-status ops-stock-${s}`}>{STOCK_STATUS_LABEL[s]}</span>
                    </td>
                    <td data-label="Letzte Bewegung">{fmtDate(data.lastMovementByItem[item.id])}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data.rows.length > 0 && (
        <nav className="ops-pager" aria-label="Seiten">
          <button type="button" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>Zurück</button>
          <span>Seite {data.page} von {totalPages} · {data.total} Artikel</span>
          <button type="button" disabled={data.page >= totalPages} onClick={() => setPage(data.page + 1)}>Weiter</button>
        </nav>
      )}

      {creating && (
        <ItemDialog
          categories={data.categories.filter(c => c.is_active)}
          onClose={() => setCreating(false)}
          onSaved={async () => { setCreating(false); await refresh(query); }}
          onSessionLost={onSessionLost}
        />
      )}

      {openId && (
        <div className="ops-drawer-backdrop">
          <button type="button" className="ops-drawer-scrim" onClick={closeDetail} aria-label="Artikel schließen" />
          <aside className="ops-drawer" role="dialog" aria-modal="true" aria-label="Artikeldetails">
            <header className="ops-drawer-head">
              <h2>{detail?.item.name ?? "Artikel"}</h2>
              <button type="button" className="ops-drawer-close" onClick={closeDetail} aria-label="Schließen">×</button>
            </header>
            {detailError && <p className="ops-error" role="alert">{detailError}</p>}
            {!detail && !detailError && <p className="ops-loading">Wird geladen…</p>}
            {detail && <ItemDetail detail={detail} onDone={reloadAll} onSessionLost={onSessionLost} />}
          </aside>
        </div>
      )}
    </>
  );
}

/* ══════════════════════════════════════════════════════════════
   THE DETAIL
   ══════════════════════════════════════════════════════════════ */

type Mode = null | "receipt" | "withdrawal" | "correction" | "stocktake" | "edit";

function ItemDetail({
  detail, onDone, onSessionLost,
}: { detail: Detail; onDone: () => Promise<void>; onSessionLost: () => void }) {
  const [mode, setMode] = useState<Mode>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const item = detail.item;
  const s = stockStatus(item);
  const category = detail.categories.find(c => c.id === item.category_id);

  async function archive(next: boolean) {
    if (busy) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const { status, data } = await post("/api/admin/inventory/items/archive",
        { itemId: item.id, isActive: next });
      if (status === 401) { onSessionLost(); return; }
      if (status !== 200) {
        setError(typeof data.error === "string" ? data.error : "Die Aktion ist fehlgeschlagen.");
        return;
      }
      setResult(next ? "Der Artikel ist wieder aktiv." : "Der Artikel ist archiviert. Die Historie bleibt erhalten.");
      await onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {result && <p className="ops-action-ok" role="status">{result}</p>}
      {error && <p className="ops-error" role="alert">{error}</p>}

      <Facts title="Artikel" rows={[
        ["Name", item.name],
        ["SKU", item.sku || "—"],
        ["Kategorie", category?.name ?? "—"],
        ["Einheit", item.unit],
        ["Status", item.is_active ? "Aktiv" : "Archiviert"],
      ]} />

      <Facts title="Bestand" rows={[
        ["Aktuell", <strong key="q">{formatQuantity(item.current_quantity)} {item.unit}</strong>],
        ["Mindestbestand", item.low_stock_threshold === null
          ? "—" : `${formatQuantity(item.low_stock_threshold)} ${item.unit}`],
        ["Status", <span key="s" className={`ops-status ops-stock-${s}`}>{STOCK_STATUS_LABEL[s]}</span>],
      ]} />

      <Facts title="Zuordnung" rows={[
        ["Bereiche", detail.areas.length ? detail.areas.map(a => AREA_LABEL[a]).join(" · ") : "—"],
      ]} />

      {/* Where it came from and what was noted about it. NOT what it
          cost: that is accounting's, and a price shown here would invite
          somebody to treat this screen as a spend report. */}
      <Facts title="Beschaffung" rows={[
        ["Lieferant", item.supplier || "—"],
        ["Notiz", item.notes || "—"],
      ]} />

      <section className="ops-actions" aria-label="Aktionen">
        {mode === null && (
          <div className="ops-action-block">
            <h4>Aktionen</h4>
            <div className="ops-action-buttons">
              <button type="button" className="ops-btn ops-btn-primary" disabled={busy}
                onClick={() => { setMode("receipt"); setResult(null); setError(null); }}>Wareneingang</button>
              <button type="button" className="ops-btn" disabled={busy}
                onClick={() => { setMode("withdrawal"); setResult(null); setError(null); }}>Entnahme</button>
              <button type="button" className="ops-btn" disabled={busy}
                onClick={() => { setMode("stocktake"); setResult(null); setError(null); }}>Inventur</button>
              <button type="button" className="ops-btn" disabled={busy}
                onClick={() => { setMode("correction"); setResult(null); setError(null); }}>Korrektur</button>
              <button type="button" className="ops-btn" disabled={busy}
                onClick={() => { setMode("edit"); setResult(null); setError(null); }}>Artikel bearbeiten</button>
              <button type="button" className="ops-btn" disabled={busy}
                onClick={() => void archive(!item.is_active)}>
                {item.is_active ? "Archivieren" : "Wieder aktivieren"}
              </button>
            </div>
            {item.is_active && Number(item.current_quantity) !== 0 && (
              <p className="ops-action-note">
                Dieser Artikel hat noch Bestand ({formatQuantity(item.current_quantity)} {item.unit}).
                Beim Archivieren bleibt der Bestand stehen und die Historie erhalten.
              </p>
            )}
          </div>
        )}

        {mode !== null && mode !== "edit" && (
          <MovementForm
            item={item}
            mode={mode}
            onCancel={() => setMode(null)}
            onDone={async message => { setMode(null); setResult(message); await onDone(); }}
            onSessionLost={onSessionLost}
          />
        )}

        {mode === "edit" && (
          <ItemForm
            item={item}
            areas={detail.areas}
            categories={detail.categories.filter(c => c.is_active || c.id === item.category_id)}
            onCancel={() => setMode(null)}
            onDone={async () => { setMode(null); setResult("Der Artikel wurde gespeichert."); await onDone(); }}
            onSessionLost={onSessionLost}
          />
        )}
      </section>

      <section className="ops-drawer-section">
        <h3>Bewegungshistorie</h3>
        {detail.movements.length === 0 ? (
          <p className="ops-note">Für diesen Artikel wurde noch keine Bewegung gebucht.</p>
        ) : (
          <table className="ops-table ops-items ops-movements">
            <thead>
              <tr>
                <th scope="col">Datum</th>
                <th scope="col">Typ</th>
                <th scope="col">Grund</th>
                <th scope="col">Änderung</th>
                <th scope="col">Bestand danach</th>
              </tr>
            </thead>
            <tbody>
              {detail.movements.map(m => (
                <tr key={m.id}>
                  <td data-label="Datum">{fmtDate(m.occurred_at)}</td>
                  <td data-label="Typ">{MOVEMENT_TYPE_LABEL[m.movement_type as keyof typeof MOVEMENT_TYPE_LABEL] ?? m.movement_type}</td>
                  <td data-label="Grund">
                    {MOVEMENT_REASON_LABEL[m.reason as MovementReason] ?? m.reason}
                    {m.area && <span className="ops-mail">{AREA_LABEL[m.area as InventoryArea] ?? m.area}</span>}
                    {m.note && <span className="ops-mail">{m.note}</span>}
                    {m.reference && <span className="ops-mail">{m.reference}</span>}
                  </td>
                  <td data-label="Änderung" className={Number(m.quantity_delta) < 0 ? "ops-open-refund" : undefined}>
                    {formatDelta(m.quantity_delta)} {item.unit}
                  </td>
                  <td data-label="Bestand danach">{formatQuantity(m.balance_after)} {item.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="ops-action-note">
          Bewegungen lassen sich nicht ändern oder löschen. Ein Fehler wird mit einer
          Korrekturbuchung richtiggestellt, damit die Historie nachvollziehbar bleibt.
        </p>
      </section>
    </>
  );
}

function Facts({ title, rows }: { title: string; rows: [string, React.ReactNode][] }) {
  return (
    <section className="ops-drawer-section">
      <h3>{title}</h3>
      <dl className="ops-facts ops-facts-tight">
        {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
    </section>
  );
}

/* ══════════════════════════════════════════════════════════════
   BOOKING A MOVEMENT
   ══════════════════════════════════════════════════════════════ */

const MODE_TITLE: Record<string, string> = {
  receipt: "Wareneingang",
  withdrawal: "Entnahme",
  correction: "Korrektur",
  stocktake: "Inventur",
};

function MovementForm({
  item, mode, onCancel, onDone, onSessionLost,
}: {
  item: Item;
  mode: "receipt" | "withdrawal" | "correction" | "stocktake";
  onCancel: () => void;
  onDone: (message: string) => Promise<void>;
  onSessionLost: () => void;
}) {
  const isStocktake = mode === "stocktake";
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState<MovementReason>(
    mode === "receipt" ? "goods_receipt" : mode === "withdrawal" ? "b2c" : "correction"
  );
  const [area, setArea] = useState<InventoryArea | "">(mode === "withdrawal" ? "b2c" : "");
  const [note, setNote] = useState("");
  const [reference, setReference] = useState("");
  const [supplier, setSupplier] = useState(mode === "receipt" ? (item.supplier ?? "") : "");
  const [batchNumber, setBatchNumber] = useState("");
  const [bestBefore, setBestBefore] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [allowNegative, setAllowNegative] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Chosen ONCE per intended booking. A retry presents the same id and
  // the database's unique index turns it into a no-op - which is the
  // guarantee a disabled button cannot give.
  const [operationId, setOperationId] = useState(newOperationId);

  const parsed = parseQuantity(quantity);
  const current = Number(item.current_quantity) || 0;

  const delta = parsed === null ? null
    : isStocktake ? parsed - current
    : mode === "receipt" ? parsed
    : mode === "withdrawal" ? -parsed
    : parsed;
  const balanceAfter = delta === null ? null : isStocktake ? parsed : current + delta;
  const goesNegative = balanceAfter !== null && balanceAfter < 0;

  const valid = parsed !== null &&
    (isStocktake ? parsed >= 0 : mode === "correction" ? parsed !== 0 : parsed > 0);

  async function submit() {
    if (busy || !valid) return;
    setBusy(true); setError(null);
    try {
      const path = isStocktake ? "/api/admin/inventory/stocktake" : "/api/admin/inventory/movement";
      const body = isStocktake
        ? { operationId, itemId: item.id, physicalQuantity: parsed, note: note || null, reference: reference || null }
        : {
            operationId, itemId: item.id, quantity: parsed,
            movementType: mode, reason,
            area: area || null,
            note: note || null, reference: reference || null,
            supplier: mode === "receipt" ? (supplier || null) : null,
            batchNumber: mode === "receipt" ? (batchNumber || null) : null,
            bestBeforeDate: mode === "receipt" ? (bestBefore || null) : null,
            allowNegative,
          };
      const { status, data } = await post(path, body);
      if (status === 401) { onSessionLost(); return; }
      if (status !== 200) {
        setError(typeof data.error === "string" ? data.error : "Die Buchung ist fehlgeschlagen.");
        // A NEW ID FOR A NEW ATTEMPT, but only after a REFUSAL - the
        // booking provably did not happen, so the next try is a new
        // intent rather than a repeat of one that may have landed.
        setOperationId(newOperationId());
        setConfirming(false);
        return;
      }
      const after = data.balanceAfter;
      const repeat = data.result === "already_recorded";
      const unchanged = data.result === "no_change";
      await onDone(
        unchanged ? "Die Zählung entspricht dem Systembestand. Es wurde keine Bewegung gebucht."
          : repeat ? "Diese Buchung war bereits erfasst. Es wurde nichts doppelt gebucht."
          : `Gebucht. Neuer Bestand: ${formatQuantity(typeof after === "number" ? after : null)} ${item.unit}.`
      );
    } catch {
      setError("Die Buchung ist fehlgeschlagen. Bitte erneut versuchen.");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ops-action-block">
      <h4>{MODE_TITLE[mode]}</h4>
      {error && <p className="ops-error" role="alert">{error}</p>}

      <div className="ops-action-fields">
        <label>
          <span>{isStocktake ? `Gezählt (${item.unit})` : `Menge (${item.unit})`}</span>
          <input type="text" inputMode="decimal" value={quantity} disabled={busy || confirming}
            onChange={e => setQuantity(e.target.value)}
            placeholder={isStocktake ? formatQuantity(item.current_quantity) : "z. B. 10000"} />
        </label>

        {!isStocktake && (
          <label>
            <span>Grund</span>
            <select value={reason} disabled={busy || confirming}
              onChange={e => setReason(e.target.value as MovementReason)}>
              {(REASONS_FOR_TYPE[mode as RequestableMovementType] ?? MOVEMENT_REASONS).map(r => (
                <option key={r} value={r}>{MOVEMENT_REASON_LABEL[r]}</option>
              ))}
            </select>
          </label>
        )}

        {!isStocktake && (
          <label>
            <span>Bereich</span>
            <select value={area} disabled={busy || confirming}
              onChange={e => setArea(e.target.value as InventoryArea | "")}>
              <option value="">—</option>
              {INVENTORY_AREAS.map(a => <option key={a} value={a}>{AREA_LABEL[a]}</option>)}
            </select>
          </label>
        )}

        {mode === "receipt" && (
          <>
            <label>
              <span>Lieferant</span>
              <input type="text" value={supplier} maxLength={120} disabled={busy || confirming}
                onChange={e => setSupplier(e.target.value)} placeholder="optional" />
            </label>
            <label>
              <span>Chargennummer</span>
              <input type="text" value={batchNumber} maxLength={80} disabled={busy || confirming}
                onChange={e => setBatchNumber(e.target.value)} placeholder="optional" />
            </label>
            <label>
              <span>Mindestens haltbar bis</span>
              <input type="date" value={bestBefore} disabled={busy || confirming}
                onChange={e => setBestBefore(e.target.value)} />
            </label>
          </>
        )}

        <label>
          <span>Referenz</span>
          <input type="text" value={reference} maxLength={120} disabled={busy || confirming}
            onChange={e => setReference(e.target.value)} placeholder="z. B. Abfüllung 16.09." />
        </label>
        <label>
          <span>Notiz</span>
          <input type="text" value={note} maxLength={500} disabled={busy || confirming}
            onChange={e => setNote(e.target.value)} placeholder="optional" />
        </label>
      </div>

      {parsed !== null && valid && (
        <dl className="ops-facts ops-facts-tight ops-preview">
          <div><dt>Bestand vorher</dt><dd>{formatQuantity(current)} {item.unit}</dd></div>
          <div><dt>Bewegung</dt><dd>{formatDelta(delta)} {item.unit}</dd></div>
          <div><dt>Bestand danach</dt>
            <dd className={goesNegative ? "ops-open-refund" : undefined}>
              {formatQuantity(balanceAfter)} {item.unit}
            </dd></div>
        </dl>
      )}

      {goesNegative && (
        <label className="ops-radio ops-negative-confirm">
          <input type="checkbox" checked={allowNegative} disabled={busy}
            onChange={e => setAllowNegative(e.target.checked)} />
          <span>
            Der Bestand wird nach dieser Buchung negativ ({formatQuantity(balanceAfter)} {item.unit}).
            Das ist zulässig, wenn eine Bewegung verspätet eingetragen wird – bitte ausdrücklich bestätigen.
          </span>
        </label>
      )}

      {confirming ? (
        <div className="ops-confirm" role="alertdialog" aria-label="Bestätigung">
          <ul className="ops-confirm-facts">
            <li>{item.name}</li>
            <li>{MODE_TITLE[mode]}: {formatDelta(delta)} {item.unit}</li>
            <li>Bestand danach: {formatQuantity(balanceAfter)} {item.unit}</li>
            {/* Both halves are named. The default withdrawal reason and the
                default area are both "B2C", and "Grund: B2C · B2C" reads
                like a stutter rather than two different facts. */}
            {!isStocktake && <li>Grund: {MOVEMENT_REASON_LABEL[reason]}</li>}
            {!isStocktake && area && <li>Bereich: {AREA_LABEL[area]}</li>}
            <li>Diese Buchung kann nicht gelöscht werden – Korrekturen erfolgen als neue Bewegung.</li>
          </ul>
          <div className="ops-confirm-buttons">
            <button type="button" className="ops-btn" onClick={() => setConfirming(false)} disabled={busy}>
              Zurück
            </button>
            <button type="button" className="ops-btn ops-btn-primary" onClick={() => void submit()} disabled={busy}>
              {busy ? "Wird gebucht…" : "Endgültig buchen"}
            </button>
          </div>
        </div>
      ) : (
        <div className="ops-action-buttons">
          <button type="button" className="ops-btn" onClick={onCancel} disabled={busy}>Abbrechen</button>
          <button type="button" className="ops-btn ops-btn-primary" disabled={busy || !valid || (goesNegative && !allowNegative)}
            onClick={() => setConfirming(true)}>Weiter</button>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   THE ITEM FORM
   ══════════════════════════════════════════════════════════════ */

function ItemForm({
  item, areas, categories, onCancel, onDone, onSessionLost, showInitial,
}: {
  item?: Item;
  areas: InventoryArea[];
  categories: Category[];
  onCancel: () => void;
  onDone: () => Promise<void>;
  onSessionLost: () => void;
  showInitial?: boolean;
}) {
  const [name, setName] = useState(item?.name ?? "");
  const [sku, setSku] = useState(item?.sku ?? "");
  const [categoryId, setCategoryId] = useState(item?.category_id ?? categories[0]?.id ?? "");
  const [unit, setUnit] = useState(item?.unit ?? "");
  const [selectedAreas, setSelectedAreas] = useState<InventoryArea[]>(areas);
  const [threshold, setThreshold] = useState(
    item?.low_stock_threshold === null || item?.low_stock_threshold === undefined
      ? "" : String(item.low_stock_threshold)
  );
  const [supplier, setSupplier] = useState(item?.supplier ?? "");
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [initial, setInitial] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [addingCategory, setAddingCategory] = useState(false);
  const [options, setOptions] = useState(categories);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operationId] = useState(newOperationId);

  const toggleArea = (a: InventoryArea) =>
    setSelectedAreas(prev => (prev.includes(a) ? prev.filter(x => x !== a) : [...prev, a]));

  const valid = name.trim().length > 0 && unit.trim().length > 0 && categoryId.length > 0;

  async function addCategory() {
    if (busy || !newCategory.trim()) return;
    setBusy(true); setError(null);
    try {
      const { status, data } = await post("/api/admin/inventory/categories/save", { name: newCategory });
      if (status === 401) { onSessionLost(); return; }
      if (status !== 200) {
        setError(typeof data.error === "string" ? data.error : "Die Kategorie konnte nicht angelegt werden.");
        return;
      }
      const created = data.category as Category;
      setOptions(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name, "de")));
      setCategoryId(created.id);
      setNewCategory("");
      setAddingCategory(false);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (busy || !valid) return;
    setBusy(true); setError(null);
    try {
      const shared = {
        name, sku: sku || null, categoryId, unit,
        areas: selectedAreas,
        lowStockThreshold: threshold || null,
        supplier: supplier || null,
        notes: notes || null,
      };
      const { status, data } = item
        ? await post("/api/admin/inventory/items/update", { ...shared, itemId: item.id })
        : await post("/api/admin/inventory/items/create", { ...shared, operationId, initialQuantity: initial || null });
      if (status === 401) { onSessionLost(); return; }
      if (status !== 200) {
        setError(typeof data.error === "string" ? data.error : "Der Artikel konnte nicht gespeichert werden.");
        return;
      }
      await onDone();
    } catch {
      setError("Der Artikel konnte nicht gespeichert werden.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ops-action-block">
      <h4>{item ? "Artikel bearbeiten" : "Neuer Artikel"}</h4>
      {error && <p className="ops-error" role="alert">{error}</p>}

      <div className="ops-action-fields">
        <label>
          <span>Artikelname *</span>
          <input type="text" value={name} maxLength={120} disabled={busy}
            onChange={e => setName(e.target.value)} placeholder="z. B. Matcha Rohware" />
        </label>
        <label>
          <span>Einheit *</span>
          <input type="text" value={unit} maxLength={20} disabled={busy || Boolean(item)}
            onChange={e => setUnit(e.target.value)} placeholder="g, Stück, Rollen …" />
        </label>
        <label>
          <span>Kategorie *</span>
          <select value={categoryId} disabled={busy} onChange={e => setCategoryId(e.target.value)}>
            {options.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>
          <span>SKU</span>
          <input type="text" value={sku} maxLength={60} disabled={busy}
            onChange={e => setSku(e.target.value)} placeholder="optional" />
        </label>
        <label>
          <span>Mindestbestand</span>
          <input type="text" inputMode="decimal" value={threshold} disabled={busy}
            onChange={e => setThreshold(e.target.value)} placeholder="optional" />
        </label>
        <label>
          <span>Lieferant</span>
          <input type="text" value={supplier} maxLength={120} disabled={busy}
            onChange={e => setSupplier(e.target.value)} placeholder="optional" />
        </label>
        <label>
          <span>Notiz</span>
          <input type="text" value={notes} maxLength={2000} disabled={busy}
            onChange={e => setNotes(e.target.value)} placeholder="optional" />
        </label>
      </div>

      {item && (
        <p className="ops-action-note">
          Die Einheit lässt sich nach der ersten Bewegung nicht mehr ändern – sonst würde
          die bisherige Historie etwas anderes bedeuten als beim Buchen gemeint war.
        </p>
      )}

      <fieldset className="ops-area-picker">
        <legend>Bereiche</legend>
        {INVENTORY_AREAS.map(a => (
          <label key={a} className="ops-radio">
            <input type="checkbox" checked={selectedAreas.includes(a)} disabled={busy}
              onChange={() => toggleArea(a)} />
            <span>{AREA_LABEL[a]}</span>
          </label>
        ))}
      </fieldset>

      {!item && showInitial && (
        <div className="ops-action-fields">
          <label>
            <span>Anfangsbestand</span>
            <input type="text" inputMode="decimal" value={initial} disabled={busy}
              onChange={e => setInitial(e.target.value)} placeholder="optional" />
          </label>
        </div>
      )}
      {!item && showInitial && (
        <p className="ops-action-note">
          Ein Anfangsbestand wird als Bewegung „Anfangsbestand“ gebucht, nicht als stiller Wert
          gesetzt. So ist die Historie ab dem ersten Tag vollständig.
        </p>
      )}

      {addingCategory ? (
        <div className="ops-action-fields">
          <label>
            <span>Neue Kategorie</span>
            <input type="text" value={newCategory} maxLength={80} disabled={busy}
              onChange={e => setNewCategory(e.target.value)} placeholder="z. B. Café Samples" />
          </label>
          <div className="ops-action-buttons">
            <button type="button" className="ops-btn" onClick={() => setAddingCategory(false)} disabled={busy}>
              Abbrechen
            </button>
            <button type="button" className="ops-btn ops-btn-primary" onClick={() => void addCategory()}
              disabled={busy || !newCategory.trim()}>Kategorie anlegen</button>
          </div>
        </div>
      ) : (
        <div className="ops-action-buttons">
          <button type="button" className="ops-btn" onClick={() => setAddingCategory(true)} disabled={busy}>
            Neue Kategorie
          </button>
        </div>
      )}

      <div className="ops-action-buttons">
        <button type="button" className="ops-btn" onClick={onCancel} disabled={busy}>Abbrechen</button>
        <button type="button" className="ops-btn ops-btn-primary" onClick={() => void save()} disabled={busy || !valid}>
          {busy ? "Wird gespeichert…" : item ? "Speichern" : "Artikel anlegen"}
        </button>
      </div>
    </div>
  );
}

/** The create dialog: the same form, in its own panel. */
function ItemDialog({
  categories, onClose, onSaved, onSessionLost,
}: {
  categories: Category[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onSessionLost: () => void;
}) {
  return (
    <div className="ops-drawer-backdrop">
      <button type="button" className="ops-drawer-scrim" onClick={onClose} aria-label="Dialog schließen" />
      <aside className="ops-drawer" role="dialog" aria-modal="true" aria-label="Neuer Artikel">
        <header className="ops-drawer-head">
          <h2>Neuer Artikel</h2>
          <button type="button" className="ops-drawer-close" onClick={onClose} aria-label="Schließen">×</button>
        </header>
        <section className="ops-actions">
          <ItemForm
            areas={[]}
            categories={categories}
            onCancel={onClose}
            onDone={onSaved}
            onSessionLost={onSessionLost}
            showInitial
          />
        </section>
      </aside>
    </div>
  );
}
