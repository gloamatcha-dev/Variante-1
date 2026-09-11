"use client";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BRAND, RECIPES_VISIBLE } from "./content";

// ONE array, read by BOTH the desktop nav and the mobile menu below, so
// the two can never list different pages. Partnerschaften sits between
// B2B and Rezepte: the two business-facing routes stay adjacent and the
// editorial one keeps the end of the row.
// SEARCH IS NOT BUILT YET, so the header does not offer it.
//
// The panel below searched nothing: its form called preventDefault and
// stopped there, on every page, next to a real cart and a real account
// link. A field that answers nothing is worse than no field.
//
// NOTHING WAS DELETED. The `search` state, the toggle, the panel, its
// label, its input and the .search-bar styles all stay exactly where
// they are - this withholds the entry point, it does not remove the
// groundwork. Flipping this to true brings the whole control back, and
// the real search is its own task.
const SEARCH_ENABLED = false;
const links:[ string, string ][] = [["/","Startseite"],["/shop","Kaufen"],["/our-matcha","Unser Matcha"],["/about","Über GLOA"],["/for-cafes","B2B"],["/partnerships","Partnerschaften"],["/rezepte","Rezepte"]];
// RECIPES ARE WITHHELD FOR THIS LAUNCH. `links` above is UNTOUCHED, in
// its intended order, so flipping RECIPES_VISIBLE in content.ts puts the
// entry back exactly where it belongs rather than appending it. The
// filter is applied once, here, and both navigations below read the
// result - so the desktop row and the mobile menu still cannot diverge,
// which is the whole reason `links` is one array.
const visibleLinks = links.filter(([href]) => RECIPES_VISIBLE || href !== "/rezepte");
export function Mark(){return <Link className="wordmark" href="/" aria-label="GLOA Startseite"><span className="wordmark-glyph" aria-hidden="true"/></Link>}
export function Header({onCart,cartCount}:{onCart:()=>void;cartCount:number}){
 const [open,setOpen]=useState(false);const [search,setSearch]=useState(false);const [scrolled,setScrolled]=useState(false);const path=usePathname();
 const menuButtonRef=useRef<HTMLButtonElement>(null);
 useEffect(()=>{const s=()=>{setScrolled(window.scrollY>10)};window.addEventListener("scroll",s,{passive:true});s();return()=>window.removeEventListener("scroll",s)},[]);
 useEffect(()=>{document.body.style.overflow=open?"hidden":"";return()=>{document.body.style.overflow=""}},[open]);
 // ESCAPE CLOSES WHAT COVERS THE PAGE, and hands focus back to the
 // control that opened it. The mobile menu locks body scroll and fills
 // the screen, so a keyboard visitor who could not dismiss it was stuck
 // with the page behind it frozen. The cart drawer already did exactly
 // this; the header did not. The search panel gets the same key, but no
 // focus move - it does not take the screen, so returning focus would
 // yank it from wherever the visitor actually was.
 useEffect(()=>{
  if(!open&&!search)return;
  const onKey=(e:KeyboardEvent)=>{
   if(e.key!=="Escape")return;
   if(open){setOpen(false);menuButtonRef.current?.focus()}
   else setSearch(false);
  };
  document.addEventListener("keydown",onKey);
  return()=>document.removeEventListener("keydown",onKey);
 },[open,search]);
 const marqueeGroup=<div className="bb-group"><span>GLOA · SHIZUOKA, JAPAN</span><span>MATCHA IS FOR EVERYONE.</span><Link href="/for-cafes">B2B</Link><span>GLOA · SHIZUOKA, JAPAN</span><span>MATCHA IS FOR EVERYONE.</span><Link href="/for-cafes">B2B</Link><span>GLOA · SHIZUOKA, JAPAN</span><span>MATCHA IS FOR EVERYONE.</span><Link href="/for-cafes">B2B</Link><span>GLOA · SHIZUOKA, JAPAN</span><span>MATCHA IS FOR EVERYONE.</span><Link href="/for-cafes">B2B</Link></div>;
 return <><div className="brand-bar"><div className="bb-track">{marqueeGroup}<div className="bb-group" aria-hidden="true"><span>GLOA · SHIZUOKA, JAPAN</span><span>MATCHA IS FOR EVERYONE.</span><Link href="/for-cafes">B2B</Link><span>GLOA · SHIZUOKA, JAPAN</span><span>MATCHA IS FOR EVERYONE.</span><Link href="/for-cafes">B2B</Link><span>GLOA · SHIZUOKA, JAPAN</span><span>MATCHA IS FOR EVERYONE.</span><Link href="/for-cafes">B2B</Link><span>GLOA · SHIZUOKA, JAPAN</span><span>MATCHA IS FOR EVERYONE.</span><Link href="/for-cafes">B2B</Link></div></div></div><header className={scrolled?"compact":""}><button className="menu" ref={menuButtonRef} onClick={()=>setOpen(!open)} aria-expanded={open} aria-controls="mobile-menu">{open?"Schließen":"Menü"}</button><Mark/><nav aria-label="Hauptnavigation">{visibleLinks.map(([h,l])=><Link key={h} href={h} className={(h==="/"?path===h:path===h||path.startsWith(h+"/"))?"nav-active":""}>{l}</Link>)}</nav><div className="head-actions">{SEARCH_ENABLED&&<button onClick={()=>setSearch(!search)} aria-expanded={search}>Suche</button>}<Link href="/account" className="account-link">Konto</Link><button className="bag-btn" onClick={onCart}>Warenkorb <span className="bag-count">{cartCount}</span></button></div>{SEARCH_ENABLED&&search&&<form className="search-bar" role="search" onSubmit={e=>e.preventDefault()}><label htmlFor="site-search">GLOA durchsuchen</label><input id="site-search" placeholder="Matcha, Rezepte, Cafés…"/><button>Suche</button></form>}</header>{open&&<nav id="mobile-menu" className="mobile-nav" aria-label="Mobile Navigation">{visibleLinks.map(([h,l])=><Link key={h} href={h} onClick={()=>setOpen(false)}>{l}</Link>)}<Link href="/account" onClick={()=>setOpen(false)}>Konto</Link></nav>}</>
}
export function Footer(){return <footer><div><Mark/><p>Matcha aus Japan.<br/>Gemacht in Berlin.</p></div><div><p className="eyebrow">KAUFEN</p><Link href="/shop">Matcha</Link><Link href="/our-matcha">Unser Matcha</Link></div><div><p className="eyebrow">GLOA</p><Link href="/about">Über GLOA</Link>{RECIPES_VISIBLE&&<Link href="/rezepte">Rezepte</Link>}<Link href="/contact">Kontakt</Link></div><div><p className="eyebrow">BUSINESS</p><Link href="/for-cafes">B2B</Link><Link href="/for-cafes#lead">B2B-Anfrage</Link><Link href="/for-cafes?intent=sample#lead">Sample anfragen</Link></div><div><p className="eyebrow">LEGAL</p>{[["impressum","Impressum"],["datenschutz","Datenschutz"],["agb","AGB"],["widerruf","Widerruf"],["versand","Versand"]].map(([h,l])=><Link key={h} href={`/${h}`}>{l}</Link>)}</div><div className="social-note"><p className="eyebrow">SOCIAL</p><a href="https://www.tiktok.com/@gloa.matcha" target="_blank" rel="noopener noreferrer">TikTok</a><a href={`https://instagram.com/${BRAND.instagram}`} target="_blank" rel="noopener noreferrer">Instagram</a></div><div className="legal"><span>© 2026 GLOA</span><span>GLOA · BERLIN</span></div></footer>}
