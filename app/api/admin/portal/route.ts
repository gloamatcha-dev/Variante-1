import { canAccessProductManager } from '../../../../lib/productOwnerAccess';
import { requireAdminIdentity } from '../../../../lib/adminActionRoute.ts';
import { getSupabaseAdmin } from '../../../../lib/supabaseAdmin';
import { canWrite } from '../../../../lib/adminRoles';
import { uuid, type PortalRow } from '../../../../lib/adminPortalModel.ts';
import {readPortalPages} from '../../../../lib/adminPortalRead.ts';
import {stockStatus} from '../../../../lib/inventoryRules.ts';

/** Cross-entity reads only. No provider calls and no mutation path. */
export async function POST(request:Request):Promise<Response>{
  const gate=await requireAdminIdentity(request, "read");
  if(!gate.ok)return gate.response;
  let body:Record<string,unknown>;
  try{body=await request.json();if(!body||typeof body!=='object')throw new Error();}catch{return Response.json({error:'Ungültige Anfrage.'},{status:400});}
  if(body.action==='identity')return Response.json({ok:true,identity:{...gate.identity,canManageProducts:await canAccessProductManager(gate.identity)},signedInAs:gate.session.email},{headers:{'Cache-Control':'no-store'}});
  const admin=getSupabaseAdmin();if(!admin)return Response.json({error:'Nicht verfügbar.'},{status:503});
  try{
    if(body.action==='inventory_warnings'){
      const items=await readPortalPages(admin,'inventory_items',q=>q.eq('is_active',true));
      return Response.json({ok:true,items:items.filter(r=>stockStatus(r)!=='ok').map(r=>({...r,stockState:stockStatus(r)}))});
    }
    if (body.action === 'customer_context') {
      if (!canWrite(gate.identity.role)) return Response.json({error:'Keine Berechtigung.'},{status:403});
      const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
      const sources = ['orders','subscriptions','annual_plans','b2b_supply_agreements'] as const;
      const kind = sources.find(source => source === body.kind) ?? 'orders';
      if (kind === 'orders' ? !/^[a-z0-9-]{1,80}$/i.test(reference) : !uuid(reference)) {
        return Response.json({error:'Geschäftsreferenz prüfen.'},{status:400});
      }
      const anchor = await admin.from(kind).select('id,status,user_id')
        .eq(kind === 'orders' ? 'order_number' : 'id', reference).limit(2);
      if (anchor.error) throw new Error('Customer anchor unavailable');
      const [order] = anchor.data ?? [];
      const headers = {'Cache-Control':'no-store'};
      if (!order || anchor.data?.length !== 1) {
        return Response.json({ok:true,state:'unresolved',groups:[]},{headers});
      }
      const anchorRow = {id:order.id, reference, status:order.status};
      if (!order.user_id) return Response.json({ok:true,state:'guest',groups:[
        {kind,rows:[anchorRow],truncated:false},
      ]},{headers});
      const groups = await Promise.all(sources.map(async kind => {
        const result = await admin.from(kind).select(kind==='orders'?'id,status,order_number':'id,status')
          .eq('user_id',order.user_id).order('id').limit(51);
        if (result.error) return {kind,rows:null,truncated:false};
        const rows = (result.data ?? []) as unknown as PortalRow[];
        return {kind,truncated:rows.length>50,rows:rows.slice(0,50).map(row=>({
          id:row.id,status:row.status,reference:row.order_number??row.id,
        }))};
      }));
      return Response.json({ok:true,state:'linked',groups},{headers});
    }
    if(body.action==='search'){
      const term=String(body.search??'').slice(0,100).replace(/[(),.*%_\\]/g,' ').trim();
      if(term.length<2)return Response.json({ok:true,results:[]});
      const sources=[
        {table:'orders',fields:['order_number','customer_snapshot->>email','customer_snapshot->>name'],columns:'id,order_number,customer_snapshot,status',area:'sales',tab:'BESTELLUNGEN'},
        ...(canWrite(gate.identity.role)?[
          {table:'subscriptions',fields:['customer_snapshot->>email','customer_snapshot->>name'],columns:'id,customer_snapshot,status',area:'sales',tab:'ABOS'},
          {table:'annual_plans',fields:['customer_snapshot->>email','customer_snapshot->>name'],columns:'id,customer_snapshot,status',area:'sales',tab:'JAHRESPLÄNE'},
          {table:'b2b_supply_agreements',fields:['business_snapshot->>email','business_snapshot->>company_name','business_snapshot->>companyName'],columns:'id,business_snapshot,status',area:'b2b',tab:''},
          {table:'termination_requests',fields:['customer_name','contact_email','contract_reference'],columns:'id,customer_name,contact_email,contract_reference,case_state',area:'rights',tab:'kuendigung'},
          {table:'withdrawal_requests',fields:['customer_name','contact_email','order_reference'],columns:'id,customer_name,contact_email,order_reference,case_state',area:'rights',tab:'widerruf'},
          {table:'complaint_requests',fields:['customer_name','contact_email','order_reference'],columns:'id,customer_name,contact_email,order_reference,case_state',area:'rights',tab:'reklamation'},
          {table:'business_expenses',fields:['description','vendor'],columns:'id,description,vendor,payment_status',area:'finance',tab:'AUSGABEN'},
        ]:[]),
        {table:'creators',fields:['display_name','email'],columns:'id,display_name,email,status',area:'creator',tab:'CREATOR'},
        {table:'affiliate_codes',fields:['code'],columns:'id,code,creator_id,active',area:'creator',tab:'AFFILIATE'},
      ];
      const responses=await Promise.all(sources.map(async source=>{
        const {data,error}=await admin.from(source.table).select(source.columns)
          .or(source.fields.map(field=>`${field}.ilike.%${term}%`).join(',')).limit(12);
        if(error)throw new Error(`Search ${source.table} failed`);
        return ((data??[]) as unknown as PortalRow[]).map(row=>({...row,entity:source.table,area:source.area,tab:source.tab}));
      }));
      return Response.json({ok:true,results:responses.flat(),perEntityLimit:12},{headers:{'Cache-Control':'no-store'}});
    }
    if(body.action==='context' && uuid(body.id)){
      // Commercial context follows the same sensitive-read boundary as finance.
      if(!canWrite(gate.identity.role))return Response.json({error:'Keine Berechtigung.'},{status:403});
      const entity=String(body.entity);
      if(!['order','annual_plan','subscription','b2b_agreement','business_expense','creator','ugc_assignment'].includes(entity))return Response.json({error:'Ungültiger Bezug.'},{status:400});
      const field=({order:'order_id',annual_plan:'annual_plan_id',subscription:'subscription_id',b2b_agreement:'b2b_agreement_id'} as Record<string,string>)[entity];
      const [events,links,activity,attribution]=await Promise.all([
        field?admin.from('financial_events').select('*').eq(field,body.id).order('created_at',{ascending:false}).limit(100):Promise.resolve({data:[],error:null}),
        admin.from('document_links').select('*, documents(*)').eq('subject_type',entity).eq('subject_id',body.id).limit(100),
        admin.from('admin_activity_log').select('id,created_at,module,action,summary,entity_type,entity_id').eq('entity_id',body.id).order('created_at',{ascending:false}).limit(50),
        entity==='order'?admin.from('order_attributions').select('*, creators(display_name)').eq('order_id',body.id):Promise.resolve({data:[],error:null}),
      ]);
      if([events,links,activity,attribution].some(r=>r.error))throw new Error('Context read failed');
      return Response.json({ok:true,events:events.data,documents:links.data,activity:activity.data,attributions:attribution.data,limits:{events:100,documents:100,activity:50}});
    }
    return Response.json({error:'Unbekannte Aktion.'},{status:400});
  }catch{return Response.json({error:'Die Daten konnten nicht geladen werden.'},{status:503});}
}
