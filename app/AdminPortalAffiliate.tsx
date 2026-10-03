"use client";
import {useState} from 'react';
import {commissionRuleSummary,commissionRuleInputValue} from '../lib/commissionRuleConfiguration.ts';
import {date,money,text,type PortalRow} from '../lib/adminPortalModel.ts';
import {BusinessTable,Chip,portalRequest,ReadState,RecordDetails} from './AdminPortalShared';

const rows=(data:PortalRow|null,key:string):PortalRow[]=>Array.isArray(data?.[key])?data[key] as PortalRow[]:[];
export const affiliateUrl=(slug:unknown)=>`https://gloamatcha.com/r/${text(slug,'')}`;
export const suggestedAffiliateSlug=(name:string)=>name.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,50).replace(/-$/,'');

export function AdminPortalAffiliate({data,error,refresh,onCreator,onRule,initialFocus=''}:{data:PortalRow|null;error:string;refresh:()=>void;onCreator:()=>void;onRule?:()=>void;initialFocus?:string}){
 const [editing,setEditing]=useState<PortalRow|null>(null),[creating,setCreating]=useState(false),[type,setType]=useState('link'),[creatorId,setCreatorId]=useState(''),[slug,setSlug]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const [commissionMode,setCommissionMode]=useState('inline'),[calculationType,setCalculationType]=useState('percentage'),[commissionValue,setCommissionValue]=useState('');
 const creators=rows(data,'creators'),rules=rows(data,'rules');
 const relationships=[...rows(data,'links').map(r=>({...r,type:'link'})),...rows(data,'codes').map(r=>({...r,type:'code'}))] as PortalRow[];
 const name=(id:unknown)=>text(creators.find(c=>c.id===id)?.display_name);
 const attributed=(r:PortalRow)=>rows(data,'attributions').filter(a=>a[r.type==='link'?'affiliate_link_id':'affiliate_code_id']===r.id);
 const events=(r:PortalRow,kind:string)=>rows(data,'commissions').filter(c=>c.kind===kind&&attributed(r).some(a=>a.order_id===c.order_id));
 async function save(body:PortalRow){
  setBusy(true);setNotice('');
  try{await portalRequest('/api/admin/creators',body);setCreating(false);setEditing(null);setNotice('Affiliate-Beziehung gespeichert.');refresh();}
  catch(e){setNotice(e instanceof Error?e.message:'Speichern fehlgeschlagen.');}finally{setBusy(false);}
 }
 function open(row:PortalRow|null){setEditing(row);setCreating(!row);setType(String(row?.type??'link'));setCreatorId(String(row?.creator_id??''));setSlug(String(row?.slug??row?.code??''));setNotice('');setCommissionMode('inline');const rule=rules.find(r=>r.id===row?.commission_rule_id);setCalculationType(rule?.fixed_cents!=null?'fixed':'percentage');setCommissionValue(commissionRuleInputValue(rule));}
 async function copy(row:PortalRow){try{await navigator.clipboard.writeText(affiliateUrl(row.slug));setNotice('Link kopiert.');}catch{setNotice('Kopieren nicht verfügbar. Den angezeigten Link bitte manuell kopieren.');}}
 function submit(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));
  for(const key of ['startsAt','endsAt'])if(values[key])values[key]=new Date(String(values[key])).toISOString();
  void save({...values,commissionMode,calculationType,commissionValue,creatorId,type,id:editing?.id,action:editing?'edit_affiliate':type==='link'?'create_affiliate_link':'create_affiliate_code'});
 }
 const fields=<><label>Creator<select name="creatorId" required value={creatorId} disabled={!!editing} onChange={e=>{setCreatorId(e.target.value);if(!editing)setSlug(suggestedAffiliateSlug(text(creators.find(c=>c.id===e.target.value)?.display_name,'')));}}><option value="">Bitte wählen</option>{creators.map(c=><option key={String(c.id)} value={String(c.id)}>{text(c.display_name)}</option>)}</select></label>
  {!editing&&<label>Beziehung<select value={type} onChange={e=>{setType(e.target.value);setSlug('');}}><option value="link">Öffentlicher Link</option><option value="code">Persönlicher Code</option></select></label>}
  <label>{type==='link'?'Link-Slug':'Persönlicher Code'}<input name={type==='link'?'slug':'code'} value={slug} onChange={e=>setSlug(e.target.value)} required pattern={type==='link'?'[a-z0-9][a-z0-9-]{1,48}[a-z0-9]':'[A-Za-z0-9][A-Za-z0-9_-]{1,38}[A-Za-z0-9]'} minLength={3} maxLength={type==='link'?50:40}/></label>
  {type==='link'&&<p className="portal-note">{affiliateUrl(slug)}</p>}
  <label>Provisionskonfiguration<select value={commissionMode} onChange={e=>setCommissionMode(e.target.value)}><option value="inline">Individuell festlegen</option><option value="existing">Bestehende Regel verwenden</option></select></label>
  {commissionMode==='existing'?<label>Provisionsregel<select name="commissionRuleId" defaultValue={String(editing?.commission_rule_id??'')}><option value="">Keine Provisionsregel</option>{rules.map(r=><option key={String(r.id)} value={String(r.id)}>{text(r.label)} · {commissionRuleSummary(r)}</option>)}</select></label>:<>
   <label>Berechnungsart<select value={calculationType} onChange={e=>{setCalculationType(e.target.value);setCommissionValue('');}}><option value="percentage">Prozentual</option><option value="fixed">Fester Betrag pro bezahlter Bestellung</option></select></label>
   <label>{calculationType==='percentage'?'Provision in %':'Provision pro bezahlter Bestellung'}<input required inputMode="decimal" value={commissionValue} onChange={e=>setCommissionValue(e.target.value)} pattern="[0-9]+([,.][0-9]{1,2})?" placeholder={calculationType==='percentage'?'12,5':'5,00'}/><span>{calculationType==='percentage'?'%':'€'}</span></label>
   <label>Bemessungsgrundlage<select name="base" required defaultValue={String(rules.find(r=>r.id===editing?.commission_rule_id)?.base??'')}><option value="">Bitte wählen</option><option value="merchandise_net">Warenwert netto, ohne Versand</option><option value="merchandise_gross">Warenwert brutto, ohne Versand</option><option value="order_gross">Bestellung brutto inklusive Versand</option></select></label>
   <label>Regelname (optional)<input name="ruleName" maxLength={120} defaultValue={text(rules.find(r=>r.id===editing?.commission_rule_id)?.label,'')} placeholder="Wird aus Creator und Provision erstellt"/></label>
  </>}
  <label>Beginn<input name="startsAt" type="datetime-local" defaultValue={localDate(editing?.starts_at)}/></label><label>Ende<input name="endsAt" type="datetime-local" defaultValue={localDate(editing?.ends_at)}/></label>
  <label>Status<select name="status" defaultValue={editing?.active===false?'paused':'active'}><option value="active">Aktiv</option><option value="paused">Pausiert</option></select></label>
  <p className="portal-note">Eine neue Regel gilt für künftige Zuordnungen. Bestehende Provisionsbuchungen bleiben unverändert. Persönliche Codes sind separate Beziehungen zum selben Creator und kein automatisch erzeugter Rabatt.</p></>;
 const form=<form className="portal-form" onSubmit={submit}><h3>{editing?'Affiliate bearbeiten':'Affiliate anlegen'}</h3>{fields}<div className="portal-actions"><button type="submit" disabled={busy||!creatorId}>Speichern</button><button type="button" disabled={busy} onClick={()=>{setCreating(false);setEditing(null);}}>Abbrechen</button></div></form>;
 return <><div className="portal-section-head"><h2>Affiliate-Beziehungen</h2><div className="portal-actions"><button type="button" onClick={refresh}>Aktualisieren</button><button type="button" disabled={!data||!creators.length||busy} onClick={()=>open(null)}>AFFILIATE ANLEGEN</button><button type="button" disabled={!data||!creators.length||busy} onClick={()=>{open(null);setType('code');}}>Persönlichen Code anlegen</button>{onRule&&<button type="button" onClick={onRule}>Regel erfassen</button>}</div></div>{notice&&<p role="status">{notice}</p>}<ReadState data={data} error={error} retry={refresh}>
  <p className="portal-note">Aktiv bezeichnet die Konfiguration. Beginn, Ende und Creator-Status bestimmen zusätzlich, ob eine Zuordnung zulässig ist. Beträge zeigen einzelne gespeicherte Buchungen, keine neu berechnete Provision.</p>
  {!relationships.length&&<p className="portal-state">Noch keine Affiliate-Beziehungen</p>}{!creators.length&&<p>Lege zuerst einen Creator an. <button type="button" onClick={onCreator}>Creator anlegen</button></p>}
  {!!relationships.length&&<BusinessTable rows={/^[0-9a-f-]{36}$/i.test(initialFocus)?relationships.filter(r=>r.id===initialFocus):relationships} onOpen={open} columns={[
   {key:'creator_id',title:'Creator',render:r=>name(r.creator_id)},
   {key:'slug',title:'Link / Slug',render:r=>r.type==='link'?text(r.slug):'Kein Link'},
   {key:'url',title:'Public URL',render:r=>r.type==='link'?<span>{affiliateUrl(r.slug)} <button type="button" onClick={()=>void copy(r)}>Link kopieren</button></span>:'Nicht erfasst'},
   {key:'code',title:'Persönlicher Code',render:r=>r.type==='code'?text(r.code):'Separate Code-Beziehung'},
   {key:'active',title:'Status',render:r=><Chip value={r.active?'active':'paused'}/>},
   {key:'starts_at',title:'Start',render:r=>date(r.starts_at)},{key:'ends_at',title:'Ende',render:r=>date(r.ends_at)},
   {key:'rule',title:'Provisionsregel',render:r=>{const rule=rules.find(rule=>rule.id===r.commission_rule_id);return rule?<span>{text(rule.label)}<br/>{commissionRuleSummary(rule)}</span>:'Keine Regel';}},
   {key:'orders',title:'Zugeordnete Bestellungen',render:r=>String(attributed(r).length)},
   {key:'earned',title:'Verdiente Buchungen',render:r=>events(r,'earned').map(c=>money(c.amount_cents)).join(', ')||'Keine Buchungen'},
   {key:'reversal',title:'Korrekturbuchungen',render:r=>events(r,'reversal').map(c=>money(c.amount_cents)).join(', ')||'Keine Buchungen'},
   {key:'actions',title:'Aktionen',render:r=><button type="button" disabled={busy} onClick={()=>void save({action:'update_affiliate',id:r.id,type:r.type,status:r.active?'paused':'active'})}>{r.active?'Pausieren':'Aktivieren'}</button>}
  ]}/>}</ReadState>{creating&&form}<RecordDetails row={editing} title="Affiliate-Beziehung" onClose={()=>setEditing(null)}>{form}{editing&&<><h3>Gespeicherte Provisionshistorie</h3><BusinessTable rows={[...events(editing,'earned'),...events(editing,'reversal')]} columns={[{key:'kind',title:'Buchung',render:r=><Chip value={r.kind}/>},{key:'amount_cents',title:'Provision',render:r=>money(r.amount_cents)},{key:'payout_state',title:'Status',render:r=><Chip value={r.payout_state}/>}]}/></>}</RecordDetails></>;
}
function localDate(value:unknown){if(typeof value!=='string')return '';const d=new Date(value);if(!Number.isFinite(d.getTime()))return '';return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
