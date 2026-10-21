/** Actual TS handlers in an isolated VM; no env files, network or real database.
 * Ports replace auth, database and Stripe only. Application validation stays real. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
export function productSafetyRoute(product, stripe, options = {}) {
  const calls = [], cache = new Map();
  const admin = {
    from() {
      const query = { select() { return query; }, eq() { return query; }, single: async () => ({ data: product, error: null }) };
      return query;
    },
    rpc: async (name, args) => { calls.push({ name, args }); return options.rpc ? options.rpc(name, args) : { data: { ok: true }, error: null }; },
  };
  function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    const loaded = { exports: {} }; cache.set(file, loaded);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    const localRequire = name => {
      if (name.endsWith('/adminActionRoute')) return { requireAdminIdentity: async () => ({ ok: true, session: { userId: 'mock-owner' }, identity: { role: 'owner' } }) };
      if (name.endsWith('/supabaseAdmin')) return { getSupabaseAdmin: () => admin };
      if (name.endsWith('/stripe')) return { getStripeClient: () => stripe };
      if (name.endsWith('/productImageUpload')) return { uploadProductImage: () => { throw Error('Upload outside test scope'); } };
      if (name.endsWith('/supabase')) return { supabase: options.catalogue ?? null };
      if (name.startsWith('.')) { let target = path.resolve(path.dirname(file), name); if (!path.extname(target)) target += '.ts'; return load(target); }
      return require(name);
    };
    vm.runInNewContext(code, { module: loaded, exports: loaded.exports, require: localRequire,
      Request, Response, URL, Buffer, console, process: { env: {} },
      fetch: () => { throw Error('Network forbidden'); },
    }, { filename: file });
    return loaded.exports;
  }
  return { calls, load, post: body => load('app/api/admin/products/route.ts').POST(new Request('http://127.0.0.1/api/admin/products', {
    method: 'POST', body: JSON.stringify(body),
  })) };
}
