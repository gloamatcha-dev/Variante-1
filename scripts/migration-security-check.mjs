// Offline review gate. Never connects to a database or executes SQL.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BASELINE = '6db7c37b693991617a392b26c5937114879a8f75';
export const roles = ['PUBLIC', 'anon', 'authenticated', 'service_role'];
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = value => [...value].sort();

// Mask comments, strings and function bodies before looking for top-level DDL.
// Unhandled/dynamic DDL fails closed; this is intentionally not a SQL interpreter.
export function maskSQL(sql) {
  let out = '', i = 0;
  while (i < sql.length) {
    const tail = sql.slice(i);
    let end;
    if (tail.startsWith('--')) end = sql.indexOf('\n', i + 2);
    else if (tail.startsWith('/*')) {
      let depth = 1, j = i + 2;
      while (j < sql.length && depth) {
        if (sql.slice(j, j + 2) === '/*') { depth++; j += 2; }
        else if (sql.slice(j, j + 2) === '*/') { depth--; j += 2; }
        else j++;
      }
      if (depth) throw new Error('Unterminated SQL comment');
      end = j;
    } else if (sql[i] === "'") {
      let j = i + 1, closed = false;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          j++; closed = true; break;
        }
        j++;
      }
      if (!closed) throw new Error('Unterminated SQL literal');
      end = j;
    } else {
      const dollar = tail.match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)?.[0];
      if (dollar) {
        const close = sql.indexOf(dollar, i + dollar.length);
        if (close < 0) throw new Error('Unterminated dollar body');
        end = close + dollar.length;
      }
    }
    if (end !== undefined) {
      if (end < 0) end = sql.length;
      out += ' '.repeat(end - i); i = end;
    } else { out += sql[i++]; }
  }
  return out;
}

