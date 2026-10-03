/** Rule configuration and presentation only, never an order commission calculation. */
export function commissionValueConfiguration(type: unknown, raw: unknown) {
  if (!['percentage', 'fixed'].includes(String(type))) throw new Error('Bitte eine Berechnungsart wählen.');
  if (typeof raw !== 'string' || !/^\d+(?:[,.]\d{1,2})?$/.test(raw.trim())) throw new Error('Bitte einen positiven Wert mit höchstens zwei Nachkommastellen eingeben.');
  const [whole, fraction = ''] = raw.trim().replace(',', '.').split('.');
  const value = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, '0'));
  // Existing SQL: percentage <= 10000 bp; fixed_cents is PostgreSQL integer.
  const max = type === 'percentage' ? BigInt(10000) : BigInt(2147483647);
  if (value <= BigInt(0) || value > max) throw new Error(type === 'percentage' ? 'Provision muss größer als 0 und höchstens 100 % sein.' : 'Betrag muss positiv sein und in das vorhandene Cent-Feld passen.');
  return {percentBasisPoints: type === 'percentage' ? Number(value) : null, fixedCents: type === 'fixed' ? Number(value) : null};
}

export function validateCommissionRule(body: Record<string, unknown>) {
  const percentage = body.percentBasisPoints ?? null, fixed = body.fixedCents ?? null;
  const integer = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= max;
  if ((percentage === null) === (fixed === null) || (percentage !== null && !integer(percentage, 10000)) || (fixed !== null && !integer(fixed, 2147483647))) throw new Error('Genau eine positive Provision als Basispunkte oder Cent angeben.');
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label || Array.from(label).length > 120) throw new Error('Regelname muss 1 bis 120 Zeichen enthalten.');
  if (!['merchandise_net', 'merchandise_gross', 'order_gross'].includes(String(body.base))) throw new Error('Bitte die Bemessungsgrundlage wählen.');
  return {label, percent_basis_points: percentage, fixed_cents: fixed, base: String(body.base)};
}

export function commissionRuleSummary(rule: Record<string, unknown> | null | undefined) {
  if (typeof rule?.percent_basis_points === 'number') return `${new Intl.NumberFormat('de-DE', {maximumFractionDigits: 2}).format(rule.percent_basis_points / 100)} % pro bezahlter Bestellung`;
  if (typeof rule?.fixed_cents === 'number') return `${new Intl.NumberFormat('de-DE', {style: 'currency', currency: 'EUR'}).format(rule.fixed_cents / 100)} pro bezahlter Bestellung`;
  return 'Keine Berechnung erfasst';
}

/** Editable decimal text reconstructed from stored integers, without float arithmetic. */
export function commissionRuleInputValue(rule: Record<string, unknown> | undefined) {
  const value = rule?.fixed_cents ?? rule?.percent_basis_points;
  if (typeof value !== 'number' || !Number.isInteger(value)) return '';
  const digits = String(value).padStart(3,'0');
  return `${digits.slice(0,-2)},${digits.slice(-2)}`;
}
