import {isBearerSecretAuthorized} from '../../../../lib/serverSecretAuth';
import {runFinanceSyncServer} from '../../../../lib/financeSyncServer';
export const maxDuration=60;
export async function GET(request:Request):Promise<Response> {
 const secret=process.env.CRON_SECRET;
 if(!secret)return Response.json({error:'Nicht verfügbar.'},{status:503});
 if(!isBearerSecretAuthorized(request,secret))return Response.json({error:'Nicht autorisiert.'},{status:401});
 if(process.env.FINANCE_RECONCILIATION_ENABLED!=='true')return Response.json({state:'disabled'});
 const firstScan=new URL(request.url).searchParams.get('first_scan');
 if(firstScan!==null&&firstScan!=='1')return Response.json({error:'Invalid first scan scope request'},{status:400});
 try {
  const result=await runFinanceSyncServer(firstScan==='1'?{firstScanOnly:true}:undefined);
  return Response.json(result,{status:result.state==='retry_required'?503:200});
 }catch{
  console.error('GLOA finance reconciliation failed; inspect durable sync status.');
  return Response.json({error:'Finanzabgleich fehlgeschlagen. Automatischer Wiederholungsversuch beim nächsten Lauf.'},{status:503});
 }
}
