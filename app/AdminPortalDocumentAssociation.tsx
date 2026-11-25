"use client";
import {useState} from 'react';
import {label,text,type PortalRow} from '../lib/adminPortalModel.ts';
import {portalRequest} from './AdminPortalShared';

export function AdminPortalDocumentAssociation({busy,reference=''}:{busy:boolean;reference?:string}){
  const [kind,setKind]=useState('order'),[query,setQuery]=useState(''),[results,setResults]=useState<PortalRow[]>([]),[selected,setSelected]=useState(''),[error,setError]=useState(''),[searching,setSearching]=useState(false);
  const [exact,setExact]=useState(reference);
  const [suggestionNote,setSuggestionNote]=useState('');
  async function suggest(){
    setSearching(true);setSelected('');setResults([]);setError('');setSuggestionNote('');
    try {
      const result=await portalRequest('/api/admin/documents',{action:'suggest_document_link',reference:exact});
      const suggestion=result.suggestion as {id:string;kind:string}|null;
      if(suggestion){setKind(suggestion.kind);setSelected(suggestion.id);setSuggestionNote('Eindeutiger Referenztreffer: '+label(suggestion.kind)+' · '+suggestion.id+'. Zuordnung vor dem Speichern prüfen.');}
      else setSuggestionNote(result.state==='ambiguous'?'Mehrere Treffer. Keine Zuordnung vorgeschlagen.':'Kein zuordenbarer Referenztreffer.');
    }catch(e){setError(e instanceof Error?e.message:'Prüfung fehlgeschlagen.');}finally{setSearching(false);}
  }
  async function search(){setSearching(true);setError('');setResults([]);try{const result=await portalRequest('/api/admin/portal',{action:'search',search:query});const table=({order:'orders',annual_plan:'annual_plans',b2b_agreement:'b2b_supply_agreements',creator:'creators',business_expense:'business_expenses'} as Record<string,string>)[kind];setResults((result.results as PortalRow[]).filter(r=>r.entity===table));}catch(e){setError(e instanceof Error?e.message:'Suche fehlgeschlagen.');}finally{setSearching(false);}}
  return <><label>Exakte Geschäftsreferenz<input value={exact} maxLength={200} onChange={e=>{setExact(e.target.value);setSelected('');setSuggestionNote('');}}/></label><button type="button" disabled={busy||searching||!exact.trim()} onClick={()=>void suggest()}>Zuordnung vorschlagen</button>{suggestionNote&&<p role="status">{suggestionNote}</p>}<label>Bereich<select name="entityType" value={kind} onChange={e=>{setKind(e.target.value);setSelected('');setResults([]);}}>{['order','business_expense','annual_plan','b2b_agreement','customer','creator','financial_event'].map(v=><option key={v} value={v}>{label(v)}</option>)}</select></label>{kind!=='customer'&&kind!=='financial_event'&&<><label>Geschäftsobjekt suchen<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Bestellnummer, Name oder E-Mail"/></label><button type="button" disabled={busy||searching||query.trim().length<2} onClick={()=>void search()}>{searching?'Suche …':'Suchen'}</button><label>Geschäftsobjekt<select value={selected} onChange={e=>setSelected(e.target.value)}><option value="">Bitte wählen</option>{results.map(r=><option key={String(r.id)} value={String(r.id)}>{text(r.order_number??r.display_name??r.description??(r.business_snapshot as PortalRow)?.companyName??(r.customer_snapshot as PortalRow)?.name,'Geschäftsobjekt')} · {text(r.email??(r.customer_snapshot as PortalRow)?.email,'')}</option>)}</select></label></>}{error&&<p role="alert">{error}</p>}<input type="hidden" name="entityId" value={selected}/><details><summary>Weitere Details: vorhandene Datensatz-ID</summary><label>Datensatz-ID<input value={selected} pattern="[0-9a-fA-F-]{36}" onChange={e=>setSelected(e.target.value)}/></label><p className="portal-note">Kundenbezüge verwenden die vorhandene Nutzer-ID. Es wird kein Kunde angelegt.</p></details><button disabled={busy||searching||!selected} type="submit">Zuordnung speichern</button></>;
}
