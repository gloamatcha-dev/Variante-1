import {requireAdminIdentity} from '../../../../lib/adminActionRoute.ts';
import {canAccessProductManager} from '../../../../lib/productOwnerAccess';
import {getSupabaseAdmin} from '../../../../lib/supabaseAdmin';
import {runFinanceSyncServer} from '../../../../lib/financeSyncServer';
import {globalFinanceSyncStatus} from '../../../../lib/globalFinanceSync.ts';
export const maxDuration=60;
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function POST(request:Request) {
 const gate=await requireAdminIdentity(request,'read');if(!gate.ok)return gate.response;
 let payload:Record<string,unknown>,action:unknown;try{payload=await request.json();action=payload?.action;}catch{return json({error:'Ungültige Anfrage.'},400);}
 if(action!=='status'&&action!=='run'&&action!=='preflight'&&action!=='test_alert')return json({error:'Unbekannte Aktion.'},400);
 if(action!=='status'&&request.headers.get('origin')!==new URL(request.url).origin)return json({error:'Ungültiger Anfrageursprung.'},403);
 // Fresh active owner row + confirmed, unbanned Auth identity, never browser role claims.
 const owner=gate.identity.role==='owner'&&await canAccessProductManager(gate.identity);
 if(action!=='status'&&!owner)return json({error:'Nur der verifizierte Owner darf synchronisieren oder die Verbindung prüfen.'},403);
 const enabled=process.env.FINANCE_RECONCILIATION_ENABLED==='true';
 const manualEnabled=enabled&&process.env.FINANCE_SYNC_MANUAL_ENABLED==='true';
 if(action==='run'&&!manualEnabled)return json({error:'Synchronisierung ist bis zur Datenbankfreigabe deaktiviert.'},409);
 if(action==='test_alert'&&(enabled||process.env.FINANCE_SYNC_MANUAL_ENABLED==='true'))return json({error:'Für den Mailtest muss der Finanzabgleich deaktiviert bleiben.'},409);
 if(action==='test_alert'&&(payload.confirm!=='SEND_ONE_FINANCE_ALERT_TEST'||typeof payload.probeId!=='string'))return json({error:'Explizite Mailtest-Bestätigung und Test-ID erforderlich.'},400);
 const admin=getSupabaseAdmin();if(!admin)return json({error:'Syncstatus nicht verfügbar.'},503);
 try {
  if(action==='preflight'||action==='test_alert'){
   const config=await admin.from('finance_sync_config').select('account_id,owner_id,known_payment_intent,known_amount_cents,enabled,auto_open_current_period').maybeSingle();
   if(config.error)throw Error('configuration_unavailable');
   if(!config.data||config.data.owner_id!==gate.identity.userId)return json({error:'Keine bestätigte Owner-Konfiguration.'},403);
   if(action==='preflight'){
    const {financeSyncPreflight}=await import('../../../../lib/financeSyncPreflight.ts');
    return json({ok:true,preflight:await financeSyncPreflight(config.data)});
   }
   const {financeAlertDeliveryProbe}=await import('../../../../lib/financeAlertDeliveryProbe.ts');
   const alertTest=await financeAlertDeliveryProbe({ownerEmail:gate.identity.email,databaseEnabled:config.data.enabled,probeId:payload.probeId as string});
   return json({ok:alertTest.state==='accepted',alertTest},alertTest.state==='accepted'?200:alertTest.state==='blocked'?409:503);
  }
  const result=await admin.rpc('finance_sync_global_status_v1');
  if(result.error||!result.data||result.data.monitoring_version!==1)return json({error:'Syncstatus nicht verfügbar. Datenbankfreigabe und Monitoring prüfen.'},503);
  let configuredOwner=false;
  if(owner){const config=await admin.from('finance_sync_config').select('owner_id').eq('enabled',true).maybeSingle();
   if(config.error)throw Error('configuration_unavailable');configuredOwner=config.data?.owner_id===gate.identity.userId;}
  if(action==='run'){
   if(!configuredOwner)return json({error:'Keine Owner-Freigabe für diesen Stripe-Abgleich.'},403);
   // Same lease, fencing token, durable checkpoint and idempotent writers as cron.
   const run=await runFinanceSyncServer({invocation:'manual'});
   // ok confirms request handling, never scan completion or reconciliation.
   const scanCompleted='caughtUp' in run&&run.caughtUp===true&&['verified','attention'].includes(run.state);
   return json({ok:true,run,scanCompleted,reconciliationVerified:scanCompleted&&run.state==='verified'&&'reconciliationVerified' in run&&run.reconciliationVerified===true},run.state==='retry_required'?503:200);
  }
  return json({ok:true,status:globalFinanceSyncStatus(result.data,enabled),canSync:owner&&configuredOwner&&manualEnabled});
 }catch{return json({error:'Stripe-Abgleich nicht bestätigt. Letzten Status und Wiederholungsversuch prüfen.'},503);}
}
