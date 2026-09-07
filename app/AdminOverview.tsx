"use client";
import { useCallback, useEffect, useState } from "react";
import { WAITLIST_FILTERS, type WaitlistFilter } from "../lib/adminWaitlistQuery";

/**
 * THE PRIVATE LAUNCH LIST OVERVIEW.
 *
 * Read-only. It shows who is on the list, what they consented to, and
 * what still stands between today and a send. It cannot release a launch
 * and it cannot send anything - those live behind their own secret in
 * /api/admin/launch/*, and keeping them out of this screen is what stops
 * a mis-click from mailing two thousand people.
 *
 * ── IT HOLDS NO CREDENTIAL ────────────────────────────────────
 *
 * No service-role key, no LAUNCH_ADMIN_SECRET, no Supabase token. The
 * only thing proving who is looking is an HttpOnly cookie this code
 * cannot read, which is the point: a script that got onto this page
 * still cannot extract the session, only ride it - and SameSite=Strict
 * means another origin cannot even do that.
 *
 * ── NO SHOP CHROME ────────────────────────────────────────────
 *
 * Rendered from its own route rather than through GloaSite, so the
 * header, the cart and the footer are simply not present. An admin
 * surface with a "Warenkorb" button in the corner invites exactly the
 * kind of accident it should not.
 */

type Row = {
  id: string;
  email: string;
  first_name: string | null;
  audience_type: string | null;
  source: string;
  status: string;
  consent_version: string;
  created_at: string;
  confirmed_at: string | null;
  withdrawn_at: string | null;
  launch_notification_sent_at: string | null;
  welcome_email_sent_at?: string | null;
  welcome_email_needs_review?: boolean | null;
  pending_consent_version?: string | null;
};

type Payload = {
  rows: Row[];
  total: number;
  page: number;
  pageSize: number;
  filter: WaitlistFilter;
  search: string;
  counts: Record<string, number>;
  consent: { v1: number; v2: number; other: number };
  launch: {
    plannedIso: string;
    plannedReached: boolean;
    shopStatus: string;
    migrationsApplied: boolean;
  };
  signedInAs: string;
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Offen",
  confirmed: "Bestätigt",
  withdrawn: "Widerrufen",
  notified: "Benachrichtigt",
};

const FILTER_LABEL: Record<WaitlistFilter, string> = {
  all: "Alle",
  pending: "Offen",
  confirmed: "Bestätigt",
  withdrawn: "Widerrufen",
  notified: "Benachrichtigt",
};