export function checkReview(sql, contract, metadata) {
  const errors = [], fail = message => errors.push(message);
  if (contract.version !== 1 || metadata.version !== 1) fail('Unsupported review/metadata version');
  if (contract.sqlSha256 !== sha256(sql) || metadata.sqlSha256 !== sha256(sql)) fail('SQL hash mismatch');
  if (!contract.reviewer || !contract.callerReview || !metadata.provenance) fail('Missing reviewer, caller review or metadata provenance');
  let masked;
  try { masked = maskSQL(sql); } catch (e) { return [...errors, e.message]; }
  if(contract.kind==='automatic-finance-sync'){
    const tables=['finance_sync_config','finance_sync_periods','finance_sync_jobs','finance_sync_sources','finance_sync_approvals','finance_sync_alerts','finance_sync_discrepancies'];
    const functions=['claim','checkpoint','stage','discrepancy','basis','status','source_read','retry_ids','record','failure','finish','alert','details','period'].map(n=>'finance_sync_'+n+'_v1');
    const internal=['order_payment','annual_payment','refund_tax','provider_fee','expense_guard'].map(n=>'finance_sync_'+n+'_v1');
    const declaredTables=[...masked.matchAll(/\bcreate\s+table\s+public\.(finance_sync_[a-z_]+)/gi)].map(m=>m[1]);
    const declaredFunctions=[...masked.matchAll(/\bcreate\s+(?:or\s+replace\s+)?function\s+public\.([a-z0-9_]+)/gi)].map(m=>m[1]);
    if(!same(sorted(declaredTables),sorted(tables))||!same(sorted(declaredFunctions),sorted([...functions,...internal,'record_provider_fee_result_v1'])))fail('Unexpected finance migration object inventory');
    if(/\bgrant\s+all\b|\bon\s+all\s+(?:tables|sequences|functions)\b|\balter\s+default\s+privileges|\bcreate\s+(?:view|policy|schema)\b|\bdrop\s+(?:table|function|schema)\b/i.test(masked))fail('Finance migration cannot widen browser/default grants or drop existing objects');
    const proof=metadata.realPostgresEvidence;
    if(!proof||proof.sqlSha256!==sha256(sql)||proof.migration084Executed!==false||metadata.migrations001To083Unchanged!==true)fail('Missing exact real PostgreSQL finance evidence');
    if(!same(sorted((metadata.tables??[]).map(t=>t.name)),sorted(tables)))fail('Missing finance table catalog');
    for(const t of metadata.tables??[])if(t.rls!==true||t.anon!==false||t.authenticated!==false||t.serviceWrite!==false||t.serviceSelect!==(t.name!=='finance_sync_approvals'))fail('Invalid finance table role grants: '+t.name);
    if(!same(sorted((metadata.functions??[]).map(f=>f.name)),sorted([...functions,...internal])))fail('Missing finance function catalog');
    for(const f of metadata.functions??[])if(f.PUBLIC!==false||f.anon!==false||f.authenticated!==false||f.definer!==true||!f.searchPath?.includes('search_path=""')||f.service!==functions.includes(f.name))fail('Invalid finance function authority: '+f.name);
    for(const required of ['parallel new source produces exactly one money record','interrupted transaction rolls back ledger and source bridge','historical import requires explicit approval','closed period queues a correction without rewriting history','stale worker cannot write','refunded annual plan cannot fulfill delivery','all new tables have RLS'])if(!proof?.passed?.includes(required))fail('Missing real finance regression: '+required);
    return errors;
  }
  if (contract.kind === 'order-number-execute-restriction') {
    // Explicit narrow review path for the demonstrated correction, not a generic
    // manual-review bypass for functions, DO blocks or arbitrary schema changes.
    const normalized = masked.trim().replace(/\s+/g, ' ').toLowerCase();
    if (normalized !== 'begin; revoke execute on function public.generate_order_number() from public, anon, authenticated; commit;') fail('Only the exact tested order-number EXECUTE restriction is permitted');
    if (contract.signature !== 'public.generate_order_number()' || metadata.signature !== contract.signature) fail('Function signature mismatch');
    if (!metadata.realPostgresEvidence || metadata.owner !== 'postgres' || metadata.securityDefiner !== true || metadata.unrelatedCatalogUnchanged !== true || metadata.sequenceUnchangedByPatch !== true) fail('Missing real PostgreSQL owner/context/immutability evidence');
    if (!metadata.after || metadata.after.PUBLIC !== false || metadata.after.anon !== false || metadata.after.authenticated !== false || metadata.after.service_role !== false || metadata.after.owner !== true) fail('Function effective privileges do not match reviewed restriction');
    if (!Array.isArray(metadata.testsPassed) || !metadata.testsPassed.includes('patch reapplication idempotent') || !metadata.testsPassed.includes('after annual fulfillment/replay') || !metadata.testsPassed.includes('after one numbered subscription order')) fail('Missing settlement/idempotency evidence');
    return errors;
  }
  if (/\b(?:do|execute)\b|\b(?:create|alter)\s+(?:function|procedure|view|materialized|schema)|\balter\s+default\s+privileges|\binherits\b|\bpartition\b|\bcreate\s+table\s+[^;]+\bas\s+select\b|"|\\/i.test(masked)) {
    fail('Unsupported SQL: separate manual function/view/dynamic/quoted-DDL review required');
  }
  if (/\bgrant\s+all\b|\bon\s+all\s+(?:tables|sequences|functions)\b/i.test(masked)) fail('Blanket grants forbidden');
  // Deliberately accept only single, schema-qualified privilege targets.
  for (const statement of masked.split(';').filter(s => /^\s*(grant|revoke)\b/i.test(s))) {
    if (!/\bon\s+(?:(?:table|sequence)\s+)?[a-z_][a-z_0-9]*\.[a-z_][a-z_0-9]*\s+(?:to|from)\b/i.test(statement)) fail('Privilege target requires single schema-qualified object review');
  }
  const creates = [...masked.matchAll(/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z_0-9]*)\.([a-z_][a-z_0-9]*)/gi)].map(m => `${m[1]}.${m[2]}`.toLowerCase());
  const createCount = [...masked.matchAll(/\bcreate\s+table\b/gi)].length;
  if (createCount !== creates.length) fail('New tables must use explicit schema names');
  const tables = contract.tables ?? [], actual = metadata.tables ?? [];
  if (new Set(tables.map(t => t.name)).size !== tables.length) fail('Duplicate table reviews');
  if (!same(sorted(tables.map(t => t.name)), sorted(actual.map(t => t.name)))) fail('Metadata/review table inventory mismatch');
  for (const name of creates) if (!tables.some(t => t.name === name)) fail(`Unreviewed new table ${name}`);
  if (/\b(?:alter\s+table|drop\s+table|grant|revoke|create\s+policy|alter\s+policy|drop\s+policy)\b/i.test(masked) && !tables.length) fail('Changed permissions/objects need table review');
  // Every explicitly referenced table must be included, including existing tables.
  const refs = [...masked.matchAll(/\b(?:alter\s+table(?:\s+only)?|drop\s+table(?:\s+if\s+exists)?|on\s+(?:table\s+)?)\s+([a-z_][a-z_0-9]*\.[a-z_][a-z_0-9]*)/gi)].map(m => m[1].toLowerCase());
  for (const name of refs) if (!(contract.sequences ?? []).some(s => s.name === name) && !tables.some(t => t.name === name)) fail(`Unreviewed referenced object ${name}`);
  for (const table of tables) {
    const live = actual.find(t => t.name === table.name);
    if (!table.callers?.length || !table.reason || !table.grantReview || !table.owner) fail(`${table.name}: missing caller/owner/grant review`);
    if (!live) continue;
    if (table.owner !== live.owner) fail(`${table.name}: owner mismatch`);
    if (['public', ...(contract.exposedSchemas ?? [])].includes(table.name.split('.')[0]) && !live.rls) fail(`${table.name}: exposed table lacks RLS`);
    if (!Array.isArray(table.policies) || !same(table.policies, live.policies)) fail(`${table.name}: policy definition mismatch`);
    if (table.mode === 'rpc-only' && (!table.rpc || !table.reason)) fail(`${table.name}: RPC-only dependency undocumented`);
    if (!['rpc-only', 'server-direct', 'browser'].includes(table.mode)) fail(`${table.name}: invalid access mode`);
    for (const role of roles) {
      const allowed = table.allowed?.[role], required = table.required?.[role], grants = live.grants?.[role];
      if (!Array.isArray(allowed) || !Array.isArray(required) || !Array.isArray(grants)) { fail(`${table.name}: explicit role review missing for ${role}`); continue; }
      if (!same(sorted(allowed), sorted(grants))) fail(`${table.name}: unexpected/missing effective ${role} grants`);
      for (const op of required) if (!grants.includes(op)) fail(`${table.name}: required ${role} ${op} absent`);
      if (role === 'PUBLIC' && allowed.length) fail(`${table.name}: PUBLIC table access forbidden`);
      if (role === 'anon' && allowed.length && (!table.publicReadReason || allowed.some(op => !/^SELECT(?::|$)/.test(op)))) fail(`${table.name}: anonymous access not justified catalogue SELECT`);
      if (['anon', 'authenticated'].includes(role) && allowed.length && table.mode !== 'browser') fail(`${table.name}: internal table exposed to ${role}`);
      if (['anon', 'authenticated'].includes(role) && allowed.length && !(live.policies ?? []).length) fail(`${table.name}: browser access lacks policies`);
      if (['anon', 'authenticated'].includes(role)) for (const op of new Set(allowed.map(p => p.split(':')[0]))) {
        const policies = (live.policies ?? []).filter(p => p.roles?.some(r => [role, 'PUBLIC', 'public'].includes(r)) && [op, 'ALL'].includes(p.command));
        const needsUsing = ['SELECT', 'UPDATE', 'DELETE'].includes(op), needsCheck = ['INSERT', 'UPDATE'].includes(op);
        if (!policies.length || (needsUsing && !policies.some(p => p.using)) || (needsCheck && !policies.some(p => p.withCheck))) fail(`${table.name}: ${role} ${op} policy predicates missing`);
        if (op === 'UPDATE' && !allowed.some(p => /^SELECT(?::|$)/.test(p))) fail(`${table.name}: ${role} UPDATE requires SELECT review`);
      }
    }
    for (const seq of live.insertSequences ?? []) if (!(contract.sequences ?? []).some(s => s.name === seq)) fail(`${table.name}: unreviewed insert sequence ${seq}`);
  }
  const sequences = contract.sequences ?? [];
  const sequenceCreates = [...masked.matchAll(/\bcreate\s+sequence\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z_0-9]*\.[a-z_][a-z_0-9]*)/gi)];
  for (const [, name] of sequenceCreates) if (!sequences.some(s => s.name === name.toLowerCase())) fail(`Unreviewed sequence ${name}`);
  if (!same(sorted(sequences.map(s => s.name)), sorted((metadata.sequences ?? []).map(s => s.name)))) fail('Sequence inventory mismatch');
  for (const seq of sequences) {
    const live = metadata.sequences?.find(s => s.name === seq.name);
    if (!seq.reason) fail(`${seq.name}: sequence caller justification missing`);
    for (const role of roles) {
      const allowed = seq.allowed?.[role], required = seq.required?.[role], grants = live?.grants?.[role];
      if (['PUBLIC', 'anon'].includes(role) && allowed?.length) fail(`${seq.name}: public/anonymous sequence access forbidden`);
      if (!Array.isArray(allowed) || !Array.isArray(required) || !Array.isArray(grants) || !same(sorted(allowed ?? []), sorted(grants ?? []))) fail(`${seq.name}: ${role} sequence privileges mismatch`);
      for (const op of required ?? []) if (!grants?.includes(op)) fail(`${seq.name}: required ${role} ${op} absent`);
    }
  }
  return errors;
}

