/// <reference types="vite/client" />
import { reviewDocumentPages } from './documentOcrPages.ts';
import { documentPdfText, extractDocumentPdfRange } from './documentPdfText.ts';

const MAX_BYTES = 3*1024*1024;
const MAX_PAGES = 12;
const MAX_EDGE = 2200;
const MAX_IMAGE_PIXELS = 20000000;
let running = false;

export function imageDimensions(bytes: Uint8Array): [number,number] | undefined {
  const v = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes.length>=24 && v.getUint32(0)===0x89504e47 && v.getUint32(4)===0x0d0a1a0a &&
      v.getUint32(8)===13 && v.getUint32(12)===0x49484452) {
    return [v.getUint32(16),v.getUint32(20)];
  }
  if(bytes[0]!==255 || bytes[1]!==216) return;
  for(let p=2;p+4<bytes.length;) {
    if(bytes[p++]!==255) return;
    while(bytes[p]===255) p++;
    const marker=bytes[p++];
    if(p+2>bytes.length||marker===0xda||marker===0xd9) return;
    const size=v.getUint16(p);
    if(size<2||p+size>bytes.length) return;
    if([0xc0,0xc1,0xc2,0xc3].includes(marker)&&size>=8) return [v.getUint16(p+5),v.getUint16(p+3)];
    p+=size;
  }
}

function bounded<T>(promise: Promise<T>, duration: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise,new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>reject(Error('Zeitlimit der lokalen Belegerkennung erreicht.')),duration);
  })]).finally(()=>clearTimeout(timer));
}

async function loadPdf(bytes:Uint8Array) {
  if(new TextDecoder().decode(bytes.subarray(0,5))!=='%PDF-') throw Error('Ungültige PDF-Datei.');
  const [pdf,{default:workerUrl}]=await Promise.all([
    import('pdfjs-dist'),import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdf.GlobalWorkerOptions.workerSrc=workerUrl;
  return pdf.getDocument({data:bytes,enableXfa:false,useSystemFonts:true,
    stopAtErrors:true,maxImageSize:MAX_IMAGE_PIXELS});
}

export async function splitDocumentPdf(file:File, from:number, to:number) {
  if(file.type!=='application/pdf'||!file.size||file.size>MAX_BYTES) throw Error('PDF bis 3 MB auswählen.');
  const task=await loadPdf(new Uint8Array(await file.arrayBuffer()));
  try {
    const document=await bounded(task.promise,15000);
    const bytes=await bounded(extractDocumentPdfRange(document,from,to),15000);
    if(!bytes.byteLength||bytes.byteLength>MAX_BYTES) throw Error('Teil-PDF ist leer oder größer als 3 MB.');
    return new Blob([new Uint8Array(bytes)],{type:'application/pdf'});
  } finally { await task.destroy(); }
}

export async function readDocumentInBrowser(file:File) {
  if(running) throw Error('Eine Belegerkennung läuft bereits.');
  if(!file.size || file.size>MAX_BYTES || !['image/jpeg','image/png','application/pdf'].includes(file.type)) {
    throw Error('PDF, JPG oder PNG bis 3 MB auswählen.');
  }
  running=true;
  let worker: import('tesseract.js').Worker | undefined;
  let task: import('pdfjs-dist').PDFDocumentLoadingTask | undefined;
  const deadline=Date.now()+60000;
  const remaining=()=>Math.max(1,deadline-Date.now());
  async function recognize(canvas:HTMLCanvasElement) {
    if(!worker) {
      const [{createWorker},{default:workerPath},{default:corePath}]=await Promise.all([
        import('tesseract.js'),import('tesseract.js/dist/worker.min.js?url'),
        import('tesseract.js-core/tesseract-core-lstm.wasm.js?url'),
      ]);
      const local=(asset:string)=>new URL(asset,window.location.href).href;
      // Both language files and the embedded WASM wrapper must be served by GLOA.
      const init=createWorker(['deu','eng'],1,{
        workerPath:local(workerPath),corePath:local(corePath),
        langPath:local('/ocr/tessdata-4.1.0'),gzip:false,workerBlobURL:false,cacheMethod:'none',
      });
      try { worker=await bounded(init,remaining()); }
      catch(error) { void init.then(w=>w.terminate()).catch(()=>{}); throw error; }
    }
    return (await bounded(worker.recognize(canvas),remaining())).data.text;
  }
  try {
    const bytes=new Uint8Array(await file.arrayBuffer());
    const pages: string[] = [];
    if(file.type==='application/pdf'){
      task=await loadPdf(bytes);
      const document=await bounded(task.promise,remaining());
      if(document.numPages>MAX_PAGES) throw Error('Maximal zwölf PDF-Seiten pro Datei für die automatische Prüfung. Größere Dateien nach Seiten aufteilen.');
      for(let i=1;i<=document.numPages;i++){
        const page=await bounded(document.getPage(i),remaining());
        try {
          const embedded=await bounded(documentPdfText(page),remaining());
          if(embedded.replace(/[^\p{L}\p{N}]/gu,'').length>=32) {
            pages.push(embedded);
            continue;
          }
          const original=page.getViewport({scale:1});
          const viewport=page.getViewport({scale:Math.min(2.5,MAX_EDGE/Math.max(original.width,original.height))});
          const canvas=window.document.createElement('canvas');
          canvas.width=Math.ceil(viewport.width);
          canvas.height=Math.ceil(viewport.height);
          const render=page.render({canvas,viewport,background:'#ffffff'});
          try {
            await bounded(render.promise,remaining());
            pages.push(await recognize(canvas));
          } finally { render.cancel(); canvas.width=canvas.height=0; }
        } finally { page.cleanup(); }
      }
    } else {
      const dimensions=imageDimensions(bytes);
      if(!dimensions || !dimensions.every(Boolean) || dimensions[0]*dimensions[1]>MAX_IMAGE_PIXELS) {
        throw Error('Bildformat oder Bildauflösung nicht unterstützt.');
      }
      const bitmap=await createImageBitmap(file);
      const canvas=window.document.createElement('canvas');
      try {
        const scale=Math.min(1,MAX_EDGE/Math.max(bitmap.width,bitmap.height));
        canvas.width=Math.max(1,Math.round(bitmap.width*scale));
        canvas.height=Math.max(1,Math.round(bitmap.height*scale));
        const ctx=canvas.getContext('2d',{alpha:false});
        if(!ctx) throw Error('Bildverarbeitung nicht verfügbar.');
        ctx.fillStyle='white'; ctx.fillRect(0,0,canvas.width,canvas.height);
        ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
        pages.push(await recognize(canvas));
      } finally { bitmap.close(); canvas.width=canvas.height=0; }
    }
    if (pages.reduce((sum, page) => sum + page.length, 0) > 40000) throw Error('Belegtext zu lang. PDF bitte aufteilen.');
    return reviewDocumentPages(pages);
  } finally {
    try {
      await Promise.allSettled([worker?.terminate(),task?.destroy()]);
    } finally { running=false; }
  }
}