const AUDIENCE_LABEL: Record<string, string> = {
  private: "Privat",
  cafe: "Café",
  studio: "Studio",
  business: "Business",
  other: "Sonstige",
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** v1 / v2 rather than the full identifier, which is 40 characters of noise. */
function consentShort(version: string): string {
  if (version.endsWith(".v1")) return "v1";
  if (version.endsWith(".v2")) return "v2";
  return version.slice(-6);
}

export function AdminOverview() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [busy, setBusy] = useState(false);

  const [data, setData] = useState<Payload | null>(null);
  const [filter, setFilter] = useState<WaitlistFilter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async (next: { filter: WaitlistFilter; search: string; page: number }) => {
    // No state is set before the first await. The mount effect calls
    // this, and a synchronous setState inside an effect starts a
    // cascading render - so the previous error is cleared on the way out
    // of each branch instead.
    const res = await fetch("/api/admin/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    if (res.status === 401) {
      setSignedIn(false);
      setData(null);
      return;
    }
    if (!res.ok) {
      setLoadError("Die Daten konnten nicht geladen werden.");
      return;
    }
    setData((await res.json()) as Payload);
    setSignedIn(true);
    setLoadError("");
  }, []);

  // One probe on mount decides which screen to show. A 401 is the normal
  // answer for a visitor without a session, not an error.
  //
  // Written out rather than calling load() so nothing is set
  // synchronously inside the effect, and with a cancelled flag so a
  // visitor who navigates away mid-request does not have state written
  // into an unmounted component.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/waitlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filter: "all", search: "", page: 1 }),
        });
        if (cancelled) return;
        if (res.status === 401) {
          setSignedIn(false);
          return;
        }
        if (!res.ok) {
          setSignedIn(true);
          setLoadError("Die Daten konnten nicht geladen werden.");
          return;
        }
        const payload = (await res.json()) as Payload;
        if (cancelled) return;
        setData(payload);
        setSignedIn(true);
      } catch {
        if (!cancelled) setSignedIn(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const submitLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setLoginError("");
    try {
      const res = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        setLoginError(
          res.status === 429
            ? "Zu viele Versuche. Bitte warte einen Moment."
            : "Anmeldung fehlgeschlagen."
        );
        return;
      }
      // The password never stays in memory longer than the request.
      setPassword("");
      await load({ filter: "all", search: "", page: 1 });
    } catch {
      setLoginError("Anmeldung fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await fetch("/api/admin/session", { method: "DELETE" }).catch(() => undefined);
    setSignedIn(false);
    setData(null);
    setEmail("");
  };

  const apply = (next: Partial<{ filter: WaitlistFilter; search: string; page: number }>) => {
    const merged = { filter, search, page, ...next };
    // Any change to what is being asked for starts at the first page -
    // otherwise a filter can land on page 9 of a 2-page result.
    if (next.filter !== undefined || next.search !== undefined) merged.page = 1;
    setFilter(merged.filter);
    setSearch(merged.search);
    setPage(merged.page);
    void load(merged);
  };

  if (signedIn === null) {
    return <main className="ops"><p className="ops-loading">Wird geladen…</p></main>;
  }

  if (!signedIn) {
    return (
      <main className="ops ops-login">
        <form className="ops-login-card" onSubmit={submitLogin}>
          <p className="ops-eyebrow">GLOA</p>
          <h1 className="ops-login-title">Interner Bereich</h1>
          <label htmlFor="ops-email">E-Mail</label>
          <input
            id="ops-email" type="email" autoComplete="username" required
            value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy}
          />
          <label htmlFor="ops-password">Passwort</label>
          <input
            id="ops-password" type="password" autoComplete="current-password" required
            value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy}
          />
          {loginError && <p className="ops-error" role="alert">{loginError}</p>}
          <button type="submit" disabled={busy}>{busy ? "Wird geprüft…" : "Anmelden"}</button>
        </form>
      </main>
    );
  }

  if (!data) {
    return <main className="ops"><p className="ops-loading">{loadError || "Wird geladen…"}</p></main>;
  }

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const blockers: string[] = [];
  if (!data.launch.migrationsApplied) blockers.push("Migration 045/046 nicht angewendet");
  if (data.launch.shopStatus !== "live") blockers.push(`Shop ist ${data.launch.shopStatus}`);
  if (data.counts.confirmed === 0) blockers.push("kein bestätigter Kontakt");

  return (
    <main className="ops">
      <header className="ops-head">
        <div>
          <p className="ops-eyebrow">GLOA · LAUNCH LIST</p>
          <h1 className="ops-title">Übersicht</h1>
        </div>
        <div className="ops-head-right">
          <span className="ops-who">{data.signedInAs}</span>
          <button type="button" className="ops-signout" onClick={signOut}>Abmelden</button>
        </div>
      </header>

      <section className="ops-counts" aria-label="Zähler">
        {[
          ["Gesamt", data.counts.total],
          ["Offen", data.counts.pending],
          ["Bestätigt", data.counts.confirmed],
          ["Widerrufen", data.counts.withdrawn],
          ["Benachrichtigt", data.counts.notified],
        ].map(([label, value]) => (
          <div className="ops-count" key={String(label)}>
            <span className="ops-count-value">{value}</span>
            <span className="ops-count-label">{label}</span>
          </div>
        ))}
      </section>

      <section className="ops-panel" aria-label="Status">
        <dl className="ops-facts">
          <div><dt>Launch geplant</dt><dd>{fmtDate(data.launch.plannedIso)} {data.launch.plannedReached ? "(erreicht)" : ""}</dd></div>
          <div><dt>Shop</dt><dd>{data.launch.shopStatus}</dd></div>
          <div><dt>Einwilligung v1 / v2</dt><dd>{data.consent.v1} / {data.consent.v2}{data.consent.other > 0 ? ` (+${data.consent.other} andere)` : ""}</dd></div>
          <div><dt>Versand</dt><dd>{blockers.length === 0 ? "bereit" : "gesperrt"}</dd></div>
        </dl>
        {blockers.length > 0 && (
          <ul className="ops-blockers">
            {blockers.map((b) => <li key={b}>{b}</li>)}
          </ul>
        )}
        <p className="ops-note">
          Freigabe und Versand sind in dieser Ansicht bewusst nicht möglich.
        </p>
      </section>

      <section className="ops-controls" aria-label="Filter">
        <div className="ops-filters" role="group" aria-label="Status filtern">
          {WAITLIST_FILTERS.map((f) => (
            <button
              key={f} type="button"
              className={f === data.filter ? "is-active" : ""}
              aria-pressed={f === data.filter}
              onClick={() => apply({ filter: f })}
            >
              {FILTER_LABEL[f]}
            </button>
          ))}
        </div>
        <form
          className="ops-search"
          onSubmit={(e) => { e.preventDefault(); apply({ search }); }}
        >
          <label htmlFor="ops-search-input">Suche</label>
          <input
            id="ops-search-input" type="search" placeholder="E-Mail oder Vorname"
            value={search} onChange={(e) => setSearch(e.target.value)}
          />
          <button type="submit">Suchen</button>
        </form>
      </section>

      <div className="ops-table-wrap">
        <table className="ops-table">
          <thead>
            <tr>
              <th scope="col">E-Mail</th>
              <th scope="col">Vorname</th>
              <th scope="col">Zielgruppe</th>
              <th scope="col">Quelle</th>
              <th scope="col">Status</th>
              <th scope="col">Einw.</th>
              <th scope="col">Welcome</th>
              <th scope="col">Launch</th>
              <th scope="col">Angemeldet</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 && (
              <tr><td colSpan={9} className="ops-empty">Keine Einträge.</td></tr>
            )}
            {data.rows.map((r) => (
              <tr key={r.id}>
                <td className="ops-mail">{r.email}</td>
                <td>{r.first_name || "—"}</td>
                <td>{r.audience_type ? AUDIENCE_LABEL[r.audience_type] ?? r.audience_type : "—"}</td>
                <td>{r.source}</td>
                <td><span className={`ops-status ops-status-${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span></td>
                <td>
                  {consentShort(r.consent_version)}
                  {r.pending_consent_version ? <span className="ops-pending" title="Neue Fassung noch nicht bestätigt"> +offen</span> : null}
                </td>
                <td>
                  {r.welcome_email_needs_review
                    ? <span className="ops-review">Prüfen</span>
                    : r.welcome_email_sent_at ? fmtDate(r.welcome_email_sent_at) : "—"}
                </td>
                <td>{r.launch_notification_sent_at ? fmtDate(r.launch_notification_sent_at) : "—"}</td>
                <td>{fmtDate(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <nav className="ops-pager" aria-label="Seiten">
        <button type="button" disabled={data.page <= 1} onClick={() => apply({ page: data.page - 1 })}>
          Zurück
        </button>
        <span>Seite {data.page} von {pages} · {data.total} Einträge</span>
        <button type="button" disabled={data.page >= pages} onClick={() => apply({ page: data.page + 1 })}>
          Weiter
        </button>
      </nav>
    </main>
  );
}
