/** Real Chromium raster decoding/encoding. No remote network or user browser profile. */
import fs from 'node:fs';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
const root='outputs/product-ux';fs.mkdirSync(root,{recursive:true});
const executable=process.env.GLOA_TEST_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const transpile=p=>ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const server=http.createServer((req,res)=>{
 res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');
 if(req.url==='/')res.end('<!doctype html><title>Local image verification</title>');
 else if(req.url==='/optimizer.js')res.end(transpile('lib/productImageBrowser.ts').replace("'./productImageRules'","'/rules.js'"));
 else if(req.url==='/rules.js')res.end(transpile('lib/productImageRules.ts'));else{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const profile=fs.mkdtempSync(root+'/browser-profile-');
const child=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+fs.realpathSync(profile),'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
const watchdog=setTimeout(()=>{console.error('Browser verification timed out');child.kill();server.closeAllConnections();server.close();process.exitCode=1;},180000);
let ws;const pending=new Map();let next=0;
try{
 const endpoint=await new Promise((resolve,reject)=>{let log='';const timer=setTimeout(()=>reject(new Error('Browser startup timed out')),20000);child.stderr.on('data',chunk=>{log+=chunk;const m=log.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}});child.on('error',reject);});
 console.log('Browser started');ws=new WebSocket(endpoint);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 ws.onmessage=e=>{const message=JSON.parse(e.data);if(message.id){const p=pending.get(message.id);pending.delete(message.id);if(message.error)p.reject(new Error(message.error.message));else p.resolve(message.result);}};
 const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>reject(new Error('CDP timeout: '+method)),method==='Runtime.evaluate'?120000:20000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
 console.log('CDP connected');const targets=await call('Target.getTargets');const targetId=targets.targetInfos.find(t=>t.type==='page').targetId;
 const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
 await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port},sessionId);console.log('Page attached');await new Promise(r=>setTimeout(r,500));
 const result=await call('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{
  const {optimizeProductImage,transferProductImage}=await import('/optimizer.js');
  const checks=[];const check=(name,ok,details={})=>{checks.push({name,pass:!!ok,...details});if(!ok)throw new Error(name);};
  const canvas=document.createElement('canvas');canvas.width=80;canvas.height=40;
  const ctx=canvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,40,40);ctx.fillStyle='blue';ctx.fillRect(40,0,40,40);
  const blob=(type)=>new Promise(r=>canvas.toBlob(r,type,0.95));
  for(const type of ['image/jpeg','image/png','image/webp']){
   const source=new File([await blob(type)],'original',{type});const output=await optimizeProductImage(source);const image=await createImageBitmap(output);
   check(type+' format, ratio, size',image.width===80&&image.height===40&&output.size<=5*1024*1024&&output!==source,{bytes:output.size,mime:output.type});
   const sample=document.createElement('canvas');sample.width=80;sample.height=40;const c=sample.getContext('2d');c.drawImage(image,0,0);const pixels=c.getImageData(10,10,1,1).data;
   check(type+' visual color quality',pixels[0]>220&&pixels[1]<35&&pixels[2]<35);image.close();
  }
  ctx.clearRect(0,0,80,40);ctx.fillStyle='green';ctx.fillRect(20,10,40,20);
  const transparent=await optimizeProductImage(new File([await blob('image/png')],'alpha.png',{type:'image/png'}));
  const alpha=await createImageBitmap(transparent);ctx.clearRect(0,0,80,40);ctx.drawImage(alpha,0,0);check('transparency retained',ctx.getImageData(0,0,1,1).data[3]===0&&ctx.getImageData(30,20,1,1).data[3]===255);alpha.close();
  // Valid WebP container with an unknown JUNK chunk, exactly 50 MiB (not appended garbage).
  const raw=new Uint8Array(await (await blob('image/webp')).arrayBuffer());const large=new Uint8Array(50*1024*1024);large.set(raw);const view=new DataView(large.buffer);view.setUint32(4,large.length-8,true);
  large.set([74,85,78,75],raw.length);view.setUint32(raw.length+4,large.length-raw.length-8,true);
  const largeOutput=await optimizeProductImage(new File([large],'50MiB.webp',{type:'image/webp'}));check('exact 50 MiB source accepted and reencoded',largeOutput.size<5*1024*1024,{sourceBytes:large.length,outputBytes:largeOutput.size});
  let rejected=false;try{await optimizeProductImage(new File([large,new Uint8Array(1)],'too-big.webp',{type:'image/webp'}));}catch{rejected=true;}check('over 50 MiB rejected',rejected);
  for(const [type,bytes] of [['image/png',new Uint8Array([137,80,78,71,13,10,26,10])],['image/jpeg',new Uint8Array([255,216,255])],['image/webp',new Uint8Array([82,73,70,70,0,0,0,0,87,69,66,80])],['image/svg+xml',new TextEncoder().encode('<svg/>')]]){
   rejected=false;try{await optimizeProductImage(new File([bytes],'malformed',{type}));}catch{rejected=true;}check('malformed '+type+' rejected',rejected);
  }
  // JPEG APP1 EXIF orientation 6: rotated 90 degrees clockwise.
  ctx.fillStyle='red';ctx.fillRect(0,0,40,40);ctx.fillStyle='blue';ctx.fillRect(40,0,40,40);
  const jpg=new Uint8Array(await (await blob('image/jpeg')).arrayBuffer());
  const exif=new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0]);
  const oriented=await optimizeProductImage(new File([jpg.slice(0,2),exif,jpg.slice(2)],'oriented.jpg',{type:'image/jpeg'}));const rotated=await createImageBitmap(oriented);
  check('EXIF orientation and oriented ratio',rotated.width===40&&rotated.height===80);
  canvas.width=40;canvas.height=80;ctx.drawImage(rotated,0,0);check('EXIF pixels rotated correctly',ctx.getImageData(10,10,1,1).data[0]>220&&ctx.getImageData(10,65,1,1).data[2]>220);rotated.close();
  canvas.width=4000;canvas.height=2000;ctx.fillStyle='orange';ctx.fillRect(0,0,4000,2000);
  const resized=await optimizeProductImage(new File([await blob('image/png')],'large.png',{type:'image/png'}));const resizedBitmap=await createImageBitmap(resized);check('maximum dimensions and aspect ratio',resizedBitmap.width===2560&&resizedBitmap.height===1280);resizedBitmap.close();
  // Verify XHR progress/headers and that only the optimized File is transferred.
  const originalXHR=window.XMLHttpRequest;let sent,headers={},progress=[];
  window.XMLHttpRequest=class{upload={};status=200;open(method,url){this.method=method;this.url=url;}setRequestHeader(k,v){headers[k]=v;}send(file){sent=file;this.upload.onprogress({lengthComputable:true,loaded:5,total:10});this.onload();}};
  await transferProductImage('https://storage.example.invalid/signed',resized,n=>progress.push(n));check('direct upload progress and optimized bytes',sent===resized&&headers['Content-Type']===resized.type&&headers['x-upsert']==='false'&&progress[0]===50);
  window.XMLHttpRequest=originalXHR;return checks;
 })().catch(error=>({error:error.message,stack:error.stack}))`},sessionId);
 if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
 fs.writeFileSync(root+'/image-browser-results.json',JSON.stringify(result.result.value,null,2));
 if(!Array.isArray(result.result.value))throw new Error(JSON.stringify(result.result.value));
 console.log(JSON.stringify(result.result.value,null,2));console.log(result.result.value.length+' real-browser checks passed');
}catch(error){
 fs.writeFileSync(root+'/image-browser-results.json',JSON.stringify({pass:false,error:String(error)},null,2));throw error;
}finally{clearTimeout(watchdog);ws?.close();child.kill();server.closeAllConnections();server.close();}
