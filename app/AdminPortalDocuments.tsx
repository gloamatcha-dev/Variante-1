"use client";
import {AdminPortalDocumentAssociation} from './AdminPortalDocumentAssociation';
import { useState } from 'react';
import { date, label, text, type PortalRow } from '../lib/adminPortalModel.ts';
import {BusinessTable,Chip,ReadState,RecordDetails,portalRequest,usePortalRead} from './AdminPortalShared';

export function AdminPortalDocuments(){
  const {data,error,refresh}=usePortalRead('/api/admin/documents',{action:'list'});
  const [selected,setSelected]=useState<PortalRow|null>(null),[form,setForm]=useState(false),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  async function create(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();setBusy(true);setNotice('');const values=Object.fromEntries(new FormData(event.currentTarget));
    try{await portalRequest('/api/admin/documents',{action:'create_document',...values});setForm(false);refresh();}catch(e){setNotice(e instanceof Error?e.message:'Speichern fehlgeschlagen.');}finally{setBusy(false);}
  }
  async function associate(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();setBusy(true);const values=Object.fromEntries(new FormData(event.currentTarget));
    try{await portalRequest('/api/admin/documents',{action:'link_document',documentId:selected?.id,...values});setNotice('Zuordnung gespeichert.');refresh();}catch(e){setNotice(e instanceof Error?e.message:'Zuordnung fehlgeschlagen.');}finally{setBusy(false);}
  }
  return <><div className="portal-section-head"><h2>Private Geschäftsdokumente</h2><div className="portal-actions"><button type="button" onClick={refresh}>Aktualisieren</button><button type="button" onClick={()=>setForm(v=>!v)}>{form?'Abbrechen':'Dokument erfassen'}</button></div></div><p className="portal-note">Stripe-Zahlungsbelege und GLOA-Dokumente bleiben getrennt. Vorhandene private Dateien können über ihren Speicherpfad erfasst und zugeordnet werden. Das bestehende Backend bietet keinen Datei-Upload oder Rechnungsgenerator.</p>{notice&&<p role="status">{notice}</p>}{form&&<form className="portal-form" onSubmit={create}><label>Titel<input name="title" required maxLength={200}/></label><label>Art<select name="kind">{['stripe_receipt','gloa_invoice','expense_receipt','b2b_document','other'].map(v=><option key={v} value={v}>{label(v)}</option>)}</select></label><label>Privater Speicherpfad<input name="storagePath" placeholder="ordner/datei.pdf"/></label><label>Provider-Belegreferenz<input name="externalReference"/></label><label>Notiz<textarea name="note"/></label><button disabled={busy} type="submit">Dokument speichern</button></form>}<ReadState data={data} error={error} retry={refresh}><BusinessTable rows={(data?.documents??[]) as PortalRow[]} onOpen={setSelected} columns={[{key:'title',title:'Dokument'},{key:'kind',title:'Art',render:r=><Chip value={r.kind}/>},{key:'created_at',title:'Erfasst',render:r=>date(r.created_at)},{key:'note',title:'Notiz'}]}/><p className="portal-note">Die Liste enthält alle erfassten Dokumente und Zuordnungen.</p></ReadState><RecordDetails row={selected} title={text(selected?.title)} onClose={()=>setSelected(null)}>{selected&&<><p>{text(selected.note)}</p><dl className="portal-facts"><div><dt>Art</dt><dd>{label(selected.kind)}</dd></div><div><dt>Private Datei</dt><dd>{selected.storage_path?'Erfasst':'Keine Datei hinterlegt'}</dd></div></dl><h3>Geschäftsbezüge</h3><BusinessTable rows={((data?.links??[]) as PortalRow[]).filter(r=>r.document_id===selected.id)} columns={[{key:'subject_type',title:'Bereich',render:r=>label(r.subject_type)},{key:'reference',title:'Bezug',render:()=> 'Geschäftsobjekt verknüpft'}]}/><form className="portal-form" onSubmit={associate}><AdminPortalDocumentAssociation busy={busy}/></form></>}</RecordDetails></>;
}
