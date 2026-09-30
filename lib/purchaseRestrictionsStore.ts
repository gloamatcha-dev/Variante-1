/**
 * READING A CUSTOMER'S PURCHASE RESTRICTIONS.
 *
 * One query, shared by both new-plan checkout surfaces, so the annual
 * plan and the 4-week abo can never disagree about whether somebody is
 * restricted.
 *
 * ── IT READS EVERY ROW, NOT THE LIVE ONES ────────────────────
 *
 * Deciding which restrictions are in force is lib/purchaseRestrictions.ts's
 * job - restrictionIsLive and scopeCovers - and it is tested there. A
 * SQL predicate doing half of it would mean the rule lived in two places
 * and drifted in one, and the failure mode of that drift is letting a
 * restricted purchase through.
 *
 * ── AND IT THROWS RATHER THAN RETURNING NOTHING ──────────────
 *
 * An unreadable restriction store is not an unrestricted customer. Both
 * call sites catch this and refuse the purchase with a 503, so a
 * database blip cannot quietly reopen a closed door.
 */

import { getSupabaseAdmin } from "./supabaseAdmin";
import type { PurchaseRestrictionRow } from "./purchaseRestrictions";

export async function loadPurchaseRestrictionsForUser(
  userId: string
): Promise<PurchaseRestrictionRow[]> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new Error("purchase restrictions: Supabase admin client is not configured");
  }

  const { data, error } = await admin
    .from("purchase_restrictions")
    .select("scope, active, expires_at, reason_category, internal_note")
    .eq("user_id", userId);

  if (error) {
    throw new Error(`purchase restrictions: ${error.message}`);
  }

  return (data ?? []).map(row => ({
    scope: row.scope as PurchaseRestrictionRow["scope"],
    active: Boolean(row.active),
    expiresAt: (row.expires_at as string | null) ?? null,
    reasonCategory: row.reason_category as PurchaseRestrictionRow["reasonCategory"],
    internalNote: (row.internal_note as string | null) ?? null,
  }));
}
