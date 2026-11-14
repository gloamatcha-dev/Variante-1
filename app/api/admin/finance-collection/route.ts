import {requireAdminIdentity} from '../../../../lib/adminActionRoute.ts';
import {canAccessProductManager} from '../../../../lib/productOwnerAccess';
import {getSupabaseAdmin} from '../../../../lib/supabaseAdmin';
import {collectionHttp} from '../../../../lib/financeCollectionServer.ts';
export const maxDuration=60;
async function handle(request:Request){
 return collectionHttp(request,{
  authorize:async req=>{
   const gate=await requireAdminIdentity(req,'read');
   if(!gate.ok)return {ok:false,status:gate.response.status};
   if(gate.identity.role!=='owner'||!await canAccessProductManager(gate.identity))return {ok:false,status:403};
   return {ok:true,ownerId:gate.identity.userId};
  },
  normalGatesDisabled:()=>!['FINANCE_RECONCILIATION_ENABLED','FINANCE_SCAN_MODES_ENABLED','FINANCE_SYNC_MANUAL_ENABLED'].some(n=>process.env[n]==='true')&&process.env.FINANCE_FIRST_SCAN_SCOPE===undefined,
  readKey:()=>process.env.STRIPE_RECONCILIATION_READ_KEY,
  rpc:async(name,args)=>{
   const admin=getSupabaseAdmin();if(!admin)throw Error('COLLECTION_DATABASE_UNAVAILABLE');
   const r=await admin.rpc(name,args).abortSignal(AbortSignal.timeout(10000));
   if(r.error)throw Error('COLLECTION_DATABASE_UNCONFIRMED');return r.data;
  },
 });
}
export const POST=handle;
export const GET=handle;
