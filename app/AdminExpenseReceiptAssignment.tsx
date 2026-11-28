"use client";

import { useRef, useState, type FormEvent } from 'react';
import { date, text, type PortalRow } from '../lib/adminPortalModel.ts';
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABEL, type ExpenseCategory } from '../lib/financeSummary';
import { documentAmount, documentPaymentLabel } from './AdminDocumentFacts';
import { ExpenseOrderSearch } from './AdminPortalExpenseOrder';
import { portalRequest, ReadState, usePortalRead } from './AdminPortalShared';

const endpoint = '/api/admin/documents';

export function AdminExpenseReceiptAssignment({onAssigned}: {onAssigned: () => void}) {
  const {data,error,refresh}=usePortalRead(endpoint,{action:'list'});
  const [id,setId]=useState('');
  const [notice,setNotice]=useState('');
  const receipts=((data?.documents ?? []) as PortalRow[]).filter(row=>row.kind==='expense_receipt');
  const selected=receipts.find(row=>row.id===id);
  const links=((data?.links ?? []) as PortalRow[]).filter(link=>link.document_id===id);
  const linked=links.filter(link=>link.subject_type==='business_expense'||link.subject_type==='financial_event');

  return <ReadState data={data} error={error} retry={refresh}>
    <label>Gespeicherter Ausgabenbeleg
      <select value={id} onChange={event=>{setId(event.target.value);setNotice('');}}>
        <option value="">Bitte wählen</option>
        {receipts.map(row=><option key={String(row.id)} value={String(row.id)}>
          {text(row.title)} · {date(row.issued_on)} · {text(row.invoice_number,'ohne Nummer')} · {documentAmount(row.gross_cents,row.currency)}
        </option>)}
      </select>
    </label>
    {notice && <p role="status">{notice}</p>}
    {selected && <>
      <h4>{text(selected.title)}</h4>
      <dl className="portal-facts">
        <div><dt>Datum</dt><dd>{date(selected.issued_on)}</dd></div>
        <div><dt>Rechnungsnummer</dt><dd>{text(selected.invoice_number,'Unbekannt')}</dd></div>
        <div><dt>Netto</dt><dd>{documentAmount(selected.net_cents,selected.currency)}</dd></div>
        <div><dt>Umsatzsteuer</dt><dd>{documentAmount(selected.tax_cents,selected.currency)}</dd></div>
        <div><dt>Brutto</dt><dd>{documentAmount(selected.gross_cents,selected.currency)}</dd></div>
        <div><dt>Zahlungsstatus am Beleg</dt><dd>{documentPaymentLabel(selected.payment_status)}</dd></div>
      </dl>
      {linked.length ? <p>Bereits zugeordnet: {linked.map(link=>text(link.subject_id)).join(', ')}.</p>
        : selected.currency!=='EUR'||typeof selected.gross_cents!=='number'||selected.gross_cents<=0
          ? <p>Für die Zuordnung ist ein bestätigter positiver Bruttobetrag in EUR erforderlich.</p>
          : <ReceiptAssignmentForm key={id} receipt={selected} onAssigned={()=>{
              setId('');setNotice('Beleg und Ausgabe wurden verbunden. Den Zahlungsstatus kannst du in der Ausgabe separat prüfen.');
              refresh();onAssigned();
            }}/>}
    </>}
    {!receipts.length && <p>Keine gespeicherten Ausgabenbelege vorhanden.</p>}
  </ReadState>;
}

function ReceiptAssignmentForm({receipt,onAssigned}: {receipt: PortalRow;onAssigned:()=>void}) {
  const {data,error,refresh}=usePortalRead(endpoint,{action:'expense_receipt_targets',id:receipt.id});
  const [target,setTarget]=useState('');
  const [category,setCategory]=useState<ExpenseCategory>('general');
  const [orderId,setOrderId]=useState('');
  const [busy,setBusy]=useState(false);
  const [problem,setProblem]=useState('');
  const submitting=useRef(false);
  const existing=((data?.expenses ?? []) as PortalRow[])
    .filter(row=>receipt.tax_cents==null||row.vat_cents===receipt.tax_cents)
    .sort((a,b)=>Number(b.occurred_on===receipt.issued_on)-Number(a.occurred_on===receipt.issued_on));
  const create=target==='new';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const confirmed=new FormData(event.currentTarget).get('confirmed')==='on';
    if(submitting.current||!confirmed||!target||(create&&category!=='general'&&!orderId))return;
    submitting.current=true;setBusy(true);setProblem('');
    try {
      await portalRequest(endpoint,{action:'assign_expense_receipt',id:receipt.id,confirmed,
        expected:{gross:receipt.gross_cents,tax:receipt.tax_cents??null,date:receipt.issued_on??null},
        ...(create ? {category,orderId:category==='general'?null:orderId} : {expenseId:target}),
      });
      onAssigned();
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : 'Zuordnung fehlgeschlagen.');
    } finally {
      submitting.current=false;setBusy(false);
    }
  }

  return <ReadState data={data} error={error} retry={refresh}>
    <form className="portal-form" onSubmit={event=>void submit(event)}>
      <label>Ausgabenposition<select value={target} disabled={busy} onChange={event=>setTarget(event.target.value)} required>
        <option value="">Bitte wählen</option>
        {existing.map(row=><option key={String(row.id)} value={String(row.id)}>
          {date(row.occurred_on)} · {text(row.description)} · {EXPENSE_CATEGORY_LABEL[row.category as ExpenseCategory]} · {documentPaymentLabel(row.payment_status)}
        </option>)}
        <option value="new" disabled={!receipt.issued_on}>Neue Ausgabe aus Beleg erfassen</option>
      </select></label>
      {!receipt.issued_on&&<p>Für eine neue Ausgabe zuerst das Belegdatum unter Dokumente ergänzen.</p>}
      {create && <>
        <label>Kostenkategorie<select value={category} disabled={busy} onChange={event=>setCategory(event.target.value as ExpenseCategory)}>
          {EXPENSE_CATEGORIES.filter(value=>value!=='payment_fee').map(value=>
            <option key={value} value={value}>{EXPENSE_CATEGORY_LABEL[value]}</option>)}
        </select></label>
        {category!=='general' && <ExpenseOrderSearch value={orderId} onChange={setOrderId}/>}
        <p>Die neue Ausgabe wird mit „Offen“ erfasst. Prüfe den eigenen Zahlungsnachweis und ändere den Status separat über „Ändern“.</p>
      </>}
      {!create && target && <p>Kostenkategorie und Zahlungsstatus der bestehenden Ausgabe bleiben erhalten.</p>}
      {target && <label key={target}><input type="checkbox" name="confirmed" required disabled={busy}/> Ich bestätige die Belegzuordnung.</label>}
      {problem && <p role="alert">{problem}</p>}
      <button type="submit" disabled={busy||!target||(create&&category!=='general'&&!orderId)}>Zuordnung speichern</button>
    </form>
  </ReadState>;
}
