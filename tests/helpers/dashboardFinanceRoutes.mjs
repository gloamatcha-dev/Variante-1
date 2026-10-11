import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {portalPeriod} from '../../lib/adminPortalFinance.ts';
import {readFinanceSummary} from '../../lib/adminPortalFinanceRead.ts';
import {readPortalPages} from '../../lib/adminPortalRead.ts';
const require=createRequire(import.meta.url),ts=require('typescript');

/** Execute real route handlers; only auth and the database transport are doubled. */
export function financeRouteHandlers(admin,role='owner') {
  return Object.fromEntries(['finance','dashboard-summary'].map(endpoint=>{
    const compiled={exports:{}};
    const js=ts.transpileModule(fs.readFileSync(`app/api/admin/${endpoint}/route.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const localRequire=name=>name.includes('adminPortalFinanceRead')?{readFinanceSummary}:name.includes('adminPortalFinance')?{portalPeriod}:name.includes('adminPortalRead')?{readPortalPages}:name.includes('adminActionRoute')?{requireAdminIdentity:async()=>({ok:true,identity:{role}})}:name.includes('supabaseAdmin')?{getSupabaseAdmin:()=>admin}:name.includes('adminRoles')?{canWrite:r=>['owner','admin'].includes(r)}:name.includes('inventoryRules')?{stockStatus:()=> 'ok'}:require(name);
    vm.runInNewContext(js,{module:compiled,exports:compiled.exports,require:localRequire,Response,Request,Date,Intl,console});
    return [endpoint,compiled.exports.POST];
  }));
}
export function emptyDashboardQuery() {
  const query=new Proxy({then:resolve=>Promise.resolve({data:[],error:null,count:0}).then(resolve)},{get(target,key){return key==='then'?target.then:()=>query;}});
  return query;
}
export async function compareFinanceRoutes(admin,period={period:'custom',from:'2026-10-01',to:'2026-10-31'}) {
  const routes=financeRouteHandlers(admin);
  const results=await Promise.all(Object.values(routes).map(POST=>POST(new Request('http://127.0.0.1/api/admin/',{method:'POST',body:JSON.stringify({...period,action:'summary'})}))));
  const [finance,dashboard]=await Promise.all(results.map(r=>r.json()));
  return {finance,dashboard,statuses:results.map(r=>r.status)};
}
