"use client";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Shared account UI primitives (Task 29A).
 *
 * The private and the business dashboard are two different jobs, but they
 * are one design system: same hairlines, same eyebrows, same icon
 * language, same quick-link tiles. Keeping those here is what stops the
 * two from drifting into looking like different products - and it is the
 * only reason this file exists. It is presentation only: no data
 * fetching, no auth, no Supabase, no business rules.
 */

/* ── Icons ──────────────────────────────────────────────────── */

export type AccountIconName = "bag" | "repeat" | "pin" | "user" | "building" | "truck";

/**
 * One small outline set, drawn on the same 24 grid with the same 1.5
 * stroke and inheriting currentColor, so the icons read as siblings
 * rather than as a borrowed icon font. Inline because six paths are not
 * worth a dependency.
 */
const ICON_PATHS: Record<AccountIconName, ReactNode> = {
  bag: <><path d="M5.6 8h12.8l-1 12.2a1.4 1.4 0 0 1-1.4 1.3H8a1.4 1.4 0 0 1-1.4-1.3L5.6 8Z" /><path d="M9 8.4V6.2a3 3 0 1 1 6 0v2.2" /></>,
  repeat: <><path d="M4.2 12a7.8 7.8 0 0 1 13.4-5.4" /><path d="M19.8 12a7.8 7.8 0 0 1-13.4 5.4" /><path d="M17.9 2.9v3.9h-3.9" /><path d="M6.1 21.1v-3.9H10" /></>,
  pin: <><path d="M12 21.2s6.6-5.6 6.6-10.6a6.6 6.6 0 1 0-13.2 0c0 5 6.6 10.6 6.6 10.6Z" /><circle cx="12" cy="10.4" r="2.4" /></>,
  user: <><circle cx="12" cy="7.6" r="3.9" /><path d="M4.4 21v-1.3a5.3 5.3 0 0 1 5.3-5.3h4.6a5.3 5.3 0 0 1 5.3 5.3V21" /></>,
  building: <><path d="M4 21V5.4A1.4 1.4 0 0 1 5.4 4h8.2A1.4 1.4 0 0 1 15 5.4V21" /><path d="M15 10.2h3.6A1.4 1.4 0 0 1 20 11.6V21" /><path d="M2.8 21h18.4" /><path d="M7.6 8h3.8M7.6 12h3.8M7.6 16h3.8" /></>,
  truck: <><path d="M3 16.6V6.6A1.4 1.4 0 0 1 4.4 5.2h9.2v11.4" /><path d="M13.6 9.4h3.7l2.7 3.3v3.9h-2.1" /><circle cx="7.4" cy="17.6" r="1.9" /><circle cx="16.6" cy="17.6" r="1.9" /><path d="M9.3 17.6h5.4" /><path d="M3 17.6h2.5" /></>,
};

export function AccountIcon({ name }: { name: AccountIconName }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICON_PATHS[name]}
    </svg>
  );
}

function Chevron() {
  return (
    <svg className="portal-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M9.5 5.5 16 12l-6.5 6.5" />
    </svg>
  );
}

/* ── Section header ─────────────────────────────────────────── */

/**
 * An eyebrow, optionally with one quiet action on the right. Sections are
 * separated by a hairline rather than boxed, which is what keeps the page
 * editorial instead of a grid of cards.
 */
export function AccountSectionHeader({ label, action }: { label: string; action?: ReactNode }) {
  return (
    <div className="portal-section-head">
      <p className="eyebrow">{label}</p>
      {action}
    </div>
  );
}

/* ── Empty state ────────────────────────────────────────────── */

/**
 * Understated by design. An absent subscription or delivery is a normal
 * state of the account, not a problem to dramatise with a big empty card.
 *
 * `action` is what turns a dead end into a page: an empty state that has
 * a real next step should offer it, on the same line, so the row spans
 * the column instead of leaving a short sentence alone in white space.
 * It is omitted when there genuinely is nothing to do yet.
 */
export function AccountEmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return action
    ? <div className="portal-empty portal-empty-row"><span>{children}</span>{action}</div>
    : <p className="portal-empty">{children}</p>;
}

/** The quiet uppercase link used for every account-level action. */
export function AccountAction({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} className="portal-action">{children}</Link>;
}

/* ── Summary row ────────────────────────────────────────────── */

/**
 * The editorial horizontal row the business dashboard is built from:
 * a small round icon, a label, the real values, and an optional value on
 * the right. Every field is optional because the caller renders only what
 * the account genuinely has.
 */
export function AccountSummaryRow({
  icon,
  label,
  primary,
  secondary,
  value,
  href,
  action,
}: {
  icon: AccountIconName;
  label: string;
  primary: ReactNode;
  secondary?: ReactNode;
  value?: ReactNode;
  href?: string;
  /** Shown on the right when the row itself is not a link, so a row with
   *  nothing to show still ends in something to do. */
  action?: ReactNode;
}) {
  const body = (
    <>
      <span className="portal-summary-icon"><AccountIcon name={icon} /></span>
      <span className="portal-summary-body">
        <span className="portal-summary-label">{label}</span>
        <span className="portal-summary-primary">{primary}</span>
        {secondary && <span className="portal-summary-secondary">{secondary}</span>}
      </span>
      {value && <span className="portal-summary-value">{value}</span>}
      {!href && action}
      {href && <Chevron />}
    </>
  );

  return href
    ? <a className="portal-summary-row" href={href}>{body}</a>
    : <div className="portal-summary-row">{body}</div>;
}

/* ── Quick links ────────────────────────────────────────────── */

export type AccountQuickLink = { href: string; label: string; icon: AccountIconName };

/**
 * The four (or five) navigation tiles that close the dashboard.
 *
 * Deliberately NOT dashboard cards: a thin hairline, the page's own warm
 * cream showing through, no shadow, no fill, no radius - the same square
 * geometry the rest of the site uses. Hover shifts the border and the
 * type to GLOA blue and nothing else moves.
 */
export function AccountQuickLinks({ items }: { items: AccountQuickLink[] }) {
  return (
    <section className="portal-quicklinks">
      <AccountSectionHeader label="SCHNELLZUGRIFFE" />
      <div className="portal-quicklinks-grid" data-count={items.length}>
        {items.map(item => (
          <Link key={item.href} href={item.href} className="portal-quicklink">
            <AccountIcon name={item.icon} />
            <span className="portal-quicklink-label">{item.label}</span>
            <Chevron />
          </Link>
        ))}
      </div>
    </section>
  );
}
