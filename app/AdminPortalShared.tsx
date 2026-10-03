"use client";
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { date, label, money, text, type PortalRow } from '../lib/adminPortalModel.ts';

export async function portalRequest(endpoint:string,body:PortalRow,signal?:AbortSignal):Promise<PortalRow>{
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
  if(response.status===401){if(typeof window!=='undefined')window.dispatchEvent(new Event('gloa-admin-session-lost'));throw new Error('Sitzung abgelaufen. Bitte erneut anmelden.');}
  if(response.status===403)throw new Error('Für diesen Bereich fehlt die Berechtigung.');
  const data=await response.json();
  if(!response.ok || data.ok===false)throw new Error(typeof data.error==='string'?data.error:'Die Daten konnten nicht geladen werden.');
  return data;
}
export function usePortalRead(endpoint:string,body:PortalRow){
  const key=JSON.stringify(body);
  const [state,setState]=useState<{key:string;data:PortalRow|null;error:string}>({key:'',data:null,error:''});
  const [revision,setRevision]=useState(0);
  const refresh=useCallback(()=>setRevision(r=>r+1),[]);
  useEffect(()=>{
    const controller=new AbortController();
    portalRequest(endpoint,JSON.parse(key),controller.signal).then(data=>setState({key,data,error:''})).catch(error=>{
      if(!controller.signal.aborted)setState({key,data:null,error:error instanceof Error?error.message:'Laden fehlgeschlagen.'});
    });
    return()=>controller.abort();
  },[endpoint,key,revision]);
  return {...(state.key===key?state:{data:null,error:''}),refresh};
}
export function ReadState({data,error,retry,children}:{data:PortalRow|null;error:string;retry:()=>void;children:ReactNode}){
  if(error)return <div className="portal-state" role="alert"><h3>Daten nicht verfügbar</h3><p>{error}</p><button type="button" onClick={retry}>Erneut versuchen</button></div>;
  if(!data)return <div className="portal-state" role="status" aria-busy="true">Daten werden geladen …</div>;
  return <>{children}</>;
}
export function Chip({value}:{value:unknown}){return <span className={`portal-chip state-${typeof value==='string'?value:'unknown'}`}>{label(value)}</span>;}
export function Info({children}:{children:string}){return <button type="button" className="portal-info" aria-label={children} title={children}>ⓘ</button>;}
export function Tabs({items,value,onChange}:{items:readonly string[];value:string;onChange:(value:string)=>void}){
  return <nav className="portal-tabs" aria-label="Unterbereiche">{items.map(item=><button type="button" key={item} aria-current={value===item?'page':undefined} className={value===item?'is-active':''} onClick={()=>onChange(item)}>{item}</button>)}</nav>;
}
export function Period({value,onChange}:{value:PortalRow;onChange:(value:PortalRow)=>void}){
  return <div className="portal-period"><label>Zeitraum<select value={String(value.period)} onChange={e=>onChange({...value,period:e.target.value})}><option value="month">Aktueller Monat</option><option value="last_month">Letzter Monat</option><option value="year">Dieses Jahr</option><option value="custom">Eigener Zeitraum</option></select></label>{value.period==='custom' && <><label>Von<input type="date" value={String(value.from??'')} onChange={e=>onChange({...value,from:e.target.value})}/></label><label>Bis<input type="date" value={String(value.to??'')} onChange={e=>onChange({...value,to:e.target.value})}/></label></>}</div>;
}
export function MoneySummary({summary}:{summary:PortalRow|null}){
  if(!summary)return <p className="portal-state">Finanzübersicht unbekannt oder nicht zugänglich.</p>;
  return <><dl className="portal-metrics">{[['Einnahmen','incomeCents'],['Refunds','refundCents'],['Direkte Kosten, bekannt','directCostCents'],['Allgemeine Kosten','generalCostCents'],['Providergebühren, erfasst','providerFeeCents'],['Ergebnis','resultCents']].map(([name,key])=><div key={key}><dt>{name}{key==='resultCents'&&<Info>Ein Ergebnis wird nur bei nachweislich vollständigen Kosten angezeigt.</Info>}</dt><dd>{money(summary[key])}</dd></div>)}</dl><p className="portal-note">{text(summary.completeness)} Kundenseitig bezahlter Versand ist Einnahme, Carrier-Versand ist eine Ausgabe. Stripe-Auszahlungen sind keine Einnahmen.</p></>;
}
export type PortalColumn={key:string;title:string;render?:(row:PortalRow)=>ReactNode};
export function BusinessTable({rows,columns,onOpen,empty='Keine Einträge für diese Auswahl.'}:{rows:PortalRow[];columns:PortalColumn[];onOpen?:(row:PortalRow)=>void;empty?:string}){
  const [page,setPage]=useState(1);
  const last=Math.max(1,Math.ceil(rows.length/25)),current=Math.min(page,last);
  const visible=rows.slice((current-1)*25,current*25);
  if(!rows.length)return <p className="portal-state">{empty}</p>;
  return <div className="portal-table-wrap"><table className="portal-table"><thead><tr>{columns.map(c=><th key={c.key} scope="col" data-numeric={/cents|Cents|amount/.test(c.key)}>{c.title}</th>)}{onOpen&&<th scope="col" data-column="details">Details</th>}</tr></thead><tbody>{visible.map((row,index)=><tr key={text(row.id,String(index))}>{columns.map(c=><td key={c.key} data-label={c.title} data-numeric={/cents|Cents|amount/.test(c.key)}>{c.render?c.render(row):text(row[c.key])}</td>)}{onOpen&&<td data-label="Details"><button type="button" onClick={()=>onOpen(row)} aria-label={`Details zu ${text(row.display_name??row.title??row.order_number,'Eintrag')}`}>Öffnen</button></td>}</tr>)}</tbody></table>{last>1&&<div className="portal-pagination"><button type="button" disabled={current===1} onClick={()=>setPage(current-1)}>Zurück</button><span>{current} / {last}</span><button type="button" disabled={current===last} onClick={()=>setPage(current+1)}>Weiter</button></div>}</div>;
}
export function RecordDetails({row,onClose,title,children}:{row:PortalRow|null;onClose:()=>void;title:string;children?:ReactNode}){
  useEffect(()=>{if(!row)return;const listener=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose();};document.addEventListener('keydown',listener);return()=>document.removeEventListener('keydown',listener);},[row,onClose]);
  if(!row)return null;
  const technical=Object.entries(row).filter(([key])=>key==='id'||key.endsWith('_id')||key==='operation_id'||key.startsWith('stripe_'));
  return <section className="portal-detail" aria-label={title} tabIndex={-1}><div className="portal-detail-head"><h2>{title}</h2><button type="button" onClick={onClose}>Schließen</button></div>{children}<details><summary>Weitere Details</summary><dl className="portal-facts">{technical.map(([key,value])=><div key={key}><dt>{key}</dt><dd>{text(value)}</dd></div>)}</dl></details></section>;
}
export function BusinessContext({entity,id}:{entity:string;id:string}){
  const {data,error,refresh}=usePortalRead('/api/admin/portal',{action:'context',entity,id});
  return <ReadState data={data} error={error} retry={refresh}><h3>Zahlungen und Erstattungen</h3><BusinessTable rows={(data?.events??[]) as PortalRow[]} columns={[{key:'occurred_on',title:'Datum',render:r=>date(r.occurred_on)},{key:'kind',title:'Art',render:r=><Chip value={r.kind}/>},{key:'gross_cents',title:'Betrag',render:r=>money(r.gross_cents)}]}/><h3>Dokumente</h3><BusinessTable rows={(data?.documents??[]) as PortalRow[]} columns={[{key:'document',title:'Dokument',render:r=>text((r.documents as PortalRow)?.title)},{key:'kind',title:'Art',render:r=>label((r.documents as PortalRow)?.kind)}]}/><h3>Creator-Zuordnung</h3><BusinessTable rows={(data?.attributions??[]) as PortalRow[]} columns={[{key:'creator',title:'Creator',render:r=>text((r.creators as PortalRow)?.display_name)},{key:'attributed_at',title:'Zugeordnet am',render:r=>date(r.attributed_at)}]}/><h3>Aktivität</h3><BusinessTable rows={(data?.activity??[]) as PortalRow[]} columns={[{key:'created_at',title:'Zeit',render:r=>date(r.created_at,true)},{key:'summary',title:'Vorgang'}]}/><p className="portal-note">Kontext: bis zu 100 Finanzereignisse und Dokumente, 50 Aktivitäten. Vollständige Historie im jeweiligen Bereich.</p></ReadState>;
}
