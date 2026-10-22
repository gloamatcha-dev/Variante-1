import type { AdminIdentity } from './adminIdentityDeps.ts';
import { normalizeAdminEmail } from './adminSession.ts';
import { isProductUuid } from './productManagerRules.ts';

/** Exact existing Auth identity verified read-only and explicitly confirmed by the operator. Server only. */
export const PRODUCT_MANAGER_OWNER = Object.freeze({
  userId: '75f838b9-f393-4e52-b8b0-70c118df8ed1', email: 'valmira.hajzeri@gloamatcha.com',
});
export function matchesProductOwner(identity: AdminIdentity, raw = JSON.stringify(PRODUCT_MANAGER_OWNER)): boolean {
  try {
    const owner = JSON.parse(raw ?? 'null');
    return !!owner && isProductUuid(owner.userId) && typeof owner.email === 'string' &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner.email) && identity.role === 'owner' &&
      identity.userId === owner.userId && normalizeAdminEmail(identity.email) === normalizeAdminEmail(owner.email);
  } catch { return false; }
}
