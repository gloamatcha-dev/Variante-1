import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
/** Deterministic codec ports test optimizer bounds; real codecs are tested separately. */
export function productImageBrowserHarness(options={}) {
 const calls=[],resources={closed:false};
 const canvas={width:0,height:0,getContext:()=>options.noContext?null:{drawImage:(_image,x,y,w,h)=>calls.push({draw:[x,y,w,h]})},
  toBlob:(callback,mime,quality)=>{calls.push({mime,quality,width:canvas.width,height:canvas.height});callback(options.nullBlob?null:new Blob([new Uint8Array(options.size?.(canvas.width,quality)??100)],{type:options.fallback?'image/png':mime}));}};
 const loadedModule={exports:{}};
 const code=ts.transpileModule(fs.readFileSync('lib/productImageBrowser.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{module:loadedModule,exports:loadedModule.exports,Error,File,Uint8Array,Blob,String,Math,Promise,
  document:{createElement:()=>canvas},createImageBitmap:async(_file,config)=>{calls.push({orientation:config.imageOrientation});if(options.decodeError)throw new Error('decode');return {width:options.width??4000,height:options.height??2000,close:()=>{resources.closed=true;}};},
  XMLHttpRequest:options.xhr,
  require:()=>require('../../lib/productImageRules.ts'),
 });
 return {...loadedModule.exports,calls,resources,canvas};
}
