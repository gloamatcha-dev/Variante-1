import {requireAdminIdentity} from '../../../../lib/adminActionRoute.ts';
import {canAccessProductManager} from '../../../../lib/productOwnerAccess';
import {getSupabaseAdmin} from '../../../../lib/supabaseAdmin';
import {historicalAuditHttp} from '../../../../lib/historicalAuditServer.ts';
export const maxDuration=60;
async function handle(request:Request){return historicalAuditHttp(request,{
 authorize:async req=>{const gate=await requireAdminIdentity(req,'read');if(!gate.ok||gate.identity.role!=='owner'||!await canAccessProductManager(gate.identity))return {ok:false};return {ok:true,ownerId:gate.identity.userId};},
 normalGatesDisabled:()=>!['FINANCE_RECONCILIATION_ENABLED','FINANCE_SCAN_MODES_ENABLED','FINANCE_SYNC_MANUAL_ENABLED'].some(n=>process.env[n]==='true')&&process.env.FINANCE_FIRST_SCAN_SCOPE===undefined,
 readKey:()=>process.env.STRIPE_RECONCILIATION_READ_KEY,
 rpc:async args=>{const admin=getSupabaseAdmin();if(!admin)throw Error('AUDIT_DATABASE_UNAVAILABLE');const r=await admin.rpc('finance_historical_audit_v1',args).abortSignal(AbortSignal.timeout(10000));if(r.error)throw Error('AUDIT_DATABASE_UNCONFIRMED');return r.data;},
});}
export const GET=handle;export const POST=handle;
