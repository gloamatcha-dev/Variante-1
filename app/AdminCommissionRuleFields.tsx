"use client";
import {useState} from 'react';
import {commissionRuleSummary,commissionValueConfiguration} from '../lib/commissionRuleConfiguration.ts';

export function AdminCommissionRuleFields(){
 const [type,setType]=useState(''),[value,setValue]=useState('');
 let summary='',error='';
 if(value){try{const configuration=commissionValueConfiguration(type,value);summary=commissionRuleSummary({percent_basis_points:configuration.percentBasisPoints,fixed_cents:configuration.fixedCents});}catch(e){error=e instanceof Error?e.message:'Ungültiger Wert.';}}
 return <><label>Regelname<input name="label" required maxLength={120} placeholder="z. B. Anna – 12,5 %"/></label>
  <label>Berechnungsart<select name="calculationType" required value={type} onChange={e=>{setType(e.target.value);setValue('');}}><option value="">Bitte wählen</option><option value="percentage">Prozentual</option><option value="fixed">Fester Betrag pro bezahlter Bestellung</option></select></label>
  {type&&<label>{type==='percentage'?'Provision in %':'Provision pro bezahlter Bestellung (EUR)'}<input name="commissionValue" inputMode="decimal" required value={value} onChange={e=>setValue(e.target.value)} placeholder={type==='percentage'?'12,5':'5,00'} pattern="[0-9]+([,.][0-9]{1,2})?" aria-describedby="commission-rule-preview"/></label>}
  <label>Bemessungsgrundlage<select name="base" required defaultValue=""><option value="">Bitte wählen</option><option value="merchandise_net">Warenwert netto, ohne Versand</option><option value="merchandise_gross">Warenwert brutto, ohne Versand</option><option value="order_gross">Bestellung brutto inklusive Versand</option></select></label>
  <p id="commission-rule-preview" className="portal-note" role="status">{error||summary||'Berechnungsart und Provision wählen. Die tatsächliche Provision berechnet der Server.'}</p>
  {type==='fixed'&&<p className="portal-note">Der Festbetrag gilt pro qualifizierender bezahlter Bestellung. Die Bemessungsgrundlage bleibt als bestehendes Regelfeld gespeichert.</p>}
 </>;
}
