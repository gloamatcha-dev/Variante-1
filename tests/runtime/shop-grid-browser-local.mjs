/** Local visual fixtures render the actual card and stylesheet, never Production. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {renderToStaticMarkup} from 'react-dom/server';
import {shopGridFixture,shopGridInteraction} from '../helpers/shopGridInteraction.mjs';
const root='outputs/shop-grid';fs.mkdirSync(root,{recursive:true});
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/grid-ready.js'){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync('tests/helpers/shopGridBrowserReady.mjs'));return;}
 if(url.pathname==='/'){
  const count=Math.min(8,Math.max(1,Number(url.searchParams.get('count')||8)));
  const cards=shopGridFixture(count).map(p=>'<article class="shop-column">'+renderToStaticMarkup(shopGridInteraction(p).render())+'</article>').join('');
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GLOA local grid fixture</title><style>'+fs.readFileSync('app/globals.css','utf8')+'</style><main class="shop-page"><div class="home-rail" style="padding-block:40px"><p class="eyebrow">GLOA / LOCAL DESIGN FIXTURE</p><h1 style="font-size:42px">Alles von GLOA.</h1></div><section class="shop-products" data-count="'+count+'">'+cards+'</section></main></html>');return;
 }
 const file=path.resolve('public','.'+decodeURIComponent(url.pathname));
 if(!file.startsWith(path.resolve('public')+path.sep)||!fs.existsSync(file)){res.statusCode=404;res.end();return;}
 res.setHeader('Content-Type',({'.webp':'image/webp','.jpg':'image/jpeg','.png':'image/png','.woff2':'font/woff2'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const profile=fs.realpathSync(fs.mkdtempSync(root+'/profile-'));
const child=spawn(process.env.GLOA_TEST_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let ws,next=0;const pending=new Map(),lifecycle=[],browserProgress=[];
try{
 const endpoint=await new Promise((resolve,reject)=>{let log='';const timer=setTimeout(()=>reject(new Error('Browser startup timeout')),20000);child.on('error',error=>{clearTimeout(timer);reject(error);});child.stderr.on('data',chunk=>{log=(log+chunk).slice(-20000);const m=log.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}});});
 ws=new WebSocket(endpoint);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Page.lifecycleEvent')lifecycle.push(m.params);if(m.method==='Runtime.consoleAPICalled')browserProgress.push(m.params.args.map(arg=>arg.value).join(' '));if(m.id){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);if(m.error)p.reject(new Error(m.error.message));else p.resolve(m.result);}};
 const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},method==='Runtime.evaluate'?60000:20000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
 const targets=await call('Target.getTargets'),targetId=targets.targetInfos.find(t=>t.type==='page').targetId;
 const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
 await call('Page.enable',{},sessionId);await call('Runtime.enable',{},sessionId);
 await call('Page.setLifecycleEventsEnabled',{enabled:true},sessionId);await call('Page.bringToFront',{},sessionId);
 const checks=[];
 for(const [width,count,columns]of [[390,8,1],[768,8,2],[1200,8,3],[1600,8,4],[1600,1,1],[1600,2,2],[1600,3,3]]){
  await call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<560},sessionId);
  const navigation=await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/?count='+count},sessionId);
  if(navigation.errorText)throw new Error('Navigation failed: '+navigation.errorText);
  const until=Date.now()+20000;
  while(!lifecycle.some(event=>event.loaderId===navigation.loaderId&&event.name==='DOMContentLoaded')){if(Date.now()>until)throw new Error('DOMContentLoaded timeout');await new Promise(r=>setTimeout(r,50));}
  const result=await call('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`import('/grid-ready.js').then(module=>module.inspectShopGrid())`},sessionId);
  if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
  const value=result.result.value;if(!value||value.columns!==columns||value.cards!==count||value.overflow||Math.abs(value.ratio-.8)>.01||!value.images||!value.lazy)throw new Error(JSON.stringify({width,count,expectedColumns:columns,actual:value}));
  checks.push({width,count,...value});
  if([390,1600].includes(width)){const png=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},sessionId);fs.writeFileSync(root+'/grid-'+width+'-'+count+'.png',Buffer.from(png.data,'base64'));}
 }
 fs.writeFileSync(root+'/browser-results.json',JSON.stringify(checks,null,2));console.log(checks.length+' local visual layout checks passed');
}catch(error){fs.writeFileSync(root+'/browser-results.json',JSON.stringify({pass:false,error:String(error),browserProgress},null,2));throw error;}
finally{for(const p of pending.values())p.reject(new Error('Browser closed'));pending.clear();ws?.close();child.kill();server.closeAllConnections();server.close();}
