/** Actual shop card, with deterministic state/cart ports and no database/network. */
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
const presentation=require('../../lib/productPresentation.ts');
const {buildAnnualPricing}=require('../../lib/annualPlanRules.ts');
const {ANNUAL_LAUNCH_SIZE_BY_SKU,annualPortalHref}=require('../../lib/annualPlans.ts');
const {isSubscribableVariant,subscriptionPortalHref}=require('../../lib/subscriptionPurchaseRules.ts');
export function shopGridInteraction(product,options={}){
 const state=[],items=[];let cursor=0;const navigation={location:{href:''}};
 const source=fs.readFileSync('app/GloaSite.tsx','utf8');
 const start=source.indexOf('function ShopProductBlock('),end=source.indexOf('/** Replaces the newsletter signup',start);
 const image=source.slice(source.indexOf('const SHOP_SECTION_IMAGE:'),source.indexOf('/**',source.indexOf('const SHOP_SECTION_IMAGE:')));
 const loadedModule={exports:{}};
 const code=ts.transpileModule(image+'\nexport '+source.slice(start,end),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(code,{module:loadedModule,exports:loadedModule.exports,require,MATCHA_SLUG:'matcha',...presentation,
  useState:initial=>{const i=cursor++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],value=>{state[i]=typeof value==='function'?value(state[i]):value;}];},
  PRODUCT:{storage:JSON.parse(fs.readFileSync('app/content.ts','utf8').match(/storage:\s*("(?:[^"\\]|\\.)*")/)[1])},
  useCart:()=>({addItem:item=>items.push(item)}),track:()=>{},window:navigation,
  fmtCents:c=>(c/100).toFixed(2).replace('.',','),per100gCents:(c,g)=>Math.round(c/g*100),
  PRICES_VISIBLE:!options.prelaunch,SHOP_IS_PRELAUNCH:!!options.prelaunch,isSubscribableVariant,subscriptionPortalHref,annualPortalHref,
  annualPricingFor:v=>{const size=ANNUAL_LAUNCH_SIZE_BY_SKU[v.sku];if(!size)return null;const r=buildAnnualPricing({size,catalogUnitGrossCents:v.price_gross_cents});return r.ok?r.pricing:null;},
  Link:({children,...props})=>require('react').createElement('a',props,children),
  PurchaseModeSelector:'purchase-mode-test',AnnualPlanPanel:'annual-panel-test',SubscriptionPlanPanel:'subscription-panel-test',
 });
 function render(annualRequest=0){cursor=0;return loadedModule.exports.ShopProductBlock({product,onAdd:()=>{},annualRequest});}
 function nodes(root){if(!root||typeof root!=='object')return [];return [root,...[root.props?.children].flat(5).flatMap(nodes)];}
 return {render,items,navigation,find:predicate=>nodes(render()).find(predicate)};
}
export function shopGridFixture(count=4){return Array.from({length:count},(_,i)=>({id:'fixture-'+i,slug:i?'accessory-'+i:'matcha',name:i?'GLOA Accessory '+i:'GLOA Matcha',short_description:i?'Ein ruhiger Begleiter für dein tägliches Ritual.':'Matcha aus Shizuoka, Japan.',description:'',primary_image_path:i?'/img/gloa-hero-packaging.jpg':null,variants:[{id:'variant-'+i+'a',sku:i?'FIXTURE-'+i:'GLOA-MATCHA-30G',label:i?'Standard':'30 g',size_grams:i?null:30,price_gross_cents:1499+i*500,sort_order:0},{id:'variant-'+i+'b',sku:i?'FIXTURE-'+i+'B':'GLOA-MATCHA-50G',label:i?'Groß':'50 g',size_grams:i?null:50,price_gross_cents:2299+i*500,sort_order:1}]}));}
