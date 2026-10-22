import type { SupabaseClient } from '@supabase/supabase-js';

export type PublicationStatus = 'published' | 'draft' | 'archived' | 'unknown';
export const UNCLEAR_PUBLICATION_STATUS = 'Status unklar — bitte aktualisieren';

/** Read-only reconciliation. Never retries, rolls back or reconstructs a commercial write. */
export async function readProductPublicationStatus(admin: SupabaseClient, id: string) {
  try {
    const { data, error } = await admin.from('products').select('id,is_active,archived_at,stripe_sync_revision,stripe_sync_status').eq('id', id).single();
    if (error || !data || data.id !== id || typeof data.is_active !== 'boolean' ||
        !Number.isSafeInteger(data.stripe_sync_revision) ||
        (data.archived_at !== null && typeof data.archived_at !== 'string')) throw Error('Unconfirmed status');
    const status: PublicationStatus = data.archived_at ? 'archived' : data.is_active ? 'published' : 'draft';
    return { id, status, revision: data.stripe_sync_revision, stripeSyncStatus: data.stripe_sync_status,
      archivedAt: data.archived_at as string | null };
  } catch { return { id, status: 'unknown' as const }; }
}
