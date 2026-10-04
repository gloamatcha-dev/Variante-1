"use client";
const key='gloa-affiliate-reference';
export function captureAffiliateReference(): void {
  if(typeof window==='undefined')return;
  const query=new URLSearchParams(window.location.search);
  const slug=query.get('ref'),code=query.get('affiliate_code');
  if(!slug&&!code)return;
  const value=slug?{affiliateSlug:slug}:{affiliateCode:code};
  try{window.sessionStorage.setItem(key,JSON.stringify(value));}catch{/* Checkout remains available when storage is disabled. */}
}
export function readAffiliateReference(): {affiliateSlug?:string;affiliateCode?:string} {
  if(typeof window==='undefined')return {};
  captureAffiliateReference();
  try{
    const value=JSON.parse(window.sessionStorage.getItem(key)??'{}');
    if(typeof value.affiliateSlug==='string'&&value.affiliateSlug.length<=120)return {affiliateSlug:value.affiliateSlug};
    if(typeof value.affiliateCode==='string'&&value.affiliateCode.length<=120)return {affiliateCode:value.affiliateCode};
  }catch{/* No attribution is preferable to corrupt client data. */}
  return {};
}
