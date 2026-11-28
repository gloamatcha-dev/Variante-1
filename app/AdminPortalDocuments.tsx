"use client";
import {useRef,useState,type FormEvent} from 'react';
import {documentAmountFields,documentAmountsToCents,formatDocumentAmountInput,isDocumentCentCurrency} from '../lib/documentAmountInput';
import type {reviewDocumentPages} from '../lib/documentOcrPages';
import {fieldsForReview,fillDocumentOcrPreview} from '../lib/documentOcrPreview';
import {AdminDocumentFacts, AdminDocumentAccountingContext, documentAmount} from './AdminDocumentFacts';
import {documentCardStatus} from '../lib/documentCardStatus';
import {AdminPortalDocumentAssociation} from './AdminPortalDocumentAssociation';
import {date,label,text,type PortalRow} from '../lib/adminPortalModel.ts';
import {BusinessTable,ReadState,RecordDetails,portalRequest,usePortalRead} from './AdminPortalShared';

const centsFields=[['grossCents','Brutto (Cent)','gross_cents'],['netCents','Netto (Cent)','net_cents'],['taxCents','Steuer (Cent)','tax_cents']];

function MetadataFields({row}:{row?:PortalRow}) {
  const string=(name:string)=>row?.[name]==null?'':String(row[name]);
  const [currency,setCurrency]=useState(string('currency'));
  const unit=currency==='EUR'?'€':isDocumentCentCurrency(currency)?currency:'in Belegwährung';
  return <>
    <label>Titel<input name="title" required maxLength={200} defaultValue={string('title')}/></label>
    <label>Rechnungsdatum<input name="issuedOn" type="date" defaultValue={string('issued_on')}/></label>
    <label>Aussteller<input name="issuer" maxLength={200} defaultValue={string('issuer')}/></label>
    <label>Rechnungsnummer<input name="invoiceNumber" maxLength={120} defaultValue={string('invoice_number')}/></label>
    {Object.entries(documentAmountFields).map(([name,[label,key]])=><label key={name}>{label}<span style={{display:'flex',gap:'0.5rem',alignItems:'center'}}><input name={name} inputMode="decimal" maxLength={11} placeholder="Unbekannt" defaultValue={formatDocumentAmountInput(row?.[key])}/><span>{unit}</span></span></label>)}
    <label>Währung<input name="currency" pattern="[A-Z]{3}" maxLength={3} defaultValue={string('currency')} onInput={event=>setCurrency(event.currentTarget.value)}/></label>
    {currency&&/^[A-Z]{3}$/.test(currency)&&!isDocumentCentCurrency(currency)&&
      <p>Diese Währung kann im bestehenden Cent-Belegmodell nicht mit strukturierten Beträgen gespeichert werden. Originalbeträge bitte in der Belegnotiz dokumentieren.</p>}
    <label>Zahlungsstatus<select name="paymentStatus" defaultValue={string('payment_status')}>
      <option value="">Unbekannt</option><option value="paid">Bezahlt</option><option value="unpaid">Offen</option><option value="partial">Teilbezahlt</option>
    </select></label>
    <label>Notiz<textarea name="note" maxLength={4000} defaultValue={string('note')}/></label>
  </>;
}

