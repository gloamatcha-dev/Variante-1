const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseB2bOfferDraft(input: unknown) {
  if (!input || typeof input !== 'object') return null;
  const { id, customerId, inquiryReference, destinationCountry, packCount, netUnitCents } =
    input as Record<string, unknown>;
  if (typeof id !== 'string' || !uuid.test(id) ||
      typeof customerId !== 'string' || !uuid.test(customerId) ||
      typeof inquiryReference !== 'string' || !inquiryReference.trim() || inquiryReference.trim().length > 200 ||
      typeof destinationCountry !== 'string' || !/^[A-Z]{2}$/.test(destinationCountry) ||
      typeof packCount !== 'number' || !Number.isInteger(packCount) || packCount < 1 || packCount > 100000 ||
      typeof netUnitCents !== 'number' || !Number.isInteger(netUnitCents) || netUnitCents < 1 || netUnitCents > 10000000) {
    return null;
  }
  return {
    id: id.toLowerCase(),
    customer_id: customerId.toLowerCase(),
    inquiry_reference: inquiryReference.trim(),
    destination_country: destinationCountry,
    pack_count: packCount,
    net_unit_cents: netUnitCents,
  };
}
