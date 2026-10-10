"use client";
import {useState} from 'react';
import {portalRequest,usePortalRead} from './AdminPortalShared';
import {date,money,type PortalRow} from '../lib/adminPortalModel.ts';
import {BASE_COST_CLASSES,COST_LABELS} from '../lib/directCostCoverage.ts';
const STATES:Record<string,string>={captured:'ERFASST',confirmed_zero:'0 € BESTÄTIGT',not_applicable:'NICHT ANWENDBAR',confirmed_complete:'VOLLSTÄNDIG BESTÄTIGT',open:'OFFEN'};
export function AdminCostCoverage({period,onChanged}:{period:PortalRow;onChanged?:()=>void}){
  const {data,error,refresh}=usePortalRead('/api/admin/cost-coverage',{action:'list',...period});
  const [notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  async function submit(event:React.FormEvent<HTMLFormElement>,args:PortalRow){
    event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));
    if(!window.confirm('Kostenabdeckung ausdrücklich bestätigen? Die Begründung und Zuordnung werden protokolliert.'))return;
    setBusy(true);setNotice('');
    try{await portalRequest('/api/admin/cost-coverage',{...args,...values,expenseId:values.status==='captured'?values.expenseId:null,operationId:crypto.randomUUID()});refresh();onChanged?.();}
    catch(e){setNotice(e instanceof Error?e.message:'Bestätigung fehlgeschlagen.');}finally{setBusy(false);}
  }
  const coverage=(data?.coverage??[]) as PortalRow[],expenses=(data?.coverageExpenses??data?.expenses??[]) as PortalRow[];
  return <section><h3>KOSTENABDECKUNG</h3><p>Positive Kosten werden unter Ausgaben erfasst. Fehlende Bestätigungen bleiben offen. Lieferungen werden anhand des Versanddatums oder tatsächlich erfasster Kosten angezeigt.</p>{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {((data?.subjects??[]) as PortalRow[]).map(subject=><article key={String(subject.id)}><h4>{String(subject.reference)}</h4>{BASE_COST_CLASSES.map(costClass=>{
      const row=coverage.find(c=>c.cost_class===costClass&&(subject.kind==='order'?c.order_id===subject.id:c.b2b_delivery_id===subject.id));
      const linked=expenses.find(e=>e.id===row?.business_expense_id);
      const candidates=expenses.filter(e=>e.category===costClass&&(subject.kind==='order'?e.order_id===subject.id:e.b2b_delivery_id===subject.id||(subject.order_id&&e.order_id===subject.order_id)));
      return <form className="portal-form" key={costClass} onSubmit={e=>void submit(e,{action:'set_direct',subjectKind:subject.kind,subjectId:subject.id,costClass})}>
        <strong>{COST_LABELS[costClass]}: {STATES[String(row?.coverage_status??'open')]}</strong>{linked&&<span>{money(linked.gross_cents)} · {String(linked.description)}</span>}
        <label>Bestätigung<select name="status" defaultValue="open"><option value="open">OFFEN / WIEDER ÖFFNEN</option><option value="captured">ERFASST</option><option value="confirmed_zero">0 € BESTÄTIGT</option><option value="not_applicable">NICHT ANWENDBAR</option></select></label>
        <label>Vorhandene Ausgabe<select name="expenseId"><option value="">Keine Ausgabe</option>{candidates.map(e=><option key={String(e.id)} value={String(e.id)}>{String(e.description)} · {money(e.gross_cents)}</option>)}</select></label>
        <label>Begründung<input name="reason" required maxLength={500}/></label><button type="submit" disabled={busy}>BESTÄTIGEN</button>
      </form>;
    })}{subject.kind==='b2b_delivery'&&<B2bCostForm deliveryId={String(subject.id)} onChanged={()=>{refresh();onChanged?.();}}/>}</article>)}
    {((data?.months??[]) as string[]).map(month=>{const row=((data?.generalCoverage??[]) as PortalRow[]).find(r=>r.period_start===month);return <form key={month} className="portal-form" onSubmit={e=>void submit(e,{action:'set_month',month})}><h4>ALLGEMEINE KOSTEN FÜR {new Intl.DateTimeFormat('de-DE',{month:'long',year:'numeric'}).format(new Date(month+'T12:00:00Z')).toUpperCase()}</h4><p>{STATES[String(row?.coverage_status??'open')]}{row?.confirmed_at?' · '+date(row.confirmed_at,true):''}</p><label>Bestätigung<select name="status"><option value="open">OFFEN / WIEDER ÖFFNEN</option><option value="confirmed_complete">VOLLSTÄNDIG BESTÄTIGT</option><option value="confirmed_zero">0 € BESTÄTIGT</option></select></label><label>Begründung<input name="reason" required maxLength={500}/></label><button type="submit" disabled={busy}>MONAT BESTÄTIGEN</button></form>;})}
  </section>;
}
function B2bCostForm({deliveryId,onChanged}:{deliveryId:string;onChanged:()=>void}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function save(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));setBusy(true);setError('');
    try{await portalRequest('/api/admin/cost-coverage',{...values,action:'create_b2b_expense',deliveryId,grossCents:Number(values.grossCents),vatCents:values.vatCents===''?null:Number(values.vatCents),operationId:crypto.randomUUID(),reason:'Dokumentierte B2B-Lieferkosten'});onChanged();}catch(e){setError(e instanceof Error?e.message:'Erfassung fehlgeschlagen.');}finally{setBusy(false);}
  }
  return <details><summary>B2B-Lieferausgabe erfassen</summary><form className="portal-form" onSubmit={e=>void save(e)}><label>Kostenklasse<select name="category">{[...BASE_COST_CLASSES,'other_direct'].map(c=><option key={c} value={c}>{COST_LABELS[c]??'Sonstige direkte Kosten'}</option>)}</select></label><label>Kostendatum<input type="date" name="occurredOn" required/></label><label>Beschreibung<input name="description" required maxLength={300}/></label><label>Brutto in Cent<input type="number" name="grossCents" min={1} step={1} required/></label><label>Belegte Vorsteuer in Cent (leer = unbekannt)<input type="number" name="vatCents" min={0} step={1}/></label><label>Lieferant<input name="vendor" maxLength={160}/></label><label>Belegreferenz / Notiz<textarea name="note" maxLength={2000}/></label>{error&&<p role="alert">{error}</p>}<button disabled={busy} type="submit">AUSGABE ERFASSEN</button></form></details>;
}
