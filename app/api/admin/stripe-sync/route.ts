import {requireAdminIdentity} from '../../../../lib/adminActionRoute.ts';
import {canAccessProductManager} from '../../../../lib/productOwnerAccess';
import {getSupabaseAdmin} from '../../../../lib/supabaseAdmin';
import {runFinanceSyncServer} from '../../../../lib/financeSyncServer';
import {globalFinanceSyncStatus} from '../../../../lib/globalFinanceSync.ts';
export const maxDuration=60;
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function POST(request:Request) {
 const gate=await requireAdminIdentity(request,'read');if(!gate.ok)return gate.response;
 let action:unknown;try{action=(await request.json()).action;}catch{return json({error:'Ungültige Anfrage.'},400);}
 if(action!=='status'&&action!=='run')return json({error:'Unbekannte Aktion.'},400);
 if(action==='run'&&request.headers.get('origin')!==new URL(request.url).origin)return json({error:'Ungültiger Anfrageursprung.'},403);
 // Fresh active owner row + confirmed, unbanned Auth identity, never browser role claims.
 const owner=gate.identity.role==='owner'&&await canAccessProductManager(gate.identity);
 if(action==='run'&&!owner)return json({error:'Nur der verifizierte Owner darf synchronisieren.'},403);
 const enabled=process.env.FINANCE_RECONCILIATION_ENABLED==='true';
 const manualEnabled=enabled&&process.env.FINANCE_SYNC_MANUAL_ENABLED==='true';
 if(action==='run'&&!manualEnabled)return json({error:'Synchronisierung ist bis zur Datenbankfreigabe deaktiviert.'},409);
 const admin=getSupabaseAdmin();if(!admin)return json({error:'Syncstatus nicht verfügbar.'},503);
 try {
  const result=await admin.rpc('finance_sync_global_status_v1');
  if(result.error||!result.data||result.data.monitoring_version!==1)return json({error:'Syncstatus nicht verfügbar. Datenbankfreigabe und Monitoring prüfen.'},503);
  let configuredOwner=false;
  if(owner){const config=await admin.from('finance_sync_config').select('owner_id').eq('enabled',true).maybeSingle();
   if(config.error)throw Error('configuration_unavailable');configuredOwner=config.data?.owner_id===gate.identity.userId;}
  if(action==='run'){
   if(!configuredOwner)return json({error:'Keine Owner-Freigabe für diesen Stripe-Abgleich.'},403);
   // Same lease, fencing token, durable checkpoint and idempotent writers as cron.
   const run=await runFinanceSyncServer();
   return json({ok:true,run},run.state==='retry_required'?503:200);
  }
  return json({ok:true,status:globalFinanceSyncStatus(result.data,enabled),canSync:owner&&configuredOwner&&manualEnabled});
 }catch{return json({error:'Stripe-Abgleich nicht bestätigt. Letzten Status und Wiederholungsversuch prüfen.'},503);}
}
