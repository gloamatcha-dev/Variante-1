import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { requireAdminIdentity } from "../../../../lib/adminActionRoute.ts";
import {
  AUDIT_LOG_COLUMNS,
  AUDIT_PAGE_SIZE,
  auditPageRange,
  parseAuditFilter,
  resolveAuditPage,
} from "../../../../lib/adminAudit.ts";

/**
 * THE ACTIVITY LOG, READ AND ONLY READ.
 *
 * ── THERE IS NO WAY TO WRITE THROUGH HERE ─────────────────────
 *
 * Not "we chose not to expose a write" - there is no path. The table
 * grants service_role SELECT and nothing else, so even this file could
 * not insert a row if it tried; the only door is
 * record_admin_activity, which the business flows call. An endpoint
 * that could write the audit log would be an endpoint that could
 * forge it.
 *
 * ── A VIEWER MAY READ IT ──────────────────────────────────────
 *
 * "read" is the capability, so all three roles see the same history.
 * That is the point of the screen: a viewer is somebody trusted to LOOK
 * at what the shop is doing, and the log is the least sensitive thing
 * they can look at - no addresses, no payment identifiers, no customer
 * records, only who did what.
 *
 * POST rather than GET even though it only reads, matching every other
 * admin read here: the filter and the page describe internal operations
 * and have no business in a browser history or a proxy log.
 *
 * no-store because an audit trail that is one page stale is an audit
 * trail somebody will mistrust.
 */

const MAX_BODY_BYTES = 2000;

export async function POST(request: Request): Promise<Response> {
  // READ. Session, an active admin_users row, and a role that may read.
  const gate = await requireAdminIdentity(request, "read");
  if (!gate.ok) return gate.response;

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.error("Admin activity: supabase admin client is not configured.");
    return Response.json({ error: "Nicht verfügbar." }, { status: 503 });
  }

  let body: unknown = {};
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return Response.json({ error: "Ungültige Anfrage." }, { status: 400 });
    if (raw) body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Ungültige Anfrage." }, { status: 400 });
  }

  const raw = (body ?? {}) as Record<string, unknown>;
  // Allowlisted, exactly like every other admin query: anything
  // unrecognised becomes "all" rather than reaching PostgREST.
  const filter = parseAuditFilter(raw.filter);
  const page = resolveAuditPage(raw.page);
  const { from, to } = auditPageRange(page);

  let query = supabase
    .from("admin_activity_log")
    .select(AUDIT_LOG_COLUMNS, { count: "exact" });
  if (filter !== "all") query = query.eq("module", filter);

  // Newest first, with the id as the tiebreaker so two events in the
  // same millisecond cannot swap places between pages.
  const { data, count, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  if (error) {
    console.error("Admin activity: read failed:", error.message);
    return Response.json({ error: "Die Aktivität konnte nicht geladen werden." }, { status: 502 });
  }

  return Response.json(
    {
      rows: (data as unknown[]) ?? [],
      total: typeof count === "number" ? count : 0,
      page,
      pageSize: AUDIT_PAGE_SIZE,
      filter,
      fetchedAt: new Date().toISOString(),
    },
    { status: 200, headers: { "Cache-Control": "no-store" } }
  );
}
