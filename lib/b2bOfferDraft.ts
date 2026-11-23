const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseB2bOfferTerms(id: unknown, packCount: unknown, netUnitCents: unknown) {
  if (typeof id !== 'string' || !uuid.test(id) ||
      typeof packCount !== 'number' || !Number.isInteger(packCount) || packCount < 1 || packCount > 100000 ||
      typeof netUnitCents !== 'number' || !Number.isInteger(netUnitCents) || netUnitCents < 1 || netUnitCents > 10000000) {
    return null;
  }
  return { id: id.toLowerCase(), pack_count: packCount, net_unit_cents: netUnitCents };
}

export function parseB2bOfferDraft(input: unknown) {
  if (!input || typeof input !== 'object') return null;
  const { id, customerId, inquiryReference, destinationCountry, packCount, netUnitCents } =
    input as Record<string, unknown>;
  const terms = parseB2bOfferTerms(id, packCount, netUnitCents);
  if (!terms || typeof customerId !== 'string' || !uuid.test(customerId) ||
      typeof inquiryReference !== 'string' || !inquiryReference.trim() || inquiryReference.trim().length > 200 ||
      typeof destinationCountry !== 'string' || !/^[A-Z]{2}$/.test(destinationCountry)) {
    return null;
  }
  return {
    ...terms,
    customer_id: customerId.toLowerCase(),
    inquiry_reference: inquiryReference.trim(),
    destination_country: destinationCountry,
  };
}
