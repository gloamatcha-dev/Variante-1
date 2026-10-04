import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
function leaf(p,globals={}){const loadedModule={exports:{}};vm.runInNewContext(ts.transpileModule(read(p),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:loadedModule,exports:loadedModule.exports,URLSearchParams,...globals});return loadedModule.exports;}
const effects=leaf('lib/requiredBusinessEffect.ts');
test('mandatory writers reject missing and unknown outcomes before event completion',()=>{
 for(const name of ['income','affiliate','reversal'])for(const value of [null,{result:'unknown'},{result:'order_missing'}])assert.throws(()=>effects.requireBusinessEffect(name,value,effects.FINANCE_EFFECT_RESULTS));
 for(const result of ['recorded','already_recorded','no_change','annual_delivery'])assert.equal(effects.requireBusinessEffect('income',{result},effects.FINANCE_EFFECT_RESULTS).result,result);
});
test('non-earning references and configured non-reversing rules are honest terminal outcomes',()=>{
 for(const result of ['reference_not_attributable','attributed_without_commission'])assert.equal(effects.requireBusinessEffect('attribution',{result},effects.ATTRIBUTION_EFFECT_RESULTS).result,result);
 for(const result of ['no_commission','rule_does_not_reverse','already_recorded','reversed','no_change'])assert.equal(effects.requireBusinessEffect('reversal',{result},effects.REVERSAL_EFFECT_RESULTS).result,result);
});
test('public reference survives normal navigation and never carries creator or commission authority',()=>{
 const storage=new Map(),window={location:{search:'?ref=anna'},sessionStorage:{setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k)}};
 const client=leaf('app/affiliateReference.ts',{window});client.captureAffiliateReference();window.location.search='';
 assert.equal(client.readAffiliateReference().affiliateSlug,'anna');assert.deepEqual(Object.keys(client.readAffiliateReference()),['affiliateSlug']);
 window.location.search='?affiliate_code=ANNA';client.captureAffiliateReference();window.location.search='';assert.equal(client.readAffiliateReference().affiliateCode,'ANNA');
});
test('corrupt or denied browser storage does not break a normal checkout',()=>{
 const window={location:{search:''},sessionStorage:{getItem:()=>'{',setItem:()=>{throw Error('blocked');}}};const client=leaf('app/affiliateReference.ts',{window});assert.equal(Object.keys(client.readAffiliateReference()).length,0);
 window.location.search='?ref=anna';assert.doesNotThrow(()=>client.captureAffiliateReference());
});
test('checkout and webhook use existing authoritative resolver/writers',()=>{
 assert.match(read('app/api/checkout/session/route.ts'),/metadata:\s*\{[\s\S]*\.\.\.await affiliateCheckoutMetadata/);
 assert.match(read('app/GloaSite.tsx'),/captureAffiliateReference\(\)/);
 const webhook=read('app/api/stripe/webhook/route.ts');assert.match(webhook,/requireBusinessEffect\('order income', await recordOrderPaymentEvent/);assert.match(webhook,/requireBusinessEffect\('affiliate attribution'/);assert.match(webhook,/requireBusinessEffect\('commission reversal'/);
 assert.match(webhook,/outcome.result === 'unchanged'/);
});
test('creator expected validation/conflict/missing targets have explicit responses',()=>{
 const route=read('app/api/admin/creators/route.ts');assert.match(route,/code==='23505'\?409/);assert.match(route,/code==='P0002'\?404/);assert.match(route,/admin_mutate_creator/);assert.match(route,/Bitte einen gültigen Namen/);
});
