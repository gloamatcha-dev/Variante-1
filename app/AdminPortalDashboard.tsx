"use client";
import {useState} from 'react';
import {date,money,text,type PortalArea,type PortalRow} from '../lib/adminPortalModel.ts';
import {usePortalRead,ReadState,MoneySummary,Period,BusinessTable,Info,Chip} from './AdminPortalShared';

export function AdminPortalDashboard({navigate}:{navigate:(area:PortalArea,tab?:string,filter?:string)=>void}){
  const [period,setPeriod]=useState<PortalRow>({period:'month'});
  const {data,error,refresh}=usePortalRead('/api/admin/dashboard-summary',period);
  const summary=data?.summary as PortalRow|undefined;
  const tasks:[string,string,PortalArea,string?,string?][]=[
    ['Bestellungen mit Handlungsbedarf','ordersUnshipped','sales','BESTELLUNGEN','attention'],
    ['Versand heute','shippingToday','sales','BESTELLUNGEN','due_today'],
    ['Versand überfällig','shippingOverdue','sales','BESTELLUNGEN','overdue'],
    ['Kommende Jahreslieferungen','annualUpcoming','sales','JAHRESPLÄNE','upcoming'],
    ['Offene Verbraucherrechte','rightsOpen','rights','widerruf','open'],
    ['Außerordentliche Kündigungen','extraordinaryPending','rights','kuendigung','extraordinary'],
    ['Refunds mit Handlungsbedarf','refundsAttention','rights','widerruf','refund'],
    ['Offene Ausgaben','openExpenses','finance','AUSGABEN','open'],
    ['Fehlende Kosten','missingCosts','finance','AUSGABEN','missing'],
    ['Inventarwarnungen','inventoryLow','inventory',undefined,'warnings'],
    ['B2B Handlungsbedarf','b2bAttention','b2b',undefined,'attention'],
    ['Offene Creator-Bewerbungen','creatorApplicationsPending','creator','BEWERBUNGEN','open'],
    ['Provisionen und Auszahlungen','creatorPayoutAttention','creator','AUSZAHLUNGEN','attention'],
  ];
  return <><div className="portal-section-head"><div><p className="portal-eyebrow">DEIN BETRIEB AUF EINEN BLICK</p><h2>Heute zu erledigen</h2></div><button type="button" onClick={refresh}>Aktualisieren</button></div><ReadState data={data} error={error} retry={refresh}>
    <div className="portal-tasks">{tasks.map(([name,key,area,tab,filter])=><button type="button" key={key} onClick={()=>navigate(area,tab,filter)}><span>{name}</span><strong>{typeof summary?.[key]==='number'?String(summary[key]):'unbekannt'}</strong><span aria-hidden="true">↗</span></button>)}</div>
    {data?.shippingComplete===false&&<p className="portal-note">Versand-Fälligkeitszahlen sind für diese umfangreiche Warteschlange unbekannt. Die Bestellansicht zeigt den verbindlichen Status je Bestellung.</p>}
    {(data?.warnings as string[]|undefined)?.length?<p role="status" className="portal-warning">Einige Daten sind nicht verfügbar. <button type="button" onClick={refresh}>Erneut laden</button></p>:null}
    <div className="portal-section-head"><h2>Geschäft im Zeitraum <Info>Finanzereignisse werden serverseitig über alle Seiten gelesen. Jahreslieferungen erzeugen keine zweite Einnahme.</Info></h2><Period value={period} onChange={setPeriod}/></div>
    <MoneySummary summary={(data?.business??null) as PortalRow|null}/>
    <div className="portal-grid"><section><h2>Zuletzt bezahlt</h2>{data?.recentPaidOrders===null?<p className="portal-state">Bezahlte Bestellungen unbekannt.</p>:<BusinessTable rows={(data?.recentPaidOrders??[]) as PortalRow[]} columns={[{key:'order_number',title:'Bestellung',render:r=><button type="button" onClick={()=>navigate('sales','BESTELLUNGEN',text(r.order_number,''))}>{text(r.order_number,'Bestellung ohne Nummer')}</button>},{key:'customer',title:'Kunde',render:r=>text((r.customer_snapshot as PortalRow)?.name??(r.customer_snapshot as PortalRow)?.email)},{key:'total_gross_cents',title:'Betrag',render:r=>money(r.total_gross_cents)}]}/>}</section>
    <section><h2>Anstehender Versand</h2>{data?.upcomingShipments===null?<p className="portal-state">Versanddaten unbekannt.</p>:<BusinessTable rows={(data?.upcomingShipments??[]) as PortalRow[]} onOpen={r=>navigate('sales','BESTELLUNGEN',String(r.order_number??r.id))} columns={[{key:'order_number',title:'Bestellung'},{key:'shippingDue',title:'Versand',render:r=><Chip value={(r.shippingDue as PortalRow)?.state}/>},{key:'due',title:'Spätestens',render:r=>date((r.shippingDue as PortalRow)?.due_date)}]}/>}</section>
    <section><h2>Kommende Jahreslieferungen</h2>{data?.upcomingAnnual===null?<p className="portal-state">Lieferdaten unbekannt.</p>:<BusinessTable rows={(data?.upcomingAnnual??[]) as PortalRow[]} onOpen={r=>navigate('sales','JAHRESPLÄNE',String(r.annual_plan_id))} columns={[{key:'customer',title:'Kunde',render:r=>text((((data?.annualPlans??[]) as PortalRow[]).find(p=>p.id===r.annual_plan_id)?.customer_snapshot as PortalRow)?.name)},{key:'delivery_number',title:'Lieferung',render:r=>typeof r.delivery_number==='number'?`Lieferung ${r.delivery_number}`:'nicht erfasst'},{key:'scheduled_for',title:'Geplant',render:r=>date(r.scheduled_for)},{key:'state',title:'Status',render:r=><Chip value={r.state}/>}]}/>}</section>
    <section><h2>Was zuletzt passiert ist</h2>{data?.recentActivity===null?<p className="portal-state">Aktivität unbekannt.</p>:<BusinessTable rows={(data?.recentActivity??[]) as PortalRow[]} columns={[{key:'created_at',title:'Zeit',render:r=>date(r.created_at,true)},{key:'summary',title:'Vorgang'}]}/>}</section></div>
  </ReadState></>;
}
