/**
 * WHAT THE ADMIN OVERVIEW MAY ASK FOR.
 *
 * Every parameter a browser can send is normalised here, into a closed
 * set, before it reaches a query. A page size, a status filter and a
 * search term arriving from a client are three chances to be handed
 * something the database should never see, and this module is where
 * that stops - not at the query, and not in the component.
 *
 * Pure: no clock, no client, no environment. The suite drives it with
 * hostile input directly.
 */

/** The statuses 043 permits, plus the pseudo-filter for everything. */
export const WAITLIST_FILTERS = ["all", "pending", "confirmed", "withdrawn", "notified"] as const;
export type WaitlistFilter = (typeof WAITLIST_FILTERS)[number];

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export type WaitlistQuery = {
  filter: WaitlistFilter;
  /** Already trimmed and length-capped. Empty means no search. */
  search: string;
  page: number;
  pageSize: number;
};

export function resolveWaitlistFilter(raw: unknown): WaitlistFilter {
  return typeof raw === "string" && (WAITLIST_FILTERS as readonly string[]).includes(raw)
    ? (raw as WaitlistFilter)
    : "all";
}

/**
 * The search term.
 *
 * Trimmed, capped, and stripped of the characters PostgREST gives
 * meaning to inside a filter value - a comma separates arguments and
 * parentheses group them, so a term containing either could otherwise
 * change the SHAPE of the query rather than only its subject. Percent
 * and underscore are the LIKE wildcards and are removed for the same
 * reason: a search is a search, not a pattern the caller composes.
 */
export function normalizeSearch(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .slice(0, 120)
    .replace(/[,()%_*\\"']/g, "")
    .trim();
}

export function resolvePage(raw: unknown): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10_000) : 1;
}

export function resolvePageSize(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

export function resolveWaitlistQuery(input: unknown): WaitlistQuery {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    filter: resolveWaitlistFilter(raw.filter),
    search: normalizeSearch(raw.search),
    page: resolvePage(raw.page),
    pageSize: resolvePageSize(raw.pageSize),
  };
}

/** The half-open row range this page covers, for PostgREST's range(). */
export function pageRange(query: WaitlistQuery): { from: number; to: number } {
  const from = (query.page - 1) * query.pageSize;
  return { from, to: from + query.pageSize - 1 };
}

/**
 * THE COLUMNS THE OVERVIEW READS. An explicit list, never "*".
 *
 * Notice what is absent: both token hashes, the consent TEXT (the
 * version identifies it and the full wording is not needed to run a
 * list), and every claim id. A screen that does not need a value should
 * not be able to leak one, and the surest way to achieve that is not to
 * select it.
 */
export const WAITLIST_COLUMNS = [
  "id",
  "email",
  "first_name",
  "audience_type",
  "source",
  "status",
  "consent_version",
  "created_at",
  "confirmed_at",
  "withdrawn_at",
  "launch_notification_sent_at",
].join(", ");

/**
 * The same list plus the columns later migrations add.
 *
 * Kept separate because 045 and 046 may not be applied: selecting a
 * column that does not exist fails the whole query, so the caller asks
 * for the wider set first and falls back to the narrow one. That is the
 * same deployment-gap problem lib/launchSignupCompat.ts solves for the
 * public form, in the one place it also affects this screen.
 */
export const WAITLIST_COLUMNS_EXTENDED = [
  WAITLIST_COLUMNS,
  "welcome_email_sent_at",
  "welcome_email_needs_review",
  "pending_consent_version",
].join(", ");
