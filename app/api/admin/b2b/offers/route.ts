import { buildB2bOfferContract } from "../../../../../lib/b2bOfferContract";
import { notifyB2bOffer } from "../../../../../lib/b2bOfferNotification.server";
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
  const inactive = () => json({ error: 'Angebotsaktionen sind noch nicht freigegeben.' }, 503);
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
      if (result.error.message === 'release_writes_disabled') return inactive();
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
    const offer = await admin.from('b2b_offer_versions')
      .select('pack_count,net_unit_cents,destination_country').eq('draft_id', id).eq('version', input.version).maybeSingle();
    if (offer.error) return json({ error: 'Angebotskonditionen nicht verfügbar.' }, 503);
    if (!offer.data) return json({ error: 'Angebotsversion nicht verfügbar.' }, 409);
    const contract = buildB2bOfferContract(offer.data, input);
    if (!contract.ok) {
      const reasons: Record<string, string> = {
        plan_type_unsupported: 'Vertragsmodell auswählen.',
        quantity_not_self_service: 'Menge liegt außerhalb des vorhandenen Checkout-Modells.',
        monthly_takes_no_instalments: 'Monatliche Verträge haben keine Raten.',
        instalment_count_unsupported: 'Für den Jahresvertrag 1, 2 oder 4 Zahlungen auswählen.',
        country_not_supported: 'Internationale Steuer- und Lieferfreigabe fehlt.',
        postcode_malformed: 'Gültige Liefer-PLZ erforderlich.',
        shipping_unavailable: 'Für diese PLZ fehlt ein freigegebenes Versandmodell.',
        price_not_supported: 'Stückpreis stimmt nicht mit dem freigegebenen Checkout-Preis überein.',
      };
      return json({ error: reasons[contract.reason] ?? 'Vertragskonditionen nicht bestätigt.' }, 409);
    }
    const { data, error } = await admin.rpc('b2b_offer_publish_with_terms_v1', {
      p_draft: id, p_version: input.version, p_actor: gate.context.identity.userId, p_evidence: input.evidence, p_terms: contract.terms,
    });
    if (!error) {
      const notification = await notifyB2bOffer(admin, id, input.version);
      return json({ expiresAt: data, notification });
    }
    if (error.message === 'release_writes_disabled') return inactive();
    if (error.code === '42501') return json({ error: 'Nur der Owner darf Angebote freigeben.' }, 403);
    if (error.message === 'offer_tax_review_required') {
      return json({ error: 'Steuerliche Freigabe fehlt.' }, 409);
    }
    if (error.message === 'offer_not_available') return json({ error: 'Angebotsstand hat sich geändert.' }, 409);
    return json({ error: 'Veröffentlichung nicht bestätigt.' }, 503);
  }
  if (body?.action === 'list') {
    const { data, error } = await admin.from('b2b_offer_drafts').select(`${columns},versions:b2b_offer_versions(version,state,pack_count,net_unit_cents,expires_at)`)
      .order('created_at', { ascending: false }).order('id').limit(30);
    if (error) return json({ error: 'Entwürfe konnten nicht geladen werden.' }, 503);
    const acceptedIds = (data ?? []).filter(row => row.versions.some(v => v.state === 'accepted')).map(row => row.id);
    if (!acceptedIds.length) return json({ drafts: data });
    const [linkResult, handoffResult] = await Promise.all([
      admin.from('b2b_offer_checkout_links').select('draft_id,version,request_id').in('draft_id', acceptedIds),
      admin.from('b2b_offer_contract_handoffs').select('draft_id,version,contract_terms').in('draft_id', acceptedIds),
    ]);
    if (linkResult.error || handoffResult.error) return json({ error: 'Checkout-Status konnte nicht geladen werden.' }, 503);
    const links = linkResult.data ?? [];
    const attemptResult = links.length ? await admin.from('checkout_attempts')
      .select('request_id,status').in('request_id', links.map(link => link.request_id)) : null;
    if (attemptResult?.error) return json({ error: 'Checkout-Status konnte nicht geladen werden.' }, 503);
    return json({ drafts: (data ?? []).map(row => ({ ...row, versions: row.versions.map(version => {
      if (version.state !== 'accepted') return version;
      const terms = handoffResult.data?.find(entry => entry.draft_id === row.id && entry.version === version.version)?.contract_terms;
      if (!terms) return { ...version, checkout_status: 'terms_missing' };
      const link = links.find(entry => entry.draft_id === row.id && entry.version === version.version);
      return link ? { ...version, checkout_status: attemptResult?.data?.find(attempt => attempt.request_id === link.request_id)?.status
        ?? 'address_bound' } : version;
    }) })) });
  }
  const draft = body?.action === 'create' && parseB2bOfferDraft(body);
  if (!draft) return json({ error: 'Ungültiger Angebotsentwurf.' }, 400);

  const actor = gate.context.identity.userId;
  const inserted = await admin.from('b2b_offer_drafts').insert({ ...draft, created_by: actor })
    .select(columns).single();
  if (!inserted.error) return json({ draft: inserted.data }, 201);
  if (inserted.error.message === 'release_writes_disabled') return inactive();
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
