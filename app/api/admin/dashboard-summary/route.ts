import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { requireAdminIdentity } from "../../../../lib/adminActionRoute.ts";

type ErrorResponse = { error: string };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

/**
 * ONE EFFICIENT ENDPOINT FOR THE ADMIN DASHBOARD.
 *
 * Returns authoritative server-side counts for ~12 operational
 * categories in a single request. Every number comes from the database
 * through the admin client; the browser receives counts, never rows.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await requireAdminIdentity(request, "read");
  if (!gate.ok) return gate.response;

  const admin = getSupabaseAdmin();
  if (!admin) {
    return json({ error: "Nicht verfügbar." } as ErrorResponse, 503);
  }

  try {
    const [
      ordersUnshipped,
      ordersToday,
      subscriptionsActive,
      annualPlansActive,
      withdrawalsPending,
      complaintsPending,
      terminationsPending,
      b2bAgreementsActive,
      creatorApplicationsPending,
      financialEventsToday,
      inventoryLow,
    ] = await Promise.all([
      admin.from("orders").select("id", { count: "exact", head: true })
        .is("shipped_at", null).neq("status", "cancelled").not("placed_at", "is", null),
      admin.from("orders").select("id", { count: "exact", head: true })
        .gte("placed_at", new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
      admin.from("subscriptions").select("id", { count: "exact", head: true })
        .eq("status", "active"),
      admin.from("annual_plans").select("id", { count: "exact", head: true })
        .eq("status", "active"),
      admin.from("withdrawal_requests").select("id", { count: "exact", head: true })
        .in("case_state", ["submitted", "in_review"]),
      admin.from("complaint_requests").select("id", { count: "exact", head: true })
        .in("case_state", ["submitted", "in_review"]),
      admin.from("termination_requests").select("id", { count: "exact", head: true })
        .in("case_state", ["submitted", "in_review"]),
      admin.from("b2b_supply_agreements").select("id", { count: "exact", head: true })
        .eq("status", "active"),
      admin.from("creator_applications").select("id", { count: "exact", head: true })
        .eq("status", "submitted"),
      admin.from("financial_events").select("id", { count: "exact", head: true })
        .gte("created_at", new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
      admin.from("inventory_levels").select("id", { count: "exact", head: true })
        .lt("current_quantity", 10),
    ]);

    return json({
      ok: true,
      summary: {
        ordersUnshipped: ordersUnshipped.count ?? 0,
        ordersToday: ordersToday.count ?? 0,
        subscriptionsActive: subscriptionsActive.count ?? 0,
        annualPlansActive: annualPlansActive.count ?? 0,
        withdrawalsPending: withdrawalsPending.count ?? 0,
        complaintsPending: complaintsPending.count ?? 0,
        terminationsPending: terminationsPending.count ?? 0,
        b2bAgreementsActive: b2bAgreementsActive.count ?? 0,
        creatorApplicationsPending: creatorApplicationsPending.count ?? 0,
        financialEventsToday: financialEventsToday.count ?? 0,
        inventoryLow: inventoryLow.count ?? 0,
      },
    }, 200);
  } catch (err) {
    console.error("Dashboard summary failed:", err instanceof Error ? err.message : err);
    return json({ error: "Nicht verfügbar." } as ErrorResponse, 503);
  }
}
