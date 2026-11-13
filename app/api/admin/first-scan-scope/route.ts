import {requireAdminIdentity} from '../../../../lib/adminActionRoute.ts';
import {canAccessProductManager} from '../../../../lib/productOwnerAccess';
import {firstScanDeploymentIdentity, verifyFirstScanRuntimeScope} from '../../../../lib/financeFirstScanDiagnostic.ts';

const respond = (body: unknown, status: number) => Response.json(body, {
 status, headers: {'Cache-Control': 'no-store'},
});

/** Explicit owner-only read diagnostic. Authentication reads are its only I/O. */
export async function POST(request: Request) {
 const fail = (reasonCode: string, status: number) => respond({
  status: 'FAIL', reasonCode, deployment: firstScanDeploymentIdentity(process.env),
 }, status);
 try {
  const gate = await requireAdminIdentity(request, 'read');
  if (!gate.ok) return fail('AUTHENTICATION_REQUIRED', gate.response.status);
  if (request.headers.get('origin') !== new URL(request.url).origin) return fail('ORIGIN_DENIED', 403);
  if (gate.identity.role !== 'owner' || !await canAccessProductManager(gate.identity)) return fail('OWNER_REQUIRED', 403);
  // Bound the stream before parsing; do not read unauthenticated request bodies.
  const reader = request.body?.getReader();
  if (!reader) return fail('REQUEST_INVALID', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
   while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2048) { await reader.cancel(); return fail('REQUEST_INVALID', 400); }
    chunks.push(value);
   }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
  catch { return fail('REQUEST_INVALID', 400); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
   || Object.keys(payload).join(',') !== 'expected') return fail('REQUEST_INVALID', 400);
  const result = verifyFirstScanRuntimeScope((payload as {expected: unknown}).expected, process.env);
  return respond(result, result.status === 'PASS' ? 200 : result.reasonCode === 'EXPECTED_SCOPE_INVALID' ? 400 : 409);
 } catch { return fail('DIAGNOSTIC_UNAVAILABLE', 503); }
}
