/** Configuration only; earned commissions are never accepted from the browser. */
export function affiliateConfiguration(body: Record<string, unknown>, now = new Date()) {
  const type = body.action === 'create_affiliate_code' || (body.action === 'edit_affiliate' && body.type === 'code') ? 'code' : 'link';
  const reference = typeof body[type === 'link' ? 'slug' : 'code'] === 'string' ? String(body[type === 'link' ? 'slug' : 'code']).trim() : '';
  const pattern = type === 'link' ? /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/ : /^[A-Za-z0-9][A-Za-z0-9_-]{1,38}[A-Za-z0-9]$/;
  if (!pattern.test(reference)) throw new Error(type === 'link' ? 'Slug: 3–50 Zeichen, Kleinbuchstaben, Ziffern und Bindestriche; Anfang und Ende ohne Bindestrich.' : 'Code: 3–40 Buchstaben, Ziffern, Bindestriche oder Unterstriche.');
  const starts = typeof body.startsAt === 'string' && body.startsAt ? new Date(body.startsAt) : now;
  const ends = typeof body.endsAt === 'string' && body.endsAt ? new Date(body.endsAt) : null;
  if (!Number.isFinite(starts.getTime()) || (ends && (!Number.isFinite(ends.getTime()) || ends <= starts))) throw new Error('Ende muss nach Beginn liegen.');
  if (body.status !== undefined && !['active', 'paused'].includes(String(body.status))) throw new Error('Ungültiger Status.');
  return {type, reference, starts_at: starts.toISOString(), ends_at: ends?.toISOString() ?? null, active: body.status !== 'paused'};
}
