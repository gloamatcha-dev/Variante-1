import {createHash,randomUUID} from 'node:crypto';
import {requireAdminIdentity} from '../../../../lib/adminActionRoute.ts';
import {readPortalPages} from '../../../../lib/adminPortalRead.ts';
import {getSupabaseAdmin} from '../../../../lib/supabaseAdmin';
import {uuid} from '../../../../lib/adminPortalModel.ts';

const bucket='gloa-finance-documents';
const fileLimit=3*1024*1024;
const kinds=['stripe_receipt','gloa_invoice','expense_receipt','b2b_document','other'];
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});

function metadata(data:Record<string,unknown>) {
  const field=(name:string,max:number)=>{
    const value=data[name];
    if(value==null||value==='')return null;
    if(typeof value!=='string'||value.trim().length>max)throw Error('metadata');
    return value.trim()||null;
  };
  const cents=(name:string)=>{
    const value=field(name,10);
    if(value===null)return null;
    if(!/^\d+$/.test(value)||Number(value)>2147483647)throw Error('amount');
    return Number(value);
  };
  const title=field('title',200),issued_on=field('issuedOn',10),currency=field('currency',3),payment_status=field('paymentStatus',16);
  if(!title||(issued_on!==null&&(!/^\d{4}-\d{2}-\d{2}$/.test(issued_on)||!Number.isFinite(Date.parse(issued_on))||
    new Date(issued_on).toISOString().slice(0,10)!==issued_on))||(currency&&!/^[A-Z]{3}$/.test(currency))||
    (payment_status&&!['paid','unpaid','partial'].includes(payment_status)))throw Error('metadata');
  const gross_cents=cents('grossCents'),net_cents=cents('netCents'),tax_cents=cents('taxCents');
  if((gross_cents!==null&&!currency)||((net_cents!==null||tax_cents!==null)&&
     (gross_cents===null||net_cents===null||tax_cents===null||gross_cents!==net_cents+tax_cents)))throw Error('amount');
  return {title,issued_on,issuer:field('issuer',200),invoice_number:field('invoiceNumber',120),
    gross_cents,net_cents,tax_cents,currency,payment_status,note:field('note',4000)};
}

async function boundedBody(request:Request,maximum:number) {
  const reader=request.body?.getReader();
  if(!reader||Number(request.headers.get('content-length'))>maximum)throw Error('size');
  const chunks:Uint8Array[]=[];
  let size=0;
  for(;;){
    const {done,value}=await reader.read();
    if(done)return Buffer.concat(chunks,size);
    size+=value.length;
    if(size>maximum){await reader.cancel().catch(()=>{});throw Error('size');}
    chunks.push(value);
  }
}

function fileType(bytes:Buffer) {
  if(bytes.subarray(0,5).toString()==='%PDF-'&&bytes.subarray(-1024).includes('%%EOF'))return ['application/pdf','pdf'];
  if(bytes.subarray(0,3).equals(Buffer.from([255,216,255]))&&bytes.subarray(-2).equals(Buffer.from([255,217])))return ['image/jpeg','jpg'];
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.subarray(-12,-8).equals(Buffer.from([0,0,0,0]))&&
     bytes.subarray(-8,-4).toString()==='IEND')return ['image/png','png'];
  return null;
}

