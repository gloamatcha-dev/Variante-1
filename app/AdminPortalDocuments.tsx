"use client";
import {useRef,useState,type FormEvent} from 'react';
import {documentAmountFields,documentAmountsToCents,formatDocumentAmountInput} from '../lib/documentAmountInput';
import {fillDocumentOcrPreview} from '../lib/documentOcrPreview';
import {AdminDocumentFacts, AdminDocumentAccountingContext} from './AdminDocumentFacts';
import {AdminPortalDocumentAssociation} from './AdminPortalDocumentAssociation';
import {date,label,text,type PortalRow} from '../lib/adminPortalModel.ts';
import {BusinessTable,ReadState,RecordDetails,portalRequest,usePortalRead} from './AdminPortalShared';

const centsFields=[['grossCents','Brutto (Cent)','gross_cents'],['netCents','Netto (Cent)','net_cents'],['taxCents','Steuer (Cent)','tax_cents']];

function MetadataFields({row}:{row?:PortalRow}) {
  const string=(name:string)=>row?.[name]==null?'':String(row[name]);
  const [currency,setCurrency]=useState(string('currency'));
  const unit=currency==='EUR'?'€':/^[A-Z]{3}$/.test(currency)?currency:'in Belegwährung';
  return <>
    <label>Titel<input name="title" required maxLength={200} defaultValue={string('title')}/></label>
    <label>Rechnungsdatum<input name="issuedOn" type="date" defaultValue={string('issued_on')}/></label>
    <label>Aussteller<input name="issuer" maxLength={200} defaultValue={string('issuer')}/></label>
    <label>Rechnungsnummer<input name="invoiceNumber" maxLength={120} defaultValue={string('invoice_number')}/></label>
    {Object.entries(documentAmountFields).map(([name,[label,key]])=><label key={name}>{label}<span style={{display:'flex',gap:'0.5rem',alignItems:'center'}}><input name={name} inputMode="decimal" maxLength={11} placeholder="0,00" defaultValue={formatDocumentAmountInput(row?.[key])}/><span>{unit}</span></span></label>)}
    <label>Währung<input name="currency" pattern="[A-Z]{3}" maxLength={3} defaultValue={string('currency')} onInput={event=>setCurrency(event.currentTarget.value)}/></label>
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
  const [ocrSource,setOcrSource]=useState('');
  const [extractionNotice,setExtractionNotice]=useState('');
  const [confirmCleanup,setConfirmCleanup]=useState(false);
  const docs=(data?.documents??[]) as PortalRow[];
  const links=(data?.links??[]) as PortalRow[];
  const selected=docs.find(row=>row.id===selectedId)??null;
  const selectedLinks=links.filter(row=>row.document_id===selectedId);
  const ledgerLinks=selectedLinks.filter(row=>row.subject_type==='financial_event');
  const registeredInvoice=typeof selected?.storage_path==='string'&&selected.storage_path.startsWith('invoice-register/');
  const cleanupPending=Boolean(selected?.cleanup_operation_id);
  const canCleanup=data?.canCleanup===true&&selected?.kind==='other'&&selectedLinks.length===0&&
    typeof selected.file_sha256==='string'&&
    ['pdf','jpg','png'].some(ext=>selected.storage_path===`${selected.id}/original.${ext}`)&&
    ['external_reference','issued_on','issuer','invoice_number','gross_cents','net_cents','tax_cents','currency','payment_status','note']
      .every(field=>selected[field]==null);
  const endpoint='/api/admin/documents';

  async function perform(action:()=>Promise<void>){
    setBusy(true);setNotice('');
    try{await action();}catch(e){setNotice(e instanceof Error?e.message:'Aktion fehlgeschlagen.');}
    finally{setBusy(false);}
  }
  async function submit(event:FormEvent<HTMLFormElement>,action:string){
    event.preventDefault();
    const values=new FormData(event.currentTarget);
    await perform(async()=>{
      if(action==='create_document'||action==='update_document') documentAmountsToCents(values);
      if(action==='create_document'){
        values.set('action','confirm_document');
        const response=await fetch(endpoint,{method:'POST',body:values});
        const result=await response.json();
        if(!response.ok||result.ok!==true)throw Error(result.error??'Speichern fehlgeschlagen.');
        setForm(false);setSelectedId(String(result.documentId));
      }else{
        const fields=Object.fromEntries(values);
        const operation=action==='income'&&fields.previousId?'correct_income':action;
        await portalRequest(endpoint,{...fields,action:operation,id:selectedId,documentId:selectedId,nonStripe:fields.nonStripe==='on'});
      }
      setNotice('Gespeichert.');refresh();
    });
  }
  async function preview(form:HTMLFormElement) {
    setExtractionNotice('');
    await perform(async()=>{
      const file=new FormData(form).get('file');
      if (!(file instanceof File)||!file.size) throw Error('Zuerst einen Originalbeleg auswählen.');
      const {readDocumentInBrowser}=await import('../lib/documentOcr.browser');
      const {fields,source}=await readDocumentInBrowser(file);
      setOcrSource(source);
      const {applied,unresolved}=fillDocumentOcrPreview(form,fields);
      Object.assign(extractedFields.current,applied);
      const currencyInput=form.elements.namedItem('currency');
      if(applied.currency && currencyInput instanceof HTMLInputElement) {
        currencyInput.dispatchEvent(new Event('input',{bubbles:true}));
      }
      setExtractionNotice('Alle Werte am Original prüfen. '+(unresolved.length?'Offen: '+unresolved.join('; ')+'.':'Erkannte Angaben wurden als Vorschläge eingesetzt.'));
    });
  }
  async function download(){
    await perform(async()=>{
      const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'download',id:selectedId})});
      if(!response.ok)throw Error('Originaldatei nicht verfügbar.');
      const url=URL.createObjectURL(await response.blob());
      const link=document.createElement('a');link.href=url;
      link.download=response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1]??'beleg';
      link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
  }
  return <>
    <div className="portal-section-head"><h2>Private Geschäftsdokumente</h2>
      <button type="button" onClick={refresh}>Aktualisieren</button>
      <button type="button" disabled={busy} onClick={()=>{extractedFields.current={};setOcrSource('');setExtractionNotice('');setForm(v=>!v);}}>{form?'Abbrechen':'Dokument erfassen'}</button>
    </div>
    {notice&&<p role="status">{notice}</p>}
    {form&&<form className="portal-form admin-data-card" aria-label="Rechnung oder Dokument hochladen" onSubmit={e=>void submit(e,'create_document')}>
      <MetadataFields/>
      <label>Art<select name="kind">{['expense_receipt','gloa_invoice','stripe_receipt','b2b_document','other'].map(v=><option key={v} value={v}>{label(v)}</option>)}</select></label>
      <label>Originalbeleg (PDF, JPG oder PNG, bis 3 MB)<input name="file" type="file" accept="application/pdf,image/jpeg,image/png" disabled={busy} onChange={event=>{
        const fields=event.currentTarget.form?.elements;
        for(const [name,value] of Object.entries(extractedFields.current)) {
          const control=fields?.namedItem(name);
          if(control instanceof HTMLInputElement&&control.value===value) {
            control.value='';
            if(name==='currency') control.dispatchEvent(new Event('input',{bubbles:true}));
          }
        }
        extractedFields.current={};
        setOcrSource('');
        setExtractionNotice('');
        const confirmed=fields?.namedItem('confirmed');
        if(confirmed instanceof HTMLInputElement)confirmed.checked=false;
        if(event.currentTarget.files?.length&&event.currentTarget.form) void preview(event.currentTarget.form);
      }}/></label>
      <button type="button" disabled={busy} onClick={e=>{if(e.currentTarget.form)void preview(e.currentTarget.form);}}>Belegdaten auslesen</button>
      {extractionNotice&&<p role="status">{extractionNotice}</p>}
      {ocrSource&&<details><summary>Erkannten Belegtext prüfen</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{ocrSource}</pre></details>}
      <label>Steuersatz laut Beleg (%)<input name="taxRate" inputMode="decimal" maxLength={5}/></label>
      <label>Leistungsdatum, falls belegt<input name="serviceOn" type="date"/></label>
      <label>Zahlungsangabe am Beleg<input name="paymentHint" maxLength={200}/></label>
      <label>Belegrichtung<select name="direction" required defaultValue=""><option value="">Bitte wählen</option><option value="income">Einnahme</option><option value="expense">Ausgabe</option></select></label>
      <label><input type="checkbox" name="confirmed" value="yes" required/> Angaben am Original geprüft und bestätigt</label>
      <p>Speichern bestätigt nur die Belegdaten. Eine Zahlung, Buchung oder Vorsteuer wird dadurch nicht bestätigt.</p>
      <label>Externe Belegreferenz<input name="externalReference" maxLength={200}/></label>
      <button disabled={busy}>Dokument speichern</button>
    </form>}
    <ReadState data={data} error={error} retry={refresh}>
      <BusinessTable rows={docs} onOpen={row=>{setConfirmCleanup(false);setSelectedId(String(row.id));}} columns={[
        {key:'title',title:'Dokument'},{key:'kind',title:'Art',render:r=>label(r.kind)},
        {key:'issued_on',title:'Rechnungsdatum',render:r=>date(r.issued_on)},{key:'issuer',title:'Aussteller'},
        {key:'invoice_number',title:'Rechnungsnummer'},
      ]}/>
    </ReadState>
    <RecordDetails row={selected} title={text(selected?.title)} onClose={()=>setSelectedId(null)}>
      {selected&&<>
        <AdminDocumentFacts row={selected}/>
        {cleanupPending&&<p>Löschung offen. Zuordnung und Bearbeitung sind gesperrt.</p>}
        {canCleanup&&<button type="button" disabled={busy} onClick={()=>setConfirmCleanup(true)}>
          {cleanupPending?'Löschung fortsetzen':'Endgültig löschen'}
        </button>}
        {canCleanup&&confirmCleanup&&<dialog open aria-label="Dokument endgültig entfernen">
          <form onSubmit={event=>{
            event.preventDefault();
            const fields=new FormData(event.currentTarget);
            void perform(async()=>{
              try{
                await portalRequest(endpoint,{action:'cleanup_document',id:selectedId,confirmed:true,review:fields.get('review')});
                setSelectedId(null);setNotice('Datei und Metadaten entfernt.');
              }finally{setConfirmCleanup(false);refresh();}
            });
          }}>
            <p>Datei und Metadaten werden endgültig entfernt.</p>
            {!cleanupPending&&<label>Nachweis, dass keine Aufbewahrungspflicht besteht
              <textarea name="review" required minLength={15} maxLength={500}/>
            </label>}
            <button disabled={busy}>Endgültig löschen</button>
            <button type="button" disabled={busy} onClick={()=>setConfirmCleanup(false)}>Abbrechen</button>
          </form>
        </dialog>}
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