export function checkRepository(root) {
  const dir = path.join(root, 'supabase/migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const old = execFileSync('git', ['ls-tree', '--name-only', BASELINE, 'supabase/migrations/'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
  if (old.length !== 83) throw new Error('Expected immutable 83-migration baseline');
  for (const name of old) {
    const baseline = execFileSync('git', ['show', `${BASELINE}:${name}`], { cwd: root, maxBuffer: 10_000_000 });
    if (!fs.existsSync(path.join(root, name)) || sha256(fs.readFileSync(path.join(root, name))) !== sha256(baseline)) throw new Error(`Applied migration changed: ${name}`);
  }
  const future = files.filter(f => !old.includes(`supabase/migrations/${f}`));
  for (const file of future) {
    const prefix = path.join(root, 'security/migrations', file);
    for (const suffix of ['.review.json', '.metadata.json']) if (!fs.existsSync(prefix + suffix)) throw new Error(`${file}: missing ${suffix} review evidence`);
    const contract=JSON.parse(fs.readFileSync(prefix+'.review.json')),metadata=JSON.parse(fs.readFileSync(prefix+'.metadata.json'));
    const errors = checkReview(fs.readFileSync(path.join(dir, file), 'utf8'),contract,metadata);
    if(contract.kind==='automatic-finance-sync'){
      const proof=fs.readFileSync(path.join(root,'tests/fixtures/finance-sync-database-proof.json'));
      const actual=JSON.parse(proof);
      if(sha256(proof)!==contract.databaseProofSha256||actual.sqlSha256!==contract.sqlSha256||!same(actual.catalog?.tables,metadata.tables)||!same(actual.catalog?.functions,metadata.functions))errors.push('Finance database proof file mismatch');
    }
    if (errors.length) throw new Error(`${file}:\n${errors.join('\n')}`);
  }
  return `83 applied migrations unchanged; ${future.length} future migrations checked. ${future.length ? 'Offline review gate passed; staging authorization tests still required.' : 'No future migration exists; no future ACL behavior proven.'}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(checkRepository(process.cwd())); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
