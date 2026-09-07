import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { verifyAdminRequest } from "../../../../lib/adminSessionDeps.ts";
import {
  WAITLIST_COLUMNS,
  WAITLIST_COLUMNS_EXTENDED,
  pageRange,
  resolveWaitlistQuery,
} from "../../../../lib/adminWaitlistQuery.ts";
import { GLOA_LAUNCH_ISO, GLOA_LAUNCH_MS } from "../../../../lib/launchCountdown";
import { LAUNCH_CONSENT_VERSION, LAUNCH_CONSENT_VERSION_V1 } from "../../../../lib/launchWaitlist";
import { SHOP_STATUS } from "../../../content";

/**
 * THE OVERVIEW'S DATA, AND NOTHING ELSE.
 *
 * POST, session-authenticated, read-only. It selects, counts and
 * returns. There is no write path in this file at all - releasing and
 * sending stay where they already are, behind LAUNCH_ADMIN_SECRET in
 * /api/admin/launch/*, so this screen cannot become a second way to mail
 * two thousand people.
 *
 * POST rather than GET even though it only reads: a GET carrying filters
 * and a search term ends up in browser history and in every proxy log on
 * the way, and this one's parameters describe people on a consent list.
 *
 * ── IT RUNS AS THE SERVICE ROLE, SO THE GATE IS THE SESSION ───
 *
 * public.launch_waitlist has RLS on and no grant for anon or
 * authenticated - by design, since 043. Reading it needs the service
 * role, which means the session check above is the only thing standing
 * between a request and the whole list. It is therefore the first
 * statement in the handler, and it re-checks the allowlist on every
 * call rather than trusting the token's age.
 */

const MAX_BODY_BYTES = 2000;

function unauthorized(): Response {
  // Same answer whether the cookie is missing, forged, expired, or names
  // somebody who has since been removed from the allowlist.
  return Response.json({ error: "Nicht autorisiert." }, { status: 401 });
}

export async function POST(request: Request): Promise<Response> {
  const session = verifyAdminRequest(request);
  if (!session) return unauthorized();

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.error("Admin waitlist: supabase admin client is not configured.");
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

  const query = resolveWaitlistQuery(body);
  const { from, to } = pageRange(query);

  // Ask for the wider column set first. If 045 or 046 is not applied the
  // query fails on the unknown column, and the narrow set is used
  // instead - so this screen works on either side of the migration.
  let rows: unknown[] = [];
  let total = 0;
  let extended = true;

  for (const columns of [WAITLIST_COLUMNS_EXTENDED, WAITLIST_COLUMNS]) {
    let q = supabase.from("launch_waitlist").select(columns, { count: "exact" });

    if (query.filter !== "all") q = q.eq("status", query.filter);
    if (query.search) {
      // Matches an address or a first name. The term was stripped of
      // every character PostgREST treats as syntax before it got here.
      q = q.or(`email.ilike.%${query.search}%,first_name.ilike.%${query.search}%`);
    }

    const { data, count, error } = await q.order("created_at", { ascending: false }).range(from, to);

    if (!error) {
      rows = (data as unknown[]) ?? [];
      total = typeof count === "number" ? count : 0;
      break;
    }
    if (columns === WAITLIST_COLUMNS) {
      console.error("Admin waitlist: query failed:", error.message);
      return Response.json({ error: "Nicht verfügbar." }, { status: 503 });
    }
    extended = false;
  }

  // The counters, each its own exact count rather than derived from the
  // page above - a page is 25 rows and these describe the whole list.
  const counts = await countByStatus(supabase);
  const consent = await countByConsentVersion(supabase);

  return Response.json(
    {
      rows,
      total,
      page: query.page,
      pageSize: query.pageSize,
      filter: query.filter,
      search: query.search,
      counts,
      consent,
      // Read-only context, so the operator does not have to hold three
      // separate facts in their head to know whether a send is possible.
      launch: {
        plannedIso: GLOA_LAUNCH_ISO,
        plannedReached: Date.now() >= GLOA_LAUNCH_MS,
        shopStatus: String(SHOP_STATUS),
        // Whether the later migrations are live at all. The overview says
        // so plainly rather than showing zeroes that look like data.
        migrationsApplied: extended,
      },
      // The signed-in operator, so the page can name who is looking.
      // Their own address, never anybody else's.
      signedInAs: session.email,
    },
    { status: 200, headers: { "Cache-Control": "no-store" } }
  );
}

type Counter = { count: number | null; error: { message: string } | null };

async function countByStatus(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdmin>>
): Promise<Record<string, number>> {
  const out: Record<string, number> = { total: 0, pending: 0, confirmed: 0, withdrawn: 0, notified: 0 };

  const all: Counter = await supabase
    .from("launch_waitlist")
    .select("id", { count: "exact", head: true });
  out.total = all.count ?? 0;

  for (const status of ["pending", "confirmed", "withdrawn", "notified"]) {
    const r: Counter = await supabase
      .from("launch_waitlist")
      .select("id", { count: "exact", head: true })
      .eq("status", status);
    out[status] = r.count ?? 0;
  }
  return out;
}

/**
 * Consent versions, counted separately.
 *
 * Which wording is in force decides who may receive the welcome mail, so
 * it is the number an operator actually needs before a send - not a
 * detail. Only the two known versions are counted; anything else lands
 * in `other`, which should always be zero and is worth seeing if it is
 * not.
 */
async function countByConsentVersion(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdmin>>
): Promise<{ v1: number; v2: number; other: number }> {
  const count = async (version: string): Promise<number> => {
    const r: Counter = await supabase
      .from("launch_waitlist")
      .select("id", { count: "exact", head: true })
      .eq("consent_version", version);
    return r.count ?? 0;
  };

  const total: Counter = await supabase
    .from("launch_waitlist")
    .select("id", { count: "exact", head: true });

  const v1 = await count(LAUNCH_CONSENT_VERSION_V1);
  const v2 = await count(LAUNCH_CONSENT_VERSION);
  return { v1, v2, other: Math.max(0, (total.count ?? 0) - v1 - v2) };
}
