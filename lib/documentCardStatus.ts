import type {PortalRow} from './adminPortalModel.ts';

const normalize = (value:unknown) => typeof value==='string' ? value.trim().toLowerCase() : '';

export type DocumentCardStatus =
  | {state:'saved'|'existing';id:string}
  | {state:'review'|'editing'|'error'|'check'};

export function documentCardStatus(
  fields:Record<string,string|number>, digest:string|undefined,
  documents:PortalRow[]|null, confirmedId:string|undefined,
  failure:'error'|'check'|undefined, selected:boolean,
):DocumentCardStatus {
  if(confirmedId) return {state:'saved',id:confirmedId};
  const issuer=normalize(fields.issuer), invoice=normalize(fields.invoiceNumber);
  if(documents) {
    const matches=documents.filter(row=>(digest&&row.file_sha256===digest)||
      (issuer&&invoice&&normalize(row.issuer)===issuer&&normalize(row.invoice_number)===invoice));
    if(matches.length===1&&!matches[0].cleanup_operation_id&&typeof matches[0].id==='string') {
      return {state:'existing',id:matches[0].id};
    }
    if(matches.length) return {state:'check'};
  }
  if(failure) return {state:failure};
  if(selected) return {state:'editing'};
  return {state:documents&&digest&&issuer&&invoice?'review':'check'};
}
