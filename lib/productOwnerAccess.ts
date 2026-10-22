import { requireAdminIdentity } from './adminActionRoute.ts';
import type { AdminIdentity } from './adminIdentityDeps.ts';
import { getSupabaseAdmin } from './supabaseAdmin';
import { matchesProductOwner } from './productOwner.ts';
import { normalizeAdminEmail } from './adminSession.ts';

export async function canAccessProductManager(identity: AdminIdentity): Promise<boolean> {
  if (!matchesProductOwner(identity)) return false;
  try {
    const admin = getSupabaseAdmin();
    if (!admin) return false;
    const { data, error } = await admin.auth.admin.getUserById(identity.userId);
    return !error && data.user?.id === identity.userId && !!data.user.email_confirmed_at &&
      !data.user.deleted_at && (!data.user.banned_until || Date.parse(data.user.banned_until) <= Date.now()) &&
      normalizeAdminEmail(data.user.email) === normalizeAdminEmail(identity.email);
  } catch { return false; }
}

export async function requireProductOwner(request: Request) {
  const gate = await requireAdminIdentity(request, 'read');
  if (!gate.ok) return gate;
  if (!await canAccessProductManager(gate.identity)) return {
    ok: false as const, response: Response.json({ error: 'Keine Berechtigung für die Produktverwaltung.' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }),
  };
  return gate;
}
