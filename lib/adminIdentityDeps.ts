import { getSupabaseAdmin } from "./supabaseAdmin";
import { parseAdminRole, type AdminRole } from "./adminRoles.ts";
import { normalizeAdminEmail } from "./adminSession.ts";

/**
 * WHO THE SESSION BELONGS TO, READ FRESH ON EVERY REQUEST.
 *
 * The cookie proves that somebody signed in and that the token was not
 * forged. It does NOT say what they may do - admin_users does, and this
 * module is the only place that asks.
 *
 * ── WHY THE ROLE IS NOT IN THE TOKEN ──────────────────────────
 *
 * The same reasoning that already applies to ADMIN_EMAILS: a session
 * lives eight hours, and switching somebody to viewer, or off, has to
 * take effect NOW rather than whenever their token happens to lapse. A
 * role baked into a cookie is a role that is right at issue time and
 * unreliable ever after.
 *
 * The cost is one small read per admin request. Measured after the
 * region alignment, a Supabase round trip from the running function is
 * ~5-25ms; the correctness is worth that, and it is the same trade the
 * allowlist check already makes.
 *
 * ── THE LOOKUP IS BY USER ID, NEVER BY EMAIL ──────────────────
 *
 * The email in the token is for display and for logging. It is not what
 * identifies the row, because an address can be reassigned and a user
 * id cannot.
 */

export type AdminIdentity = {
  userId: string;
  /** The address on the admin_users row - the current one, not the cookie's. */
  email: string;
  displayName: string;
  role: AdminRole;
};

export type IdentityLookup =
  | { ok: true; identity: AdminIdentity }
  | { ok: false; reason: "unconfigured" | "unknown" | "inactive" | "invalid-role" | "read-failed" | "email-mismatch" };

/**
 * Resolves an admin_users row, or says why it could not.
 *
 * EVERY failure denies access. There is no path here that returns a
 * usable identity for a row that is missing, switched off, or carrying a
 * role this build does not recognise - an unrecognised role is treated
 * as a reason to stop, not as a reason to fall back to the weakest one.
 */
export async function resolveAdminIdentity(
  userId: string,
  /**
   * The address the CALLER is presenting - from the verified session
   * cookie, or from what Supabase Auth just confirmed at login. Never
   * from a request body.
   *
   * When given, it must match the row's address. See the note on
   * "email-mismatch" below for why this is a refusal and not a sync.
   */
  presentedEmail?: string | null
): Promise<IdentityLookup> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Admin identity: SUPABASE_SECRET_KEY is not configured.");
    return { ok: false, reason: "unconfigured" };
  }

  const { data, error } = await admin
    .from("admin_users")
    .select("user_id,email,display_name,role,is_active")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    // No detail to the caller and no guess: a read that failed is not
    // the same answer as "this person is not an admin", and neither of
    // them may become "let them in".
    console.error("Admin identity: lookup failed:", error.message);
    return { ok: false, reason: "read-failed" };
  }
  if (!data) return { ok: false, reason: "unknown" };

  const row = data as unknown as {
    user_id: string; email: string; display_name: string; role: string; is_active: boolean;
  };
  if (!row.is_active) return { ok: false, reason: "inactive" };

  // ── THE TUPLE HAS TO AGREE, AND A MISMATCH IS A REFUSAL ─────
  //
  // The user id is the stable identity and the address is not, so the
  // two can drift: somebody changes their address in Supabase Auth and
  // admin_users still carries the old one, or the reverse. Either way
  // the identity this deployment would act under is no longer the one
  // the operator is signing in as.
  //
  // WHY NOT SYNC IT HERE. Writing the new address into admin_users on
  // sight would mean any request could quietly rewrite who an
  // administrator is - and the address is what ADMIN_EMAILS still gates
  // on during the transition, so a silent update would let a changed
  // Auth address walk past a gate that was never updated to match. An
  // admin email change is a deliberate, three-place act (Supabase Auth,
  // admin_users, and ADMIN_EMAILS while it lasts); until all three
  // agree, this fails closed.
  if (presentedEmail !== undefined && presentedEmail !== null) {
    if (normalizeAdminEmail(presentedEmail) !== normalizeAdminEmail(row.email)) {
      console.error("Admin identity: session address does not match the admin_users row - refusing.");
      return { ok: false, reason: "email-mismatch" };
    }
  }

  const role = parseAdminRole(row.role);
  if (!role) {
    console.error("Admin identity: unrecognised role on an admin row - refusing.");
    return { ok: false, reason: "invalid-role" };
  }

  return {
    ok: true,
    identity: {
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role,
    },
  };
}
