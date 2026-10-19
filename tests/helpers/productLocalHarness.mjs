/** Actual local PostgREST + application module loader. Providers are injected doubles.
 * Never reads .env files. External fetches are refused in the loader and server proxy.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createServer,request as httpRequest} from 'node:http';
import {createHmac} from 'node:crypto';
const require=createRequire(import.meta.url),ts=require('typescript');
export async function productLocalHarness(database,stripe,emails=[],storage=null){
 if(!/^gloa_073_[a-f0-9]+$/.test(database))throw Error('Disposable database required');
 const out='outputs/product-083';fs.mkdirSync(out,{recursive:true});
 const secret='product-manager-local-only-jwt-secret-083',sessionSecret='product-manager-local-only-session-secret-083';
 const jwt=role=>{const a=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');const b=Buffer.from(JSON.stringify({role,exp:Math.floor(Date.now()/1000)+7200})).toString('base64url');return a+'.'+b+'.'+createHmac('sha256',secret).update(a+'.'+b).digest('base64url');};
 const localEnvironment={ADMIN_EMAILS:emails.join(','),ADMIN_SESSION_SECRET:sessionSecret,SUPABASE_SECRET_KEY:jwt('service_role'),SITE_URL:'http://127.0.0.1:18184',STRIPE_SECRET_KEY:'',RESEND_API_KEY:''};
 const build={VITE_SUPABASE_URL:'http://127.0.0.1:18184',VITE_SUPABASE_PUBLISHABLE_KEY:jwt('anon')};
 const originalFetch=globalThis.fetch;
 const localFetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input.url??String(input));if(!['127.0.0.1','localhost'].includes(url.hostname))throw Error('External request denied by local harness');return originalFetch(input,init);};
 fs.writeFileSync(out+'/postgrest.conf',`db-uri = "postgres://postgres@127.0.0.1:55472/${database}?sslmode=disable&gssencmode=disable&connect_timeout=5"\ndb-schemas = "public"\ndb-anon-role = "anon"\njwt-secret = "${secret}"\nserver-host = "127.0.0.1"\nserver-port = 18183\n`);
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG/i.test(k)&&!/^path$/i.test(k)));
 env.Path='C:/Program Files/PostgreSQL/17/bin;'+(process.env.Path??process.env.PATH??'');env.PGSSLMODE='disable';env.PGGSSENCMODE='disable';
 const fd=fs.openSync(out+'/postgrest.log','w');
 const pg=spawn(path.resolve('outputs/postgrest-v14.18/postgrest.exe'),[out+'/postgrest.conf','+RTS','-N1','-RTS'],{env,stdio:['ignore',fd,fd],windowsHide:true});
 const cache=new Map();
 function load(file){
  file=path.resolve(file);if(cache.has(file))return cache.get(file).exports;
  if(file===path.resolve('lib/stripe.ts'))return {getStripeClient:()=>stripe};
  const loadedModule={exports:{}};cache.set(file,loadedModule);
  const source=fs.readFileSync(file,'utf8').replaceAll('import.meta.env','__localBuild');
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const localRequire=name=>{
   if(name.startsWith('.')){let target=path.resolve(path.dirname(file),name);if(!path.extname(target))target+=fs.existsSync(target+'.ts')?'.ts':'.tsx';return load(target);}
   return require(name);
  };
  vm.runInNewContext(js,{module:loadedModule,exports:loadedModule.exports,require:localRequire,Response,Request,Headers,console,URL,Date,Intl,Buffer,process:{env:localEnvironment},__localBuild:build,fetch:localFetch,setTimeout,clearTimeout,AbortController,AbortSignal,TextEncoder,TextDecoder},{filename:file});
  if(storage && file===path.resolve('lib/supabaseAdmin.ts')){
   const original=loadedModule.exports.getSupabaseAdmin;
   loadedModule.exports.getSupabaseAdmin=()=>{const client=original();return client?new Proxy(client,{get:(target,key)=>key==='storage'?storage:Reflect.get(target,key)}):null;};
  }
  if(file===path.resolve('app/content.ts'))loadedModule.exports.SHOP_STATUS='live';
  return loadedModule.exports;
 }
 const proxy=createServer(async(req,res)=>{
  if(!req.url.startsWith('/rest/v1/')){res.writeHead(404);res.end();return;}
  const target=httpRequest({host:'127.0.0.1',port:18183,path:req.url.slice('/rest/v1'.length),method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
  target.on('error',()=>{res.writeHead(503);res.end();});req.pipe(target);
 });
 await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(18184,'127.0.0.1',resolve);});
 let ready=false;
 for(let n=0;n<100;n++){try{const r=await localFetch('http://127.0.0.1:18183/products');if(r.ok){ready=true;break;}}catch{/* bounded local startup polling */}await new Promise(r=>setTimeout(r,200));}
 if(!ready){proxy.close();pg.kill();fs.closeSync(fd);throw Error('PostgREST readiness failed');}
 return {load,build,environment:localEnvironment,sessionSecret,jwt,fetch:localFetch,
  close:()=>{proxy.close();pg.kill();fs.closeSync(fd);}};
}
