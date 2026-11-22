import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {PRICES_VISIBLE,SHOP_IS_PRELAUNCH,SHOP_STATUS} from '../app/content.ts';
import * as shopAvailability from '../lib/shopAvailability.ts';

const read=rel=>readFileSync(new URL(rel,import.meta.url),'utf8');
test('paused checkout retains the regular storefront presentation',()=>{
  assert.equal(SHOP_STATUS,'prelaunch');
  assert.equal(SHOP_IS_PRELAUNCH,false);
  assert.equal(PRICES_VISIBLE,true);
});
const variantId='3025ec22-9dd9-4218-b2f4-c1c9174660fd';
const body={
  items:[{variantId,quantity:1}],
  requestId:'3f1c9a52-7d84-4f1e-9b6a-2c5d8e0a4b71',
  shippingCountry:'DE',
  email:'closure-fixture@example.invalid',
};
const blockedSideEffects=new Proxy({}, {
  get:(_target,name)=>()=>{assert.fail(`Checkout reached a downstream operation: ${String(name)}`);},
});
const readonlyDeps={
  checkoutRateLimit:{consumeLocalCheckoutRateLimit:()=>({allow:true})},
  checkoutIdentity:{validateCheckoutEmail:email=>({ok:true,email})},
  checkoutQuote:{validateQuoteItems:items=>items,buildAuthoritativeQuote:async()=>({ok:true})},
  launchDiscount:{normalizeDiscountCode:()=>''},
  shipping:{ALLOWED_SHIPPING_COUNTRIES:['DE'],getShippingZone:()=> 'germany'},
  stripe:{getStripeClient:()=>blockedSideEffects},
  siteUrl:{getSiteOrigin:()=> 'https://local.invalid'},
};

for(const route of ['checkout','subscriptions/checkout','annual-plan/checkout','b2b/supply/checkout']){
  test(`Direct ${route} POST stops at the closed shop gate`,async()=>{
    assert.equal(SHOP_STATUS,'prelaunch');
    const source=read(`../app/api/${route}/session/route.ts`);
    const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
    const module={exports:{}};
    vm.runInNewContext(code,{module,exports:module.exports,Response,require(specifier){
      const name=specifier.split('/').at(-1);
      if(name==='content')return {SHOP_STATUS};
      if(name==='shopAvailability')return shopAvailability;
      return readonlyDeps[name]??blockedSideEffects;
    }});
    const response=await module.exports.POST(new Request(`https://local.invalid/api/${route}/session`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
    }));
    assert.equal(response.status,shopAvailability.CHECKOUT_CLOSED_STATUS);
    assert.deepEqual(await response.json(),{error:shopAvailability.CHECKOUT_CLOSED_MESSAGE});
  });
}
