import { openAdminAction } from '../../../../../lib/adminActionRoute.ts';
import { parseB2bOfferDraft, parseB2bOfferId, parseB2bOfferTerms } from '../../../../../lib/b2bOfferDraft.ts';
import { getSupabaseAdmin } from '../../../../../lib/supabaseAdmin';

const columns = 'id,customer_id,inquiry_reference,destination_country,pack_count,net_unit_cents,valid_days,created_at';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: Request) {
  const gate = await openAdminAction(request);
  if (!gate.ok) return gate.response;
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    return json({ error: 'Ungültiger Anfrageursprung.' }, 403);
  }
  const admin = getSupabaseAdmin();
  if (!admin) return json({ error: 'Angebotsentwürfe sind nicht verfügbar.' }, 503);

  const body = gate.context.body as { action?: unknown } | null;
  if (body?.action === 'revise') {
    const input = body as Record<string, unknown>;
    const terms = parseB2bOfferTerms(input.id, input.packCount, input.netUnitCents);
    if (!terms || typeof input.expectedVersion !== 'number' ||
        !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 ||
        input.expectedVersion >= 2147483647) {
      return json({ error: 'Ungültige Angebotsversion.' }, 400);
    }
    const result = await admin.rpc('b2b_offer_revise_v1', {
      p_draft: terms.id, p_expected: input.expectedVersion, p_actor: gate.context.identity.userId,
      p_quantity: terms.pack_count, p_net: terms.net_unit_cents,
    });
    if (result.error) {
      const conflict = ['offer_revision_conflict', 'offer_already_accepted', 'offer_not_found'].includes(result.error.message);
      return json({ error: conflict ? 'Angebotsstand hat sich geändert.' : 'Revision nicht bestätigt.' }, conflict ? 409 : 503);
    }
    return json({ version: result.data }, 201);
  }
  if (body?.action === 'publish') {
    const input = body as Record<string, unknown>;
    const id = parseB2bOfferId(input.id);
    if (!id || typeof input.version !== 'number' || !Number.isInteger(input.version) ||
        input.version < 1 || input.version > 2147483647 || typeof input.evidence !== 'string' ||
        !input.evidence.trim() || input.evidence.trim().length > 200) {
      return json({ error: 'Angebotsversion und Nachweisreferenz erforderlich.' }, 400);
    }
    const { data, error } = await admin.rpc('b2b_offer_publish_v1', {
      p_draft: id, p_version: input.version, p_actor: gate.context.identity.userId, p_evidence: input.evidence,
    });
    if (!error) return json({ expiresAt: data });
    if (error.code === '42501') return json({ error: 'Nur der Owner darf Angebote freigeben.' }, 403);
    if (error.message === 'offer_tax_review_required') {
      return json({ error: 'Steuerliche Freigabe fehlt.' }, 409);
    }
    if (error.message === 'offer_not_available') return json({ error: 'Angebotsstand hat sich geändert.' }, 409);
    return json({ error: 'Veröffentlichung nicht bestätigt.' }, 503);
  }
  if (body?.action === 'list') {
    const { data, error } = await admin.from('b2b_offer_drafts').select(columns + ',versions:b2b_offer_versions(version,state,pack_count,net_unit_cents,expires_at)')
      .order('created_at', { ascending: false }).order('id').limit(30);
    return error ? json({ error: 'Entwürfe konnten nicht geladen werden.' }, 503) : json({ drafts: data });
  }
  const draft = body?.action === 'create' && parseB2bOfferDraft(body);
  if (!draft) return json({ error: 'Ungültiger Angebotsentwurf.' }, 400);

  const actor = gate.context.identity.userId;
  const inserted = await admin.from('b2b_offer_drafts').insert({ ...draft, created_by: actor })
    .select(columns).single();
  if (!inserted.error) return json({ draft: inserted.data }, 201);
  if (inserted.error.code === '23503') return json({ error: 'Geschäftskunde nicht gefunden.' }, 409);
  if (inserted.error.code !== '23505') return json({ error: 'Speicherung nicht bestätigt.' }, 503);

  const existing = await admin.from('b2b_offer_drafts').select(columns).eq('id', draft.id)
    .eq('created_by', actor).maybeSingle();
  if (existing.error) return json({ error: 'Speicherung nicht bestätigt.' }, 503);
  const stored = existing.data as Record<string, unknown> | null;
  if (stored && Object.entries(draft).every(([key, value]) => stored[key] === value)) {
    return json({ draft: stored });
  }
  return json({ error: 'Entwurfskennung gehört zu einer anderen Anfrage.' }, 409);
}
