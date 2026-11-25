import type { PDFPageProxy } from 'pdfjs-dist';

export async function documentPdfText(page: PDFPageProxy): Promise<string> {
  const data = await page.getTextContent();
  let text = '';
  let previousY: number | undefined;
  for (const item of data.items) {
    if (!('str' in item)) continue;
    const y = item.transform[5];
    if (previousY !== undefined && Math.abs(y-previousY)>2 && !text.endsWith('\n')) text+='\n';
    text += item.str + (item.hasEOL?'\n':' ');
    previousY=y;
  }
  return text.trim();
}
