"use client";
import type {PortalRow} from '../lib/adminPortalModel.ts';
import {BusinessTable,Chip,ReadState,usePortalRead} from './AdminPortalShared';

export function AdminPortalInventoryWarnings(){
  const {data,error,refresh}=usePortalRead('/api/admin/portal',{action:'inventory_warnings'});
  return <section><div className="portal-section-head"><h2>Inventarwarnungen</h2><button type="button" onClick={refresh}>Aktualisieren</button></div><ReadState data={data} error={error} retry={refresh}><BusinessTable rows={(data?.items??[]) as PortalRow[]} columns={[{key:'name',title:'Artikel'},{key:'current_quantity',title:'Bestand',render:r=>r.current_quantity==null?'unbekannt':`${String(r.current_quantity)} ${String(r.unit??'')}`},{key:'stockState',title:'Status',render:r=><Chip value={r.stockState}/>},{key:'low_stock_threshold',title:'Meldebestand',render:r=>r.low_stock_threshold==null?'nicht erfasst':String(r.low_stock_threshold)}]}/></ReadState><p className="portal-note">Bestandsbewegungen bleiben manuell. Bestellung, Versand und Refund ändern hier keine Menge.</p></section>;
}
