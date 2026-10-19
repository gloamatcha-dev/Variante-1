import { requireAdminIdentity } from '../../../../lib/adminActionRoute';
import { getSupabaseAdmin } from '../../../../lib/supabaseAdmin';
import { getStripeClient } from '../../../../lib/stripe';
import { isProductUuid, validateProductDraft } from '../../../../lib/productManagerRules';
import { synchronizeProduct, type SyncProduct } from '../../../../lib/productStripeSync';
import { canWrite } from '../../../../lib/adminRoles';
import { uploadProductImage } from '../../../../lib/productImageUpload';

export async function POST(request: Request): Promise<Response> {
  // Auth before reading a bounded form payload. Viewer reads are explicitly supported.
  const gate = await requireAdminIdentity(request, "read");
  if (!gate.ok) return gate.response;
  if (new URL(request.url).searchParams.get('action') === 'upload-image') {
    const uploadGate = await requireAdminIdentity(request, "write");
    if (!uploadGate.ok) return uploadGate.response;
    const storageAdmin = getSupabaseAdmin();
    if (!storageAdmin) return Response.json({ error: 'Bild-Upload nicht verfügbar.' }, { status: 503 });
    return uploadProductImage(request, storageAdmin, uploadGate.session.userId);
  }
  const admin = getSupabaseAdmin();
  if (!admin) return Response.json({ error: 'Katalog nicht verfügbar.' }, { status: 503 });
  try {
    const raw = await request.text();
    if (raw.length > 100000) throw new Error('Formular zu groß.');
    const body = JSON.parse(raw);
    if (body.action === 'list') {
      const [products, inventory] = await Promise.all([
        admin.from('products').select('*, product_variants(*)').order('sort_order').order('name'),
        admin.from('inventory_items').select('id,name,unit,current_quantity,is_active').order('name'),
      ]);
      if (products.error || inventory.error) throw new Error('Katalog konnte nicht geladen werden.');
      return Response.json({ products: products.data, inventory: inventory.data, canWrite: canWrite(gate.identity.role) },
        { headers: { 'Cache-Control': 'no-store' } });
    }
    const writeGate = await requireAdminIdentity(request, "write");
    if (!writeGate.ok) return writeGate.response;
    if (!isProductUuid(body.id) || !isProductUuid(body.operationId) || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new Error('Ungültige Anfrage.');
    const common = { p_actor: writeGate.session.userId, p_operation: body.operationId, p_product_id: body.id, p_expected_revision: body.revision };
    if (body.action === 'save') {
      const document = validateProductDraft(body.document);
      // Local paths must refer to an actual bundled public image. HTTPS renders via native <img>.
      if (document.primary_image_path.startsWith('/')) {
        const { existsSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        if (!existsSync(resolve('public', document.primary_image_path.slice(1)))) throw new Error('Bilddatei nicht vorhanden.');
      }
      const result = await admin.rpc('admin_save_product_v1', { ...common, p_document: document });
      if (result.error) return Response.json({ error: 'Speichern fehlgeschlagen. Neu laden; SKU und Revision prüfen.' }, { status: 409 });
      return Response.json({ ok: true, ...result.data });
    }
    if (body.action === 'sync') {
      const { data, error } = await admin.from('products').select('*, product_variants(*)').eq('id', body.id).single();
      if (error || !data || data.stripe_sync_revision !== body.revision || data.archived_at) throw new Error('Veraltete Revision. Neu laden.');
      if (data.stripe_sync_status === 'synced') return Response.json({ ok: true, revision: body.revision });
      const stripe = getStripeClient();
      if (!stripe) throw new Error('Stripe nicht konfiguriert.');
      let result;
      try { result = await synchronizeProduct(stripe, data as SyncProduct); }
      catch {
        const failed = await admin.rpc('admin_product_sync_result_v1', { ...common, p_stripe_product_id: null, p_prices: [], p_error: 'Stripe-Abgleich fehlgeschlagen. Erneut versuchen.' });
        if (failed.error) return Response.json({ error: 'Revision geändert. Neu laden.' }, { status: 409 });
        return Response.json({ error: 'Stripe-Abgleich fehlgeschlagen. Entwurf bleibt unveröffentlicht.' }, { status: 502 });
      }
      const saved = await admin.rpc('admin_product_sync_result_v1', { ...common, p_stripe_product_id: result.productId, p_prices: result.prices, p_error: null });
      if (saved.error) return Response.json({ error: 'Abgleich nicht gespeichert. Neu laden und erneut versuchen.' }, { status: 409 });
      return Response.json({ ok: true, ...saved.data });
    }
    if (body.action === 'publish' || body.action === 'archive') {
      const result = await admin.rpc('admin_product_state_v1', { ...common, p_action: body.action === 'publish' ? 'published' : 'archived' });
      if (result.error) return Response.json({ error: 'Status nicht geändert. Revision und Stripe-Abgleich prüfen.' }, { status: 409 });
      // New sessions are blocked atomically by archive. Existing payable Sessions are
      // intentionally not expired here: v1 has no bounded, race-safe attempt index by product.
      return Response.json({ ok: true, ...result.data });
    }
    throw new Error('Unbekannte Aktion.');
  } catch (error) {
    return Response.json({ error: error instanceof SyntaxError ? 'Ungültiges JSON.' : error instanceof Error ? error.message : 'Aktion fehlgeschlagen.' }, { status: 400 });
  }
}
