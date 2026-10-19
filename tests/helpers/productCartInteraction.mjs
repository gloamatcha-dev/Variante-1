/** Execute the real generic buy handler and cart persistence with deterministic hook/storage ports. */
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
export function productCartInteraction(product){
 const storage=new Map();
 const localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)};
 const hooks={useState:initial=>[initial,()=>{}],useCallback:fn=>fn,useSyncExternalStore:(_subscribe,get)=>get()};
 function load(file){
  const loadedModule={exports:{}};
  const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(js,{module:loadedModule,exports:loadedModule.exports,window:{localStorage},localStorage,
   require:name=>name==='react'?hooks:name==='../lib/productPresentation'?require('../../lib/productPresentation.ts'):require(name)},
  {filename:file});
  return loadedModule.exports;
 }
 const cart=load('app/cart.ts'),component=load('app/GenericProductPage.tsx').GenericProductPage;
 const element=component({product,addItem:cart.useCart().addItem,onAdd:()=>{},pricesVisible:true,prelaunch:false});
 function find(node){
  if(!node||typeof node!=='object')return null;
  if(node.type==='button')return node;
  for(const child of [node.props?.children].flat(3)){const result=find(child);if(result)return result;}
  return null;
 }
 const button=find(element);
 if(!button)throw Error('Generic product buy button missing');
 button.props.onClick(); // The component itself must also refuse a sold-out variant.
 return {disabled:button.props.disabled,items:JSON.parse(JSON.stringify(cart.useCart().items)),persisted:storage.get('gloa_cart')};
}
