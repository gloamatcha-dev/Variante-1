import {isBearerSecretAuthorized} from '../../../../lib/serverSecretAuth';
import {runFinanceScanMode} from '../../../../lib/financeScanModes.server';
export const maxDuration=60;
export async function GET(request:Request) {
 const secret=process.env.CRON_SECRET;if(!secret)return Response.json({error:'Unavailable'},{status:503});
 if(!isBearerSecretAuthorized(request,secret))return Response.json({error:'Unauthorized'},{status:401});
 if(process.env.FINANCE_RECONCILIATION_ENABLED!=='true'||process.env.FINANCE_SCAN_MODES_ENABLED!=='true')return Response.json({state:'disabled'});
 try{const result=await runFinanceScanMode('daily');return Response.json(result,{status:result.state==='retry_required'?503:200});}
 catch{return Response.json({error:'Daily verification unconfirmed'},{status:503});}
}