export function AdminPortalDocuments(){
  const {data,error,refresh}=usePortalRead('/api/admin/documents',{action:'list'});
  const [selectedId,setSelectedId]=useState<string|null>(null),[form,setForm]=useState(false);
  const [notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const extractedFields=useRef<Record<string,string>>({});
  const [ocrReview,setOcrReview]=useState<ReturnType<typeof reviewDocumentPages>|null>(null);
  const [selectedPdf,setSelectedPdf]=useState<File|null>(null);
  const [selectedPart,setSelectedPart]=useState<{file:File;from:number;to:number}|null>(null);
  const [savedParts,setSavedParts]=useState<Record<number,string>>({});
  const [partFailures,setPartFailures]=useState<Record<number,'error'|'check'|undefined>>({});
  const [partDigests,setPartDigests]=useState<Record<number,string>>({});
  const submittingPart=useRef(false);
  const [splitFrom,setSplitFrom]=useState('1'),[splitTo,setSplitTo]=useState('1');
  const visibleReview=selectedPart ? ocrReview?.documents.find(part=>part.from===selectedPart.from)?.review : ocrReview;
  const [ocrContext,setOcrContext]=useState('');
  const [extractionNotice,setExtractionNotice]=useState('');
  const [cleanupId,setCleanupId]=useState<string|null>(null);
  const [cleanupError,setCleanupError]=useState('');
  const [removedIds,setRemovedIds]=useState<string[]>([]);
  const deleting=useRef(false);
  const [reviewedOriginalId,setReviewedOriginalId]=useState<string|null>(null);
  const docs=((data?.documents??[]) as PortalRow[]).filter(row=>!removedIds.includes(String(row.id)));
  const links=(data?.links??[]) as PortalRow[];
  const selected=docs.find(row=>row.id===selectedId)??null;
  const expenseDocumentIds=new Set(links.filter(link=>link.subject_type==='business_expense').map(link=>link.document_id));
  const selectedLinks=links.filter(row=>row.document_id===selectedId);
  const ledgerLinks=selectedLinks.filter(row=>row.subject_type==='financial_event');
  const registeredInvoice=typeof selected?.storage_path==='string'&&selected.storage_path.startsWith('invoice-register/');
  const cleanupPending=Boolean(selected?.cleanup_operation_id);
  const cleanupDocument=docs.find(row=>row.id===cleanupId);
  const cleanupBlock=(row:PortalRow)=>{
    if(links.some(link=>link.document_id===row.id))return 'Der Beleg ist mit einem Geschäftsvorgang oder einer Buchung verknüpft.';
    const reasons:string[]=[];
    if(row.kind!=='other'&&row.kind!=='expense_receipt')reasons.push('Geschützte Belegart');
    if(row.kind!=='expense_receipt'&&row.currency!=null)reasons.push('Währung gespeichert');
    if(['external_reference','issued_on','issuer','invoice_number','gross_cents','net_cents','tax_cents','payment_status','note']
      .some(field=>row[field]!=null))reasons.push('Weitere Belegdaten gespeichert');
    if(reasons.length)return reasons.join('. ')+'. Die Herkunft als aufbewahrungsfreier Testbeleg oder Entwurf ist nicht nachgewiesen.';
    if(typeof row.file_sha256!=='string'||!['pdf','jpg','png'].some(ext=>row.storage_path===`${row.id}/original.${ext}`))
      return 'Das private Original ist nicht eindeutig zugeordnet.';
    return null;
  };
  const blockReason=cleanupDocument?cleanupBlock(cleanupDocument):null;
  const requiresOriginalReview=cleanupDocument?.kind==='expense_receipt'&&!cleanupDocument.cleanup_operation_id;
  const deleteButton=(row:PortalRow)=>data?.canCleanup===true&&
    <button type="button" disabled={busy} onClick={()=>{setCleanupError('');setReviewedOriginalId(null);setCleanupId(String(row.id));}}>
      <span aria-hidden="true">🗑︎</span> Löschen
    </button>;
  const cards=(ocrReview?.documents??[]).map(part=>({part,status:documentCardStatus(
    part.review.fields,partDigests[part.from],Array.isArray(data?.documents)&&!error?docs:null,
    savedParts[part.from],partFailures[part.from],selectedPart?.from===part.from,
  )}));
  const pageMatches=(from:number)=>cards.find(card=>card.part.from===from)?.status;
  const savedCount=new Set(cards.flatMap(({status})=>'id' in status?[status.id]:[])).size;
  const endpoint='/api/admin/documents';

  async function perform(action:()=>Promise<void>){
    setBusy(true);setNotice('');
    try{await action();}catch(e){setNotice(e instanceof Error?e.message:'Aktion fehlgeschlagen.');}
    finally{setBusy(false);}
  }
  async function submit(event:FormEvent<HTMLFormElement>,action:string){
    event.preventDefault();
    const currentForm=event.currentTarget;
    const values=new FormData(currentForm);
    if(submittingPart.current)return;
    if(selectedPart)submittingPart.current=true;
    try{await perform(async()=>{
      if(action==='create_document' && ocrReview && ocrReview.batch!=='single') {
        if(ocrReview.batch!=='multiple'||!selectedPart||pageMatches(selectedPart.from)?.state==='saved'||pageMatches(selectedPart.from)?.state==='existing') {
          throw Error('Bitte zuerst einen eindeutig erkannten Einzelbeleg auswählen.');
        }
        values.set('file',selectedPart.file);
      }
      if(action==='create_document'||action==='update_document') documentAmountsToCents(values);
      if(action==='create_document'){
        values.set('action','confirm_document');
        let failure:'error'|'check'='error';
        try{
          const response=await fetch(endpoint,{method:'POST',body:values});
          const result=await response.json();
          if(!response.ok||result.ok!==true||typeof result.documentId!=='string'||!result.documentId.trim()){
            if(selectedPart&&response.status===409){
              failure='check';
              refresh();
            }
            throw Error(result.error??'Speichern fehlgeschlagen.');
          }
          setSelectedId(result.documentId);
          if(selectedPart) setSavedParts(previous=>({...previous,[selectedPart.from]:result.documentId}));
        }catch(error){
          if(selectedPart)setPartFailures(previous=>({...previous,[selectedPart.from]:failure}));
          throw error;
        }
        if(selectedPart){
          setSelectedPart(null);
          setOcrContext('');
          setExtractionNotice('');
          resetPartForm(currentForm);
        }else setForm(false);
      }else{
        const fields=Object.fromEntries(values);
        const operation=action==='income'&&fields.previousId?'correct_income':action;
        await portalRequest(endpoint,{...fields,action:operation,id:selectedId,documentId:selectedId,nonStripe:fields.nonStripe==='on'});
      }
      setNotice('Gespeichert.');refresh();
    });}finally{submittingPart.current=false;}
  }
  function resetPartForm(form:HTMLFormElement){
    form.reset();
    extractedFields.current={};
    const currency=form.elements.namedItem('currency');
    if(currency instanceof HTMLInputElement) currency.dispatchEvent(new Event('input',{bubbles:true}));
  }
  function applyReview(form:HTMLFormElement,review:ReturnType<typeof reviewDocumentPages>['documents'][number]['review']){
    setOcrContext(review.context.filter(fact=>!fact.unresolved).map(fact=>fact.label+': '+fact.value).join('\n'));
    const {applied,unresolved}=fillDocumentOcrPreview(form,review.fields,review.kind==='Kassenbon / Quittung');
    const missing=review.rates.length>1?unresolved.filter(item=>!item.startsWith('Steuersatz ')):unresolved;
    Object.assign(extractedFields.current,applied);
    const confirmation=form.elements.namedItem('confirmed');
    if(confirmation instanceof HTMLInputElement) confirmation.checked=false;
    const currency=form.elements.namedItem('currency');
    if(applied.currency && currency instanceof HTMLInputElement) currency.dispatchEvent(new Event('input',{bubbles:true}));
    setExtractionNotice('Alle Werte am Original prüfen. '+(missing.length?'Offen: '+missing.join('; ')+'.':'Erkannte Angaben wurden als Vorschläge eingesetzt.'));
  }
  async function selectPdfPart(form:HTMLFormElement,file:File,part:ReturnType<typeof reviewDocumentPages>['documents'][number]){
    if(ocrReview?.batch!=='multiple'||!ocrReview.documents.includes(part)||pageMatches(part.from)?.state==='saved'||pageMatches(part.from)?.state==='existing'||!part.review.fields.invoiceNumber) return;
    await perform(async()=>{
      const {splitDocumentPdf}=await import('../lib/documentOcr.browser');
      const blob=await splitDocumentPdf(file,part.from,part.to);
      const extracted=new File([blob],'beleg-seiten-'+part.from+'-'+part.to+'.pdf',{type:'application/pdf'});
      resetPartForm(form);
      applyReview(form,part.review);
      const title=form.elements.namedItem('title');
      if(title instanceof HTMLInputElement) title.value='Rechnung '+part.review.fields.invoiceNumber;
      setSelectedPart({file:extracted,from:part.from,to:part.to});
    });
  }
  async function preview(form:HTMLFormElement) {
    setExtractionNotice('');
    await perform(async()=>{
      const file=new FormData(form).get('file');
      if (!(file instanceof File)||!file.size) throw Error('Zuerst einen Originalbeleg auswählen.');
      const {readDocumentInBrowser}=await import('../lib/documentOcr.browser');
      const review=await readDocumentInBrowser(file);
      setOcrReview(review);
      if(review.batch!=='single') {
        setOcrContext('');
        if(review.batch==='multiple'){
          const {splitDocumentPdf}=await import('../lib/documentOcr.browser');
          const digests:Record<number,string>={};
          for(const part of review.documents){
            try{
              const pdf=await splitDocumentPdf(file,part.from,part.to);
              const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',await pdf.arrayBuffer()));
              digests[part.from]=Array.from(hash,byte=>byte.toString(16).padStart(2,'0')).join('');
            }catch{/* Missing checksum remains unverified. */}
          }
          setPartDigests(digests);
        }
        return;
      }
      applyReview(form,review);
    });
  }
  async function downloadPdfRange(file:File, from:number, to:number) {
    await perform(async()=>{
      const {splitDocumentPdf}=await import('../lib/documentOcr.browser');
      const part=await splitDocumentPdf(file,from,to);
      const url=URL.createObjectURL(part);
      const link=document.createElement('a');
      link.href=url;
      link.download=file.name.replace(/\.pdf$/i,'')+'-Seiten-'+from+'-'+to+'.pdf';
      link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
      setNotice('Teil-PDF erstellt. Lade sie als Einzelbeleg hoch und bestätige die Angaben separat.');
    });
  }
  async function download(id=selectedId,forReview=false){
    await perform(async()=>{
      const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'download',id})});
      if(!response.ok)throw Error('Originaldatei nicht verfügbar.');
      const url=URL.createObjectURL(await response.blob());
      const link=document.createElement('a');link.href=url;
      link.download=response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1]??'beleg';
      link.click();
      if(forReview)setReviewedOriginalId(id);
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
  }
  return <>
    <div className="portal-section-head"><h2>Private Geschäftsdokumente</h2>
      <button type="button" onClick={refresh}>Aktualisieren</button>
      <button type="button" disabled={busy} onClick={()=>{extractedFields.current={};setSelectedPdf(null);setSelectedPart(null);setSavedParts({});setPartFailures({});setPartDigests({});setOcrReview(null);setOcrContext('');setExtractionNotice('');setForm(v=>!v);}}>{form?'Abbrechen':'Dokument erfassen'}</button>
    </div>
    {notice&&<p role="status">{notice}</p>}
    {form&&<form className="portal-form admin-data-card" aria-label="Rechnung oder Dokument hochladen" onInput={event=>{
      const confirmation=event.currentTarget.elements.namedItem('confirmed');
      if(confirmation instanceof HTMLInputElement&&event.target!==confirmation) confirmation.checked=false;
    }} onSubmit={e=>void submit(e,'create_document')}>
      <label>Originalbeleg (PDF, JPG oder PNG, bis 3 MB)<input name="file" type="file" accept="application/pdf,image/jpeg,image/png" disabled={busy} onChange={event=>{
        const file=event.currentTarget.files?.[0];
        setSelectedPdf(file?.type==='application/pdf'?file:null);
        setSelectedPart(null);setSavedParts({});setPartFailures({});setPartDigests({});
        setSplitFrom('1');setSplitTo('1');
        const fields=event.currentTarget.form?.elements;
        for(const [name,value] of Object.entries(extractedFields.current)) {
          const control=fields?.namedItem(name);
          if(control instanceof HTMLInputElement&&control.value===value) {
            control.value='';
            if(name==='currency') control.dispatchEvent(new Event('input',{bubbles:true}));
          }
        }
        extractedFields.current={};
        setOcrReview(null);setOcrContext('');
        setExtractionNotice('');
        const confirmed=fields?.namedItem('confirmed');
        if(confirmed instanceof HTMLInputElement)confirmed.checked=false;
        if(event.currentTarget.files?.length&&event.currentTarget.form) void preview(event.currentTarget.form);
      }}/></label>
      <button type="button" disabled={busy||ocrReview?.batch==='multiple'} onClick={e=>{if(e.currentTarget.form)void preview(e.currentTarget.form);}}>Belegdaten auslesen</button>
      {extractionNotice&&<p role="status">{extractionNotice}</p>}
      {selectedPdf&&<details open={ocrReview?.batch==='unclear'}>
        <summary>PDF nach Seiten aufteilen</summary>
        <p>Wähle die Seiten eines einzelnen Belegs. Die Teil-PDF ist eine lokal erstellte Kopie. Bewahre die Quelldatei auf und lade jeden Beleg separat hoch. Teilen nach Seiten kann zwei Rechnungen auf derselben Seite nicht trennen.</p>
        <label>Erste Seite<input type="number" min={1} max={ocrReview?.pageCount} value={splitFrom} onChange={event=>setSplitFrom(event.currentTarget.value)}/></label>
        <label>Letzte Seite<input type="number" min={1} max={ocrReview?.pageCount} value={splitTo} onChange={event=>setSplitTo(event.currentTarget.value)}/></label>
        <button type="button" disabled={busy} onClick={()=>void downloadPdfRange(selectedPdf,Number(splitFrom),Number(splitTo))}>Teil-PDF herunterladen</button>
      </details>}
      {selectedPart&&<p role="status">Ausgewählter Einzelbeleg: Seiten {selectedPart.from}–{selectedPart.to}.</p>}
      {ocrReview&&<>
        {ocrReview.batch==='single'&&<p>Erkannte Belegart: {ocrReview.kind}.</p>}
        {visibleReview && visibleReview.rates.length>1&&<p>Mehrere Steuersätze: {visibleReview.rates.map(rate=>rate.replace('.',',')+' %').join(', ')}.</p>}
        {cards.length>0&&<section className="portal-invoice-batch" aria-label="Erkannte Rechnungen">
          <p role="status">{savedCount} von {cards.length} Rechnungen gespeichert</p>
          <div className="portal-invoice-grid">{cards.map(({part,status})=>{
            const {fields}=part.review;
            const stored='id' in status;
            const label={review:'Zur Prüfung',editing:'In Bearbeitung',saved:'Gespeichert',existing:'Bereits vorhanden',error:'Fehler',check:'Status prüfen'}[status.state];
            return <article key={part.from} className="portal-invoice-card" aria-label={'Rechnung '+(fields.invoiceNumber??'ohne Nummer')}>
              <h3>Rechnung {fields.invoiceNumber??'–'}</h3>
              <span className={'portal-invoice-status portal-invoice-status--'+status.state}>
                {stored&&<span aria-hidden="true">✓ </span>}{label}
              </span>
              <dl className="portal-facts">
                <div><dt>PDF-Seiten</dt><dd>{part.from===part.to?part.from:part.from+'–'+part.to}</dd></div>
                <div><dt>Datum</dt><dd>{fields.issuedOn?date(fields.issuedOn):'Unbekannt'}</dd></div>
                <div><dt>Netto</dt><dd>{documentAmount(fields.netCents,fields.currency)}</dd></div>
                <div><dt>Umsatzsteuer</dt><dd>{documentAmount(fields.taxCents,fields.currency)}</dd></div>
                <div><dt>Brutto</dt><dd>{documentAmount(fields.grossCents,fields.currency)}</dd></div>
              </dl>
              {stored?<><button type="button" onClick={()=>setSelectedId(status.id)}>Gespeicherten Beleg öffnen</button>
                <p className="portal-note">Belegreferenz {status.id}</p></>
                :selectedPdf&&fields.invoiceNumber&&<button type="button" disabled={busy||selectedPart?.from===part.from}
                  onClick={event=>{if(event.currentTarget.form)void selectPdfPart(event.currentTarget.form,selectedPdf,part);}}>Rechnung prüfen</button>}
            </article>;
          })}</div>
        </section>}
        {visibleReview&&visibleReview.issues.length>0&&<ul>{visibleReview.issues.map(issue=><li key={issue}>{issue}</li>)}</ul>}
        {visibleReview&&Object.keys(visibleReview.evidence).length>0&&<details><summary>Quellen der Feldvorschläge</summary>
          <dl>{Object.entries(visibleReview.evidence).map(([key,source])=><div key={key}>
            <dt>{fieldsForReview[key as keyof typeof fieldsForReview]?.[0]??key}</dt>
            <dd style={{whiteSpace:'pre-wrap'}}>{source}</dd>
          </div>)}</dl>
        </details>}
        {visibleReview&&visibleReview.context.length>0&&<details><summary>Weitere Belegangaben prüfen</summary>
          <dl>{visibleReview.context.map(fact=><div key={fact.label+fact.source}><dt>{fact.label}{fact.unresolved?' – ungeklärt':''}</dt><dd>{fact.value}<br/>{fact.source}</dd></div>)}</dl>
          <label>Zusatzangaben für die Belegnotiz, ohne Zahlungsbestätigung
            <textarea value={ocrContext} maxLength={1500} onChange={event=>setOcrContext(event.target.value)}/>
          </label>
          <button type="button" disabled={!ocrContext.trim()||busy} onClick={event=>{
            const note=event.currentTarget.form?.elements.namedItem('note');
            if(!(note instanceof HTMLTextAreaElement))return;
            const next=[note.value,ocrContext.trim()].filter(Boolean).join('\n');
            if(next.length>4000){setNotice('Die Belegnotiz ist zu lang. Bitte kürzen.');return;}
            note.value=next;setOcrContext('');
          }}>In Belegnotiz übernehmen</button>
        </details>}
        {ocrReview.source&&!selectedPart&&<details><summary>Erkannten Belegtext prüfen</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{ocrReview.source}</pre></details>}
      </>}
      <div className="portal-invoice-fields" hidden={Boolean(ocrReview&&ocrReview.batch!=='single'&&!selectedPart)}>
      <MetadataFields/>
      <p>Leere Betragsfelder bedeuten unbekannt. 0,00 ist ein ausdrücklicher Nullbetrag. OCR-Vorschläge bleiben bis zur Admin-Bestätigung ungeprüft.</p>
      <label>Art<select name="kind">{['expense_receipt','gloa_invoice','stripe_receipt','b2b_document','other'].map(v=><option key={v} value={v}>{label(v)}</option>)}</select></label>
      <label>Steuersatz laut Beleg (%)<input name="taxRate" inputMode="decimal" maxLength={5}/></label>
      <label>Leistungsdatum, falls belegt<input name="serviceOn" type="date"/></label>
      <label>Zahlungsangabe am Beleg<input name="paymentHint" maxLength={200}/></label>
      <label>Belegrichtung<select name="direction" required defaultValue=""><option value="">Bitte wählen</option><option value="income">Einnahme</option><option value="expense">Ausgabe</option></select></label>
      <label><input type="checkbox" name="confirmed" value="yes" required/> Angaben am Original geprüft und bestätigt</label>
      <p>Speichern bestätigt nur die Belegdaten. Eine Zahlung, Buchung oder Vorsteuer wird dadurch nicht bestätigt.</p>
      <label>Externe Belegreferenz<input name="externalReference" maxLength={200}/></label>
      <button disabled={busy||Boolean(ocrReview&&ocrReview.batch!=='single'&&(!selectedPart||['saved','existing'].includes(pageMatches(selectedPart.from)?.state??'')))}>Dokument speichern</button>
      </div>
    </form>}
    <ReadState data={data} error={error} retry={refresh}>
      <BusinessTable rows={docs} onOpen={row=>setSelectedId(String(row.id))} rowActions={deleteButton} columns={[
        {key:'title',title:'Dokument'},{key:'kind',title:'Art',render:r=>label(r.kind)},
        {key:'issued_on',title:'Rechnungsdatum',render:r=>date(r.issued_on)},{key:'issuer',title:'Aussteller'},
                {key:'invoice_number',title:'Rechnungsnummer'},
        {key:'net_cents',title:'Netto',render:r=>documentAmount(r.net_cents,r.currency)},
        {key:'tax_cents',title:'Umsatzsteuer',render:r=>documentAmount(r.tax_cents,r.currency)},
        {key:'gross_cents',title:'Brutto',render:r=>documentAmount(r.gross_cents,r.currency)},
        {key:'expense_assignment',title:'Ausgabenbuchung',render:r=>expenseDocumentIds.has(r.id)
          ? <span className="portal-chip portal-expense-assignment">Bereits zugeordnet</span>
          : r.kind==='expense_receipt' ? 'Keine Ausgabenverknüpfung' : '—'},
      ]}/>
    </ReadState>
    {cleanupDocument&&data?.canCleanup===true&&<dialog className="portal-document-delete-dialog" ref={dialog=>{if(dialog&&!dialog.open)dialog.showModal();}}
      aria-labelledby="document-cleanup-title" onCancel={event=>{event.preventDefault();event.stopPropagation();if(!deleting.current)setCleanupId(null);}}>
      <h2 id="document-cleanup-title">{text(cleanupDocument.title)}</h2>
      {blockReason?<><p>{blockReason}</p>
        <button type="button" onClick={()=>{setSelectedId(String(cleanupDocument.id));setCleanupId(null);}}>Belegdetails öffnen</button>
        <button type="button" onClick={()=>setCleanupId(null)}>Schließen</button>
      </>:<form className="portal-form" onSubmit={async event=>{
        event.preventDefault();
        if(deleting.current||(requiresOriginalReview&&reviewedOriginalId!==cleanupDocument.id))return;
        const values=new FormData(event.currentTarget);
        const id=String(cleanupDocument.id);
        deleting.current=true;setBusy(true);setCleanupError('');
        try{
          await portalRequest(endpoint,{action:'cleanup_document',id,confirmed:true,
            resume:Boolean(cleanupDocument.cleanup_operation_id),disposition:requiresOriginalReview?'synthetic':values.get('disposition'),
            originalReviewed:requiresOriginalReview&&values.get('originalReviewed')==='yes',review:values.get('review')});
          setRemovedIds(ids=>[...ids,id]);
          setSelectedId(current=>current===id?null:current);
          setCleanupId(null);setNotice('Datei und Beleg wurden gelöscht.');
        }catch(error){
          setCleanupError(error instanceof Error?error.message:'Löschung konnte nicht bestätigt werden.');
        }finally{deleting.current=false;setBusy(false);refresh();}
      }}>
        <p>{cleanupDocument.cleanup_operation_id?'Die begonnene Löschung wird fortgesetzt.':'Datei und Beleg werden unwiderruflich entfernt. Die Löschung setzt einen nachweislich aufbewahrungsfreien Beleg voraus.'}</p>
        {cleanupError&&<p role="alert">{cleanupError}</p>}
        {!cleanupDocument.cleanup_operation_id&&<>
          {requiresOriginalReview?<>
            <button type="button" disabled={busy} onClick={()=>void download(String(cleanupDocument.id),true)}>Original zur Prüfung herunterladen</button>
            <label><input name="originalReviewed" type="checkbox" value="yes" required disabled={reviewedOriginalId!==cleanupDocument.id}/>
              Ich habe das Original geprüft. Es ist rein synthetisch und muss nicht aufbewahrt werden.</label>
          </>:<label>Nachgewiesene Herkunft<select name="disposition" required defaultValue="">
            <option value="">Bitte wählen</option><option value="synthetic">Synthetischer Testbeleg</option>
            <option value="draft">Verwerfbarer Entwurf</option>
          </select></label>}
          <label>Nachweis zur Herkunft und Aufbewahrungsfreiheit<textarea name="review" required minLength={15} maxLength={requiresOriginalReview?400:450}/></label>
        </>}
        <div className="portal-document-delete-actions">
          <button type="button" autoFocus disabled={busy} onClick={()=>setCleanupId(null)}>Abbrechen</button>
          <button type="submit" disabled={busy||(requiresOriginalReview&&reviewedOriginalId!==cleanupDocument.id)}>{busy?'Löschung läuft…':'Endgültig löschen'}</button>
        </div>
      </form>}
    </dialog>}
    <RecordDetails row={selected} title={text(selected?.title)} onClose={()=>setSelectedId(null)}>
      {selected&&<>
        <AdminDocumentFacts row={selected}/>
        {cleanupPending&&<p>Löschung offen. Zuordnung und Bearbeitung sind gesperrt.</p>}
        {deleteButton(selected)}
        {!cleanupPending&&<>
        {registeredInvoice&&data?.canReadRegisteredInvoices!==true ? <p>Dieses Original ist nur für Owner abrufbar.</p> : typeof selected.file_sha256==='string'
          ? <button type="button" disabled={busy} onClick={()=>void download()}>Originalbeleg herunterladen</button>
          : <p>Referenzbeleg ohne gespeicherte Originaldatei.</p>}
        <details><summary>Belegdaten korrigieren</summary>
          <form className="portal-form" key={JSON.stringify(selected)} onSubmit={e=>void submit(e,'update_document')}>
            <MetadataFields row={selected}/><button disabled={busy}>Metadaten speichern</button>
          </form>
        </details>
        <h3>Geschäftsbezüge</h3>
        {selectedLinks.some(link=>['financial_event','business_expense','order'].includes(String(link.subject_type)))&&
          <AdminDocumentAccountingContext key={selectedId} id={String(selectedId)}/>}
        <BusinessTable rows={selectedLinks} columns={[{key:'subject_type',title:'Bereich',render:r=>label(r.subject_type)},{key:'subject_id',title:'Datensatz-ID'}]}/>
        <form className="portal-form" onSubmit={e=>void submit(e,'link_document')}><AdminPortalDocumentAssociation key={selectedId} busy={busy} reference={String(selected.external_reference??'')}/></form>
        {typeof selected.file_sha256==='string'&&selected.payment_status==='paid'&&
          (selected.kind==='gloa_invoice'||selected.kind==='other')&&!selected.external_reference&&<>
          <details><summary>Manuelle Einnahme außerhalb Stripe</summary>
            <form className="portal-form" key={String(selected.id)} onSubmit={e=>void submit(e,'income')}>
              <label>Zahlungsdatum<input name="occurredOn" type="date" required/></label>
              <label>Eindeutige Zahlungsreferenz<input name="reference" required minLength={3} maxLength={160}/></label>
              <label>Begründung<input name="reason" required minLength={3} maxLength={500}/></label>
              {centsFields.map(([name,title,key])=><label key={name}>{title}<input name={name} type="number" min={name==='grossCents'?1:0}
                step="1" required={name==='grossCents'} defaultValue={selected[key]==null?'':String(selected[key])}/></label>)}
              {ledgerLinks.length>0&&<label>Zu korrigierende Ledger-ID<select name="previousId" required>
                <option value="">Bitte wählen</option>{ledgerLinks.map(row=><option key={String(row.subject_id)} value={String(row.subject_id)}>{String(row.subject_id)}</option>)}
              </select></label>}
              <label><input type="checkbox" name="nonStripe" required/> Zahlung außerhalb Stripe anhand des Belegs geprüft</label>
              <button disabled={busy}>Einnahme speichern</button>
            </form>
          </details>
        </>}
        </>}
      </>}
    </RecordDetails>
  </>;
}
