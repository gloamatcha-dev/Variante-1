"use client";
import {useState} from 'react';
import {text,type PortalRow} from '../lib/adminPortalModel.ts';
import {BusinessTable,ReadState,portalRequest,usePortalRead} from './AdminPortalShared';

export function ExpenseOrderSearch({value,onChange}:{value:string;onChange:(id:string)=>void}){
 const [query,setQuery]=useState(''),[rows,setRows]=useState<PortalRow[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function search(){setBusy(true);setError('');try{const data=await portalRequest('/api/admin/portal',{action:'search',search:query});setRows((data.results as PortalRow[]).filter(r=>r.entity==='orders'));}catch(e){setError(e instanceof Error?e.message:'Suche fehlgeschlagen.');}finally{setBusy(false);}}
 return <div><label>Bestellung suchen<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Bestellnummer, Name oder E-Mail"/></label><button type="button" disabled={busy||query.trim().length<2} onClick={()=>void search()}>{busy?'Suche …':'Suchen'}</button><label>Bestellung<select value={value} onChange={e=>onChange(e.target.value)}><option value="">Bitte wählen</option>{value&&!rows.some(r=>r.id===value)&&<option value={value}>Vorhandene Zuordnung</option>}{rows.map(r=><option key={String(r.id)} value={String(r.id)}>{text(r.order_number)} · {text((r.customer_snapshot as PortalRow)?.name,'')}</option>)}</select></label>{error&&<p role="alert">{error}</p>}<details><summary>Weitere Details</summary><label>Bestell-ID<input value={value} maxLength={36} onChange={e=>onChange(e.target.value)}/></label></details></div>;
}

export function MissingExpenseOrders({onSelect}:{onSelect:(id:string)=>void}){
 const {data,error,refresh}=usePortalRead('/api/admin/finance',{action:'missing_costs'});
 return <section><h3>Bestellungen ohne erfasste direkte Kosten</h3><p className="portal-note">Bezahlte Bestellungen im aktuellen Monat. Keine Aussage über bereits vollständig erfasste Einzelkosten.</p><ReadState data={data} error={error} retry={refresh}><BusinessTable rows={(data?.orders as PortalRow[])??[]} columns={[{key:'order',title:'Bestellung',render:r=>text((r.orders as PortalRow)?.order_number)},{key:'customer',title:'Kunde',render:r=>text(((r.orders as PortalRow)?.customer_snapshot as PortalRow)?.name)}]} onOpen={r=>onSelect(String(r.order_id))}/></ReadState></section>;
}
