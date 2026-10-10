import {requireAdminIdentity} from '../../../../lib/adminActionRoute.ts';
import {getSupabaseAdmin} from '../../../../lib/supabaseAdmin';
import {portalPeriod} from '../../../../lib/adminPortalFinance.ts';
import {uuid} from '../../../../lib/adminPortalModel.ts';
export async function POST(request:Request):Promise<Response>{
  let body:Record<string,unknown>;
  try{body=await request.json();if(!body||typeof body!=='object'||Array.isArray(body))throw Error();}catch{return Response.json({error:'Ungültige Anfrage.'},{status:400});}
  const gate=body.action==='list'
    ? await requireAdminIdentity(request, "read_sensitive")
    : await requireAdminIdentity(request, "write");
  if(!gate.ok)return gate.response;
  const admin=getSupabaseAdmin();if(!admin)return Response.json({error:'Nicht verfügbar.'},{status:503});
  try{
    if(body.action==='list'){
      const period=portalPeriod(body);
      const {data,error}=await admin.rpc('read_cost_finance_basis_v1',{p_from:period.from,p_to:period.to});
      if(error||!data)throw Error();
      return Response.json({ok:true,period,subjects:data.subjects,coverage:data.coverage,months:data.months,generalCoverage:data.generalCoverage,expenses:data.expenses,coverageExpenses:data.coverageExpenses});
    }
    if(typeof body.reason!=='string'||!body.reason.trim()||body.reason.length>500)return Response.json({error:'Bitte eine kurze Begründung angeben.'},{status:400});
    const actor=gate.session.userId,op=uuid(body.operationId)?body.operationId:null;
    let name:string,args:Record<string,unknown>;
    if(body.action==='set_direct'&&uuid(body.subjectId)){
      name='admin_set_direct_cost_coverage_v1';args={p_actor_user_id:actor,p_subject_kind:body.subjectKind,p_subject_id:body.subjectId,p_cost_class:body.costClass,p_status:body.status,p_expense_id:uuid(body.expenseId)?body.expenseId:null,p_reason:body.reason,p_operation_id:op};
    }else if(body.action==='set_month'&&typeof body.month==='string'&&/^\d{4}-\d{2}-01$/.test(body.month)){
      name='admin_confirm_general_cost_month_v1';args={p_actor_user_id:actor,p_period_start:body.month,p_status:body.status,p_reason:body.reason,p_operation_id:op};
    }else if(body.action==='create_b2b_expense'&&uuid(body.deliveryId)){
      name='admin_record_b2b_delivery_expense_v1';args={p_actor_user_id:actor,p_delivery_id:body.deliveryId,p_occurred_on:body.occurredOn,p_category:body.category,p_gross_cents:body.grossCents,p_vat_cents:body.vatCents??null,p_description:body.description,p_vendor:body.vendor??null,p_note:body.note??null,p_operation_id:op};
    }else return Response.json({error:'Ungültige Anfrage.'},{status:400});
    const {data,error}=await admin.rpc(name,args);
    if(error)return Response.json({error:'Kostenbeleg oder Bestätigung nicht gültig. Zuordnung und vorhandene Kosten prüfen.'},{status:error.code==='42501'?403:409});
    return Response.json({ok:true,result:data});
  }catch{return Response.json({error:'Kostenabdeckung konnte nicht geladen werden.'},{status:503});}
}
