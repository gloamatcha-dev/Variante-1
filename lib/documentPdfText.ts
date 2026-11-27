import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

export async function documentPdfText(page: PDFPageProxy): Promise<string> {
  const data=await page.getTextContent();
  const parts=data.items.flatMap(item=>{
    if(!('str' in item)||!item.str.trim()) return [];
    const [,tilt,,,x,y]=item.transform;
    return [{text:item.str,x,y,width:item.width,tilt}];
  });
  if(parts.some(part=>Math.abs(part.tilt)>1)) {
    // Rotated text cannot be reliably aligned using the PDF's horizontal coordinates.
    return data.items.map(item=>'str' in item?item.str+(item.hasEOL?'\n':' '):'').join('').trim();
  }
  parts.sort((a,b)=>b.y-a.y);
  const rows: (typeof parts)[]=[];
  for(const part of parts) {
    const row=rows.at(-1);
    if(row&&Math.abs(row[0].y-part.y)<=2)row.push(part);
    else rows.push([part]);
  }
  return rows.map(row=>{
    row.sort((a,b)=>a.x-b.x);
    return row.map((part,index)=>{
      if(index===0)return part.text.trim();
      const before=row[index-1];
      const gap=part.x-before.x-before.width;
      return (gap>24?'\t':gap>1||/\s$/.test(before.text)||/^\s/.test(part.text)?' ':'')+part.text.trim();
    }).join('');
  }).join('\n').trim();
}

export async function extractDocumentPdfRange(document: PDFDocumentProxy, from: number, to: number) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) ||
      from < 1 || to < from || to > document.numPages || to-from >= 6 ||
      (from === 1 && to === document.numPages)) {
    throw Error('Einen echten Teilbereich mit bis zu sechs vorhandenen PDF-Seiten auswählen.');
  }
  const included = Array.from({length:to-from+1}, (_,index)=>from-1+index);
  return document.extractPages([{document:null,includePages:included}]);
}
