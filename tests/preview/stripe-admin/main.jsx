import React from 'react';
import {createRoot} from 'react-dom/client';
import {previewModes,previewResponse} from '../../helpers/stripeAdminPreview.mjs';
import {AdminOverview} from '../../../app/AdminOverview.tsx';
const query=new URLSearchParams(location.search);
let mode=query.get('state')??'disabled';
// All component fetches terminate here; no native fetch fallback exists.
window.fetch=async(input,init={})=>{
 const url=new URL(typeof input==='string'?input:input.url,location.href);
 if(url.origin!==location.origin||!url.pathname.startsWith('/api/admin/'))return Response.json({error:'External access blocked in preview'},{status:403});
 let body={};try{body=JSON.parse(init.body??'{}');}catch{/* no transport */}
 const result=previewResponse(url.pathname,body,mode);
 return Response.json(result.data,{status:result.status});
};
function Controls(){return <section style={{padding:12,borderBottom:'2px solid #A61E59',font:'14px Arial',background:'#fff4d6'}}>
 <strong>LOKALE VORSCHAU · synthetische Daten · keine Stripe-/Production-Verbindung</strong>
 <label style={{marginLeft:16}}>Sync-Szenario <select defaultValue={mode} onChange={e=>{mode=e.target.value;window.dispatchEvent(new Event('focus'));}}>{previewModes.map(s=><option key={s}>{s}</option>)}</select></label>
 <p>Alle Navigationsbereiche verwenden die echten Admin-Komponenten. Geschäftsdaten sind synthetisch/leer; Schreibaktionen sind gesperrt. Der Sync-Button simuliert ausschließlich eine Fehlermeldung.</p>
 <p>Desktop-Admin ab 1024 px.</p>
 </section>;}
createRoot(document.getElementById('preview-controls')).render(<Controls/>);
createRoot(document.getElementById('root')).render(<AdminOverview/>);
