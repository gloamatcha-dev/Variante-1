import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { validateProductDraft } from './productManagerRules.ts';
import { synchronizeProduct, verifyProductStripeMapping, type SyncProduct } from './productStripeSync.ts';
import { readProductPublicationStatus, UNCLEAR_PUBLICATION_STATUS } from './productPublicationStatus.ts';

export type PublicationStage = 'Prüfung läuft' | 'Stripe wird synchronisiert' | 'Stripe-Zuordnung wird geprüft' | 'Veröffentlichung abgeschlossen';

/** All writes use the existing revision-checked database functions. Never trusts client mappings. */
export async function publishProduct(admin: SupabaseClient, stripe: Stripe, input: {
  id: string; revision: number; operationId: string; actor: string;
}, progress: (stage: PublicationStage) => void, authorize: () => Promise<boolean>) {
  let revision = input.revision;
  const common = () => ({ p_actor: input.actor, p_operation: randomUUID(), p_product_id: input.id, p_expected_revision: revision });
  const read = async () => {
    const { data, error } = await admin.from('products').select('*, product_variants(*)').eq('id', input.id).single();
    if (error || !data || data.stripe_sync_revision !== revision || data.archived_at) throw Error('Revision geändert oder Produkt archiviert. Bitte neu laden.');
    return data;
  };
  progress('Prüfung läuft');
  let product = await read();
  validateProductDraft({ ...product, short_description: product.short_description ?? '', description: product.description ?? '',
    primary_image_path: product.primary_image_path ?? '', variants: product.product_variants });
  if (product.slug === 'metal-case' || !product.product_variants.some((v: { is_active: boolean }) => v.is_active)) throw Error('Veröffentlichung gesperrt. Produkt und aktive Varianten prüfen.');
  // A published product is only a confirmed retry. Editing must first use draft save.
  if (product.is_active && product.stripe_sync_status !== 'synced') throw Error('Bitte das Produkt zuerst als Entwurf speichern.');
  if (!await authorize()) throw Error('Keine Berechtigung für die Produktverwaltung.');
  progress('Stripe wird synchronisiert');
  if (product.stripe_sync_status !== 'synced') {
    let result;
    try { result = await synchronizeProduct(stripe, product as SyncProduct); }
    catch {
      await admin.rpc('admin_product_sync_result_v1', { ...common(), p_stripe_product_id: null, p_prices: [], p_error: 'Stripe-Abgleich fehlgeschlagen. Erneut prüfen und veröffentlichen.' });
      throw Error('Stripe-Abgleich fehlgeschlagen. Bitte den aktuellen Veröffentlichungsstatus prüfen.');
    }
    if (!await authorize()) throw Error('Keine Berechtigung für die Produktverwaltung.');
    const saved = await admin.rpc('admin_product_sync_result_v1', { ...common(), p_stripe_product_id: result.productId, p_prices: result.prices, p_error: null });
    if (saved.error) throw Error('Stripe-Abgleich konnte nicht gespeichert werden. Bitte neu laden und erneut versuchen.');
    // Revision-zero compatibility products advance to revision one on synchronization.
    revision = saved.data.revision;
    product = await read();
  }
  progress('Stripe-Zuordnung wird geprüft');
  try { await verifyProductStripeMapping(stripe, product as SyncProduct); }
  catch { throw Error('Stripe-Zuordnung konnte nicht bestätigt werden. Veröffentlichung gesperrt. Bitte Zuordnung prüfen.'); }
  if (!await authorize()) throw Error('Keine Berechtigung für die Produktverwaltung.');
  // A thrown request or error response can follow a committed transaction. Read,
  // never retry this write and never infer draft from transport failure.
  try { await admin.rpc('admin_product_state_v1', { ...common(), p_operation: input.operationId, p_action: 'published' }); }
  catch { /* Authoritative status below resolves an accepted-but-lost response. */ }
  const confirmed = await readProductPublicationStatus(admin, input.id);
  if (confirmed.status === 'unknown') throw Error(UNCLEAR_PUBLICATION_STATUS);
  if (confirmed.status !== 'published') throw Error(confirmed.status === 'draft'
    ? 'Veröffentlichung nicht bestätigt. Aktueller Status: Entwurf.' : 'Aktueller Status: Archiviert.');
  progress('Veröffentlichung abgeschlossen');
  return { ok: true, id: input.id, revision: confirmed.revision, published: true };
}
