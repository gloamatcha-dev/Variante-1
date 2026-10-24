type Row = Record<string, unknown>;
export type StripeRead = (path: string, params: Record<string,string>) => Promise<Row>;
const fields: Record<string,string[]> = {
 payment_intents:['id','livemode','amount','amount_received','currency','status','created','latest_charge'],
 charges:['id','livemode','amount','amount_captured','amount_refunded','currency','paid','captured','status','created','payment_intent','balance_transaction'],
 refunds:['id','amount','currency','status','created','charge','payment_intent','balance_transaction','failure_balance_transaction'],
 balance_transactions:['id','amount','fee','net','currency','created','available_on','source','type','reporting_category','status'],
 payouts:['id','livemode','amount','currency','status','created','arrival_date','balance_transaction','failure_balance_transaction','failure_code'],
};
/** Read-only port. Full pagination; whitelist removes customer/credential fields. */
export type StripeReadCheckpoint={rows:Row[];cursor:string;done:boolean};
export async function readStripeReconciliation(get: StripeRead, from: number, to: number, identity: {accountId:string;paymentIntentId:string;amountCents:number},progress?:{load:(resource:string)=>StripeReadCheckpoint|undefined;save:(resource:string,state:StripeReadCheckpoint)=>Promise<void>}) {
 if (!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from>=to) throw Error('invalid_period');
 // Account/known-object binding is trusted server/operator configuration, never
 // supplied by a browser. The same restricted key must retrieve that LIVE object;
 // no Connect context or /account permission is necessary for this check.
 if(!/^acct_[A-Za-z0-9_]+$/.test(identity.accountId)||!/^pi_[A-Za-z0-9_]+$/.test(identity.paymentIntentId)||!Number.isSafeInteger(identity.amountCents)||identity.amountCents<=0)throw Error('invalid_identity');
 const known=await get('/v1/payment_intents/'+identity.paymentIntentId,{});
 if(known.id!==identity.paymentIntentId||known.livemode!==true||known.amount_received!==identity.amountCents||known.status!=='succeeded'||known.currency!=='eur')throw Error('live_identity_unverified');
 const failures:string[]=[];
 const accountId=identity.accountId;
 const objects: Record<string,Row[]> = {};
 for(const [resource,keys] of Object.entries(fields)) {
  try {
  const saved=progress?.load(resource);
  const rows:Row[]=[...(saved?.rows??[])],seen=new Set<string>(rows.map(r=>String(r.id)));let cursor=saved?.cursor??'';
  if(saved?.done){objects[resource]=rows;continue;}
  for(;;) {
   const page=await get(`/v1/${resource}`,{limit:'100','created[gte]':String(from),'created[lt]':String(to),...(cursor?{starting_after:cursor}:{})});
   if(!Array.isArray(page.data)||typeof page.has_more!=='boolean')throw Error(`invalid_page:${resource}`);
   for(const raw of page.data as Row[]) {
    if(typeof raw.id!=='string'||seen.has(raw.id)||('livemode' in raw && raw.livemode!==true))throw Error(`invalid_object:${resource}`);
    seen.add(raw.id);
    rows.push(Object.fromEntries(keys.filter(k=>k in raw).map(k=>[k,raw[k]])));
   }
   if(!page.has_more){await progress?.save(resource,{rows,cursor:String((page.data.at(-1) as Row|undefined)?.id??cursor),done:true});break;}
   const next=(page.data.at(-1) as Row|undefined)?.id;
   if(typeof next!=='string'||next===cursor)throw Error(`incomplete_page:${resource}`);
   cursor=next;
   await progress?.save(resource,{rows,cursor,done:false});
  }
  objects[resource]=rows;
  } catch(error) {if(error instanceof Error&&error.message==='finance_sync_yield')throw error;failures.push(resource);}
 }
 return {accountId,accountVerification:'operator_binding_and_known_live_payment' as const,live:true,from,to,complete:failures.length===0,failures,objects};
}

/** Exact invoice -> paid InvoicePayment -> PaymentIntent bridge. No amount/date
 * guessing, no customer fields. Multiple payments remain explicit for review. */
export async function readStripeInvoicePayments(get: StripeRead, invoiceIds: string[]) {
 const relations:{invoiceId:string;invoicePaymentId:string;paymentIntentId:string;amountPaidCents:number;paidAt:number}[]=[];
 for (const invoiceId of new Set(invoiceIds)) {
  if (!/^in_[A-Za-z0-9_]+$/.test(invoiceId)) throw Error('invalid_invoice_identity');
  const seen=new Set<string>();let cursor='';
  for (;;) {
   const page=await get('/v1/invoice_payments',{invoice:invoiceId,status:'paid',limit:'100',...(cursor?{starting_after:cursor}:{})});
   if(!Array.isArray(page.data)||typeof page.has_more!=='boolean')throw Error('invalid_invoice_page');
   for (const r of page.data as Row[]) {
    const payment=r.payment as Row|undefined;
    const invoice=typeof r.invoice==='string'?r.invoice:(r.invoice as Row|undefined)?.id;
    const intent=typeof payment?.payment_intent==='string'?payment.payment_intent:(payment?.payment_intent as Row|undefined)?.id;
    const paidAt=(r.status_transitions as Row|undefined)?.paid_at;
    if(typeof r.id!=='string'||seen.has(r.id)||r.livemode!==true||r.currency!=='eur'||!Number.isSafeInteger(r.amount_paid)||Number(r.amount_paid)<=0||!Number.isSafeInteger(paidAt)||Number(paidAt)<=0
      ||r.status!=='paid'||invoice!==invoiceId||payment?.type!=='payment_intent'||typeof intent!=='string'||!/^pi_[A-Za-z0-9_]+$/.test(intent))throw Error('invoice_payment_conflict');
    seen.add(r.id);relations.push({invoiceId,invoicePaymentId:r.id,paymentIntentId:intent,amountPaidCents:Number(r.amount_paid),paidAt:Number(paidAt)});
   }
   if(!page.has_more)break;
   const next=(page.data.at(-1) as Row|undefined)?.id;
   if(typeof next!=='string'||next===cursor)throw Error('incomplete_invoice_page');
   cursor=next;
  }
  if(!seen.size)throw Error('invoice_payment_missing');
 }
 return relations;
}
