type Extraction = Record<string, string | number>;

export function normalizeDocumentExtraction(value: unknown): Extraction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid extraction');
  const input = value as Record<string, unknown>;
  const result: Extraction = {};
  for (const [key, limit] of [['issuer',200],['invoiceNumber',120],['reference',200]] as const) {
    const field = input[key];
    if (typeof field === 'string' && field.trim() && field.trim().length <= limit) result[key] = field.trim();
  }
  for (const key of ['issuedOn','serviceOn']) {
    const field = input[key];
    if (typeof field === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(field) &&
        Number.isFinite(Date.parse(field)) && new Date(field).toISOString().slice(0,10) === field) result[key] = field;
  }
  if (typeof input.currency === 'string' && /^[A-Z]{3}$/.test(input.currency)) result.currency = input.currency;
  const validAmount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 2147483647;
  const {grossCents,netCents,taxCents} = input;
  if (result.currency && validAmount(grossCents)) {
    result.grossCents = grossCents;
    if (validAmount(netCents) && validAmount(taxCents) && netCents+taxCents===grossCents) {
      result.netCents=netCents;
      result.taxCents=taxCents;
    }
  }
  if (typeof input.paymentHint === 'string' && input.paymentHint.trim() && input.paymentHint.length <= 200) {
    result.paymentHint = input.paymentHint.trim();
  }
  return result;
}

export async function extractDocument(file: File, env = process.env, request = fetch) {
  const endpoint = env.GLOA_DOCUMENT_EXTRACTION_URL;
  const token = env.GLOA_DOCUMENT_EXTRACTION_TOKEN;
  if (env.GLOA_DOCUMENT_EXTRACTION_ENABLED !== 'true' || !endpoint || !token) return null;
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('Invalid extraction endpoint');
  const response = await request(url, {
    method:'POST', headers:{Authorization:'Bearer '+token,'Content-Type':file.type},
    body:file, redirect:'error', cache:'no-store', signal:AbortSignal.timeout(10000),
  });
  if (!response.ok || !response.body) throw Error('Extraction unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 16384) throw Error('Extraction too large');
      chunks.push(value);
    }
    return normalizeDocumentExtraction(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally {
    await reader.cancel().catch(()=>{});
  }
}