export async function POST(request:Request) {
  const gate=await requireAdminIdentity(request,'read_sensitive');
  if(!gate.ok)return gate.response;
  const contentType=request.headers.get('content-type')??'';
  const multipart=contentType.startsWith('multipart/form-data;');
  let input:Record<string,unknown>;
  try{
    const bytes=await boundedBody(request,multipart?fileLimit+16*1024:16*1024);
    const parsed=multipart?Object.fromEntries(await new Response(new Uint8Array(bytes),{headers:{'Content-Type':contentType}}).formData()):JSON.parse(bytes.toString());
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('body');
    input=parsed;
  }catch{return json({error:'Ungültige Anfrage oder Dateigröße überschritten.'},400);}
  const admin=getSupabaseAdmin();
  if(!admin)return json({error:'Nicht verfügbar.'},503);
  const action=input.action??'list';
  try{
    if(action==='list'&&!multipart){
      const [documents,links]=await Promise.all([readPortalPages(admin,'documents'),readPortalPages(admin,'document_links',q=>q,'document_id')]);
      return json({ok:true,documents,links});
    }
    if(action==='download'&&!multipart){
      if(!uuid(input.id))return json({error:'Ungültiger Beleg.'},400);
      const result=await admin.from('documents').select('storage_path,file_sha256').eq('id',input.id).maybeSingle();
      const path=result.data?.storage_path;
      if(result.error||!result.data?.file_sha256||typeof path!=='string'||
        !new RegExp('^'+String(input.id)+'/original\\.(pdf|jpg|png)$').test(path))return json({error:'Originaldatei nicht verfügbar.'},404);
      const {data,error}=await admin.storage.from(bucket).download(path);
      if(error||!data||data.size>fileLimit)return json({error:'Originaldatei nicht verfügbar.'},404);
      const bytes=Buffer.from(await data.arrayBuffer());
      if(createHash('sha256').update(bytes).digest('hex')!==result.data.file_sha256)return json({error:'Dateiintegrität nicht bestätigt.'},409);
      return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'application/octet-stream',
        'Content-Disposition':'attachment; filename="beleg.'+path.split('.').at(-1)+'"',
        'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'}});
    }
    const write=await requireAdminIdentity(request,'write');
    if(!write.ok)return write.response;
    if(request.headers.get('origin')!==new URL(request.url).origin)return json({error:'Ungültiger Anfrageursprung.'},403);
    const actor=write.session.userId;
    if(action==='create_document'){
      if(!kinds.includes(String(input.kind)))return json({error:'Ungültige Belegart.'},400);
      const fields=metadata(input);
      const id=randomUUID();
      const file=input.file;
      let storage_path:string|null=null,file_sha256:string|null=null,mime_type:string|null=null,byte_size:number|null=null;
      if(file instanceof File&&file.size){
        if(!multipart||file.size>fileLimit||input.kind==='stripe_receipt')return json({error:'Datei nicht zugelassen.'},400);
        const bytes=Buffer.from(await file.arrayBuffer()),type=fileType(bytes);
        if(!type||type[0]!==file.type)return json({error:'Nur gültige PDF-, JPG- und PNG-Dateien.'},400);
        [mime_type]=type;
        byte_size=bytes.length;
        file_sha256=createHash('sha256').update(bytes).digest('hex');
        storage_path=id+'/original.'+type[1];
        const upload=await admin.storage.from(bucket).upload(storage_path,bytes,{contentType:mime_type,upsert:false});
        if(upload.error)return json({error:'Datei konnte nicht gespeichert werden.'},503);
      }
      const external_reference=typeof input.externalReference==='string'?input.externalReference.trim():null;
      const saved=await admin.rpc('admin_accounting_document_v1',{p_actor:actor,p_action:'create',
        p:{...fields,id,kind:input.kind,storage_path,file_sha256,mime_type,byte_size,external_reference}});
      if(saved.error){
        // Only remove a private upload on a definitive database rejection. A
        // lost response may conceal a committed record.
        if(storage_path&&/^(22|23|42)/.test(saved.error.code??''))await admin.storage.from(bucket).remove([storage_path]).catch(()=>{});
        return json({error:saved.error.code==='23505'?'Beleg bereits erfasst.':'Beleg konnte nicht gespeichert werden.'},saved.error.code==='23505'?409:400);
      }
      return json({ok:true,documentId:saved.data});
    }
    if(!uuid(input.id??input.documentId)||multipart)return json({error:'Ungültiger Beleg.'},400);
    let operation:string,p:Record<string,unknown>;
    if(action==='update_document'){operation='update';p={id:input.id,...metadata(input)};}
    else if(action==='link_document'&&uuid(input.entityId)){operation='link';p={id:input.documentId,entity_type:input.entityType,entity_id:input.entityId};}
    else if(action==='income'||action==='correct_income'){
      operation=action;
      if(action==='correct_income'&&!uuid(input.previousId))return json({error:'Ungültige Ausgangsbuchung.'},400);
      const fields=metadata({...input,title:'Einnahme',issuedOn:input.occurredOn,currency:'EUR'});
      p={id:input.id,previous_id:input.previousId,reference:input.reference,reason:input.reason,non_stripe:input.nonStripe,
        occurred_on:fields.issued_on,gross_cents:fields.gross_cents,net_cents:fields.net_cents,tax_cents:fields.tax_cents};
    }else return json({error:'Unbekannte Aktion.'},400);
    const result=await admin.rpc('admin_accounting_document_v1',{p_actor:actor,p_action:operation,p});
    if(result.error)return json({error:result.error.code==='23505'?'Beleg oder Buchung bereits erfasst.':'Aktion nicht möglich. Beleg und Zuordnung prüfen.'},result.error.code==='23505'?409:400);
    return json({ok:true,id:result.data});
  }catch{return json({error:'Aktion nicht möglich. Eingaben und Beleg prüfen.'},400);}
}
