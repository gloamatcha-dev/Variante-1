import type { SupabaseClient } from '@supabase/supabase-js';
import type { PortalRow } from './adminPortalModel.ts';
/** Read all pages for aggregates; never mistake a PostgREST page limit for a total. */
export async function readPortalPages(client:SupabaseClient,table:string,
  filter:(query:ReturnType<ReturnType<SupabaseClient['from']>['select']>)=>ReturnType<ReturnType<SupabaseClient['from']>['select']> = q=>q,
  order='id',columns='*'):Promise<PortalRow[]> {
  if(table==='order_attributions'&&order==='id')order='order_id';
  const rows:PortalRow[]=[];
  for(let page=0;;page++){
    let query=filter(client.from(table).select(columns,{count:'exact'})).order(order);
    if(table==='creator_roles')query=query.order('role');
    if(table==='document_links')query=query.order('subject_type').order('subject_id');
    const {data,error,count}=await query.range(page*500,page*500+499);
    if(error)throw new Error(`Read ${table} failed`);
    const next=(data??[]) as unknown as PortalRow[];
    rows.push(...next);
    if(next.length===0 || (typeof count==='number' && rows.length>=count))break;
  }
  return rows;
}
