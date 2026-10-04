import { resolveAffiliateLink, resolveAffiliateCode } from './creatorAffiliate';

/** A public reference is a request, never an authoritative creator or amount. */
export async function affiliateCheckoutMetadata(slug?: unknown, code?: unknown): Promise<Record<string,string>> {
  const reference = typeof slug === 'string' && slug.trim() ? slug.trim() : typeof code === 'string' ? code.trim() : '';
  if (!reference || reference.length > 120) return {};
  const isLink = typeof slug === 'string' && !!slug.trim();
  const resolved = await (isLink ? resolveAffiliateLink(reference) : resolveAffiliateCode(reference));
  if (!resolved) throw new Error('Affiliate lookup unavailable');
  if (resolved.result !== 'active') return {};
  return isLink ? {affiliate_slug:reference} : {affiliate_code:reference};
}
