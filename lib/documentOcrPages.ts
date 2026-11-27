import { analyzeDocumentOcr, orderOverview } from './documentOcrFields.ts';

export function reviewDocumentPages(pages: string[]) {
  const source = pages.join('\n\n');
  const single = () => ({...analyzeDocumentOcr(source), source, pageCount: pages.length, batch: 'single' as const, documents: []});
  const blocked = (documents: {from:number; to:number; review:ReturnType<typeof analyzeDocumentOcr>}[]) => ({
    ...analyzeDocumentOcr(''), source, pageCount: pages.length, batch: documents.length > 1 ? 'multiple' as const : 'unclear' as const, documents,
    issues: [documents.length > 1
      ? 'Mehrere Rechnungen erkannt. Wähle einen Einzelbeleg und bestätige ihn separat im Formular.'
      : 'Beleggrenzen sind nicht eindeutig. Prüfe die Seiten am Original, speichere einen Seitenbereich als Teil-PDF und lade ihn separat hoch.'],
  });

  // An order overview and its item pages are one receipt. Merchant headings
  // on item pages are not invoice boundaries or sources of order totals.
  if (orderOverview.test(pages[0] ?? '')) {
    const overview = analyzeDocumentOcr(pages[0]);
    const itemPages = pages.slice(1).every(page =>
      /^(?:Artikeldetails\b|Verkauft von\b)/im.test(page) &&
      !/^(?:Rechnung|Invoice|Tax invoice|Kassenbon|Quittung|Receipt)\s*[:.]?\s*$/im.test(page) &&
      !/^\s*(?:Rechnungs[- ]?(?:nummer|Nr\.?)|Invoice\s*(?:number|no\.?|#)|Bestell(?:nummer|datum|zeit))\b/im.test(page) &&
      !orderOverview.test(page));
    return overview.identities.length === 1 && overview.fields.invoiceNumber && itemPages
      ? {...overview, source, pageCount: pages.length, batch: 'single' as const, documents: []} : blocked([]);
  }

  const groups: {from:number; to:number; id?:string; issuer?:string; texts:string[]}[] = [];
  for (const [index, page] of pages.entries()) {
    const review = analyzeDocumentOcr(page);
    if (review.identities.length > 1 ||
        (page.match(/^\s*(?:Rechnung|Invoice|Tax invoice|Kassenbon|Receipt)\s*[:.]?\s*$/gim)??[]).length > 1) {
      return blocked([]);
    }
    if (pages.length === 1) return single();
    const id = review.fields.invoiceNumber as string | undefined;
    const issuer = review.fields.issuer as string | undefined;
    const previous = groups.at(-1);
    const numbering = /(?:^|\n)\s*(?:Seite|Page)\s+(\d+)\s*(?:von|of|\/)\s*(\d+)\b/i;
    const counter = numbering.exec(page);
    const priorCounter = previous && numbering.exec(previous.texts.at(-1)??'');
    const continues = previous && counter && priorCounter &&
      Number(counter[1]) === Number(priorCounter[1]) + 1 && counter[2] === priorCounter[2] &&
      Number(counter[1]) <= Number(counter[2]);
    if (previous && (id ? id === previous.id : continues)) {
      if (issuer && previous.issuer && issuer !== previous.issuer) return blocked([]);
      if (counter?.[1] === '1') return blocked([]);
      previous.issuer ??= issuer;
      previous.texts.push(page);
      previous.to = index + 1;
    } else {
      if (!id || groups.some(group=>group.id===id)) return blocked([]);
      groups.push({from:index+1,to:index+1,id,issuer,texts:[page]});
    }
  }
  if (groups.length === 1) return single();
  return blocked(groups.map(({from,to,texts})=>({from,to,review:analyzeDocumentOcr(texts.join('\n'))})));
}
