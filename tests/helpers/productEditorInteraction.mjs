/** Execute the actual editor with deterministic React hooks, API and file-upload ports. */
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
export async function productEditorInteraction(products=[],options={}){
 const state=[],effects=[],requests=[];let cursor=0,mounted=false;
 const hooks={useState:initial=>{const index=cursor++;if(!(index in state))state[index]=initial;return [state[index],value=>{state[index]=typeof value==='function'?value(state[index]):value;}];},useEffect:fn=>{if(!mounted)effects.push(fn);}};
 const loadedModule={exports:{}};
 const code=ts.transpileModule(fs.readFileSync('app/AdminProducts.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(code,{module:loadedModule,exports:loadedModule.exports,crypto:globalThis.crypto,URL,Error,TextDecoder,
  fetch:async(url,init)=>{requests.push({url,options:init});if(init.headers?.Accept==='application/x-ndjson')return options.publishResponse?.()??new Response(JSON.stringify({ok:true,published:true})+'\n');return Response.json({ok:true,path:'actor/object.png',uploadUrl:'https://storage.example.invalid/signed',url:'https://images.example.invalid/replacement.png'});},
  require:name=>name==='../lib/productImageBrowser'?{
   optimizeProductImage:options.optimize|| (async file=>new File([file.slice(0,100)],'optimized.webp',{type:'image/webp'})),
   transferProductImage:async(url,file,progress)=>{requests.push({url,options:{method:'PUT',body:file}});progress(75);await options.transfer?.();},
  }:name==='react'?hooks:name==='next/image'?{default:'img'}:name==='./AdminPortalShared'?{portalRequest:async(_url,body)=>{if(body.action==='list')return {products,inventory:[],canWrite:true};requests.push(body);if(body.action==='publication-status')return options.publicationStatus?options.publicationStatus(body):{id:body.id,status:'published',revision:1,stripeSyncStatus:'synced',archivedAt:null};return {ok:true};}}:name.startsWith('../lib/')?require('../../lib/'+name.slice('../lib/'.length)+'.ts'):require(name),
 },{filename:'app/AdminProducts.tsx'});
 function render(){cursor=0;return loadedModule.exports.AdminProducts();}
 render();mounted=true;effects.forEach(fn=>fn());await Promise.resolve();await Promise.resolve();
 function nodes(root){if(!root||typeof root!=='object')return [];return [root,...[root.props?.children].flat(5).flatMap(nodes)];}
 return {render,requests,find:(predicate)=>nodes(render()).find(predicate),flush:async()=>{await new Promise(r=>setImmediate(r));}};
}
