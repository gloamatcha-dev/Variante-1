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
/**
 * THE HEADER.
 *
 * ── WHY THE MENU STATE IS NOT IN HERE ─────────────────────────
 * Two controls open the same drawer now: this header's hamburger,
 * which is the only navigation between 641px and 800px, and the mobile
 * dock's MENU, which takes over below 640px where the hamburger is
 * hidden. One drawer with two openers means one piece of state, and it
 * lives in the shell that renders both. There is still exactly one
 * <nav id="mobile-menu">, rendered here.
 */
export function Header({onCart,cartCount,menuOpen,onMenuOpenChange}:{
onCart:()=>void;cartCount:number;menuOpen:boolean;onMenuOpenChange:(next:boolean)=>void;
}){
 const [search,setSearch]=useState(false);const [scrolled,setScrolled]=useState(false);const path=usePathname();
 const menuButtonRef=useRef<HTMLButtonElement>(null);
 useEffect(()=>{const s=()=>{setScrolled(window.scrollY>10)};window.addEventListener("scroll",s,{passive:true});s();return()=>window.removeEventListener("scroll",s)},[]);
 // THE OPENER GETS THE FOCUS BACK, whichever one it was. This used to
 // hand it to the header button unconditionally, which is a dead target
 // below 640px where that button is display:none - the dock opened it
 // there. Capturing document.activeElement is what <CartDrawer/> and
 // the launch popup already do.
 useEffect(()=>{
  if(!menuOpen)return;
  const prev=document.activeElement as HTMLElement|null;
  document.body.style.overflow="hidden";
  return()=>{document.body.style.overflow="";prev?.focus?.()};
 },[menuOpen]);
 // ESCAPE CLOSES WHAT COVERS THE PAGE, and hands focus back to the
 // control that opened it. The mobile menu locks body scroll and fills
 // the screen, so a keyboard visitor who could not dismiss it was stuck
 // with the page behind it frozen. The cart drawer already did exactly
 // this; the header did not. The search panel gets the same key, but no
 // focus move - it does not take the screen, so returning focus would
 // yank it from wherever the visitor actually was.
 useEffect(()=>{
  if(!menuOpen&&!search)return;
  const onKey=(e:KeyboardEvent)=>{
   if(e.key!=="Escape")return;
   if(menuOpen)onMenuOpenChange(false);
   else setSearch(false);
  };
  document.addEventListener("keydown",onKey);
  return()=>document.removeEventListener("keydown",onKey);
 },[menuOpen,search,onMenuOpenChange]);
 // THE MARQUEE IS DECORATION, AND IS NOW MARKED AS SUCH.
 //
 // It rendered two .bb-group copies - the second aria-hidden, so the
 // loop reads seamlessly - and each copy carried FOUR real <Link>s to
 // /for-cafes. That produced three separate defects on every page of
 // the site:
 //
 //   axe aria-hidden-focus (serious)  four focusable links sat inside
 //                                    aria-hidden="true", so a keyboard
 //                                    user could focus what assistive
 //                                    technology had been told is not
 //                                    there.
 //   eight tab stops before the logo  the first eight Tab presses on
 //                                    EVERY page landed on the same
 //                                    "B2B" link, inside a moving band.
 //   25x12 px targets                 far under any touch-target floor,
 //                                    and animated while being aimed at.
 //
 // A scrolling brand band is decoration: the text is repeated eight
 // times and says nothing a screen reader needs to hear eight times,
 // and B2B is already a header nav item AND a footer link, so nothing
 // becomes unreachable. So the whole band is aria-hidden and every
 // link inside it is taken out of the tab order. A mouse can still
 // click it; the keyboard and the screen reader skip straight to the
 // header, which is where the same destinations live.
 const marqueeGroup=<div className="bb-group"><span>GLOA · SHIZUOKA, JAPAN</span><span>MATCHA IS FOR EVERYONE.</span><Link href="/for-cafes" tabIndex={-1}>B2B</Link><span>GLOA · SHIZUOKA, JAPAN</span><span>MATCHA IS FOR EVERYONE.</span><Link href="/for-cafes" tabIndex={-1}>B2B</Link><span>GLOA · SHIZUOKA, JAPAN</span><span>MATCHA IS FOR EVERYONE.</span><Link href="/for-cafes" tabIndex={-1}>B2B</Link><span>GLOA · SHIZUOKA, JAPAN</span><span>MATCHA IS FOR EVERYONE.</span><Link href="/for-cafes" tabIndex={-1}>B2B</Link></div>;
 return <><div className="brand-bar" aria-hidden="true"><div className="bb-track">{marqueeGroup}{marqueeGroup}</div></div><header className={scrolled?"compact":""}><button className="menu" ref={menuButtonRef} onClick={()=>onMenuOpenChange(!menuOpen)} aria-expanded={menuOpen} aria-controls="mobile-menu">{menuOpen?"Schließen":"Menü"}</button><Mark/><nav aria-label="Hauptnavigation">{visibleLinks.map(([h,l])=><Link key={h} href={h} className={(h==="/"?path===h:path===h||path.startsWith(h+"/"))?"nav-active":""}>{l}</Link>)}</nav><div className="head-actions">{SEARCH_ENABLED&&<button onClick={()=>setSearch(!search)} aria-expanded={search}>Suche</button>}<Link href="/account" className="account-link">Konto</Link><button className="bag-btn" onClick={onCart}>Warenkorb <span className="bag-count">{cartCount}</span></button></div>{SEARCH_ENABLED&&search&&<form className="search-bar" role="search" onSubmit={e=>e.preventDefault()}><label htmlFor="site-search">GLOA durchsuchen</label><input id="site-search" placeholder="Matcha, Rezepte, Cafés…"/><button>Suche</button></form>}</header>{menuOpen&&<nav id="mobile-menu" className="mobile-nav" aria-label="Mobile Navigation">{visibleLinks.map(([h,l])=><Link key={h} href={h} onClick={()=>onMenuOpenChange(false)}>{l}</Link>)}<Link href="/account" onClick={()=>onMenuOpenChange(false)}>Konto</Link></nav>}</>
}
/**
 * THE MOBILE DOCK.
 *
 * A floating bar over the page on phones, holding the five things a
 * visitor actually reaches for. It does NOT replace anything: the
 * hamburger and its full-screen menu still carry the complete
 * navigation, and this is the shortcut to the routes that matter.
 *
 * ── WHY IT IS NOT THE FULL NAV ────────────────────────────────
 * Seven routes at 390px is a row nobody can hit. Five is what fits
 * with a real touch target, so the dock holds three of them plus the
 * two things that are not routes at all: the drawer and the cart. The
 * full index is one tap away behind MENU.
 *
 * ── IT SITS UNDER THE MENU, NOT OVER IT ───────────────────────
 * z-index 34, one below the full-screen mobile menu's 35. Open the
 * menu and the dock is behind it, which is where a shortcut belongs
 * while the index is on screen. The cart drawer (50) and the launch
 * popup (60) cover it for the same reason.
 *
 * ── AND IT DOES NOT COVER THE PAGE ────────────────────────────
 * --dock-space in globals.css is the height it occupies including the
 * home-bar inset, and the footer reserves exactly that on mobile. The
 * value is declared once so the bar and the space it needs cannot
 * drift apart.
 */
const dockIcons = {
  menu: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4.5 7.4h15M4.5 12h15M4.5 16.6h15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>,
  shop: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6.2 8h11.6l1 11.2a1 1 0 0 1-1 1.1H6.2a1 1 0 0 1-1-1.1z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M9.2 10.4V7.6a2.8 2.8 0 0 1 5.6 0v2.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  matcha: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5.6 9.8h12.8l-.9 8.1a2 2 0 0 1-2 1.8H8.5a2 2 0 0 1-2-1.8z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M18.1 11.6h1.1a2.2 2.2 0 0 1 0 4.4h-1.5" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M10 7.2c0-1.2 1.2-1.5 1.2-2.7M13.6 7.2c0-1.2 1.2-1.5 1.2-2.7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  account: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="8.8" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M5.3 19.6a6.9 6.9 0 0 1 13.4 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  cart: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3.6 5h2.1l2.1 9.5h8.9l2-7H7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><circle cx="9.4" cy="18.6" r="1.4" fill="currentColor"/><circle cx="16.4" cy="18.6" r="1.4" fill="currentColor"/></svg>,
};

/**
 * The four routes, in the order a visitor meets them. The cart is a
 * drawer rather than a route, so it is a button and sits last.
 *
 * TWO LABELS, BECAUSE THE CELL IS 65px. The visible one has to fit on
 * one line at 10px or it ends in an ellipsis, which is worse than a
 * short word. The accessible name keeps the full route name and
 * CONTAINS the visible one, so a voice-control user saying "Start" or
 * "Korb" still hits it.
 */
const dockRoutes:[string,string,string,keyof typeof dockIcons][] = [
  ["/shop", "Kaufen", "Kaufen", "shop"],
  ["/our-matcha", "Matcha", "Unser Matcha", "matcha"],
  ["/account", "Konto", "Konto", "account"],
];

export function MobileDock({onCart,cartCount,cartOpen,menuOpen,onMenuOpenChange}:{
onCart:()=>void;cartCount:number;cartOpen:boolean;
menuOpen:boolean;onMenuOpenChange:(next:boolean)=>void;
}){
const path=usePathname();
const isActive=(href:string)=>path===href||path.startsWith(href+"/");
return <nav className="dock" aria-label="Schnellnavigation">
<div className="dock-inner">
{/* THE SAME DRAWER THE HEADER OPENS. aria-controls points at the one
    <nav id="mobile-menu"> the header renders; nothing here duplicates
    it. The home entry that used to sit in this slot went: the wordmark
    in the header is already the way back to the start. */}
<button type="button" className={"dock-item dock-menu"+(menuOpen?" dock-item-active":"")}
        onClick={()=>onMenuOpenChange(!menuOpen)}
        aria-expanded={menuOpen} aria-controls="mobile-menu">
  <span className="dock-icon" aria-hidden="true">{dockIcons.menu}</span>
  <span className="dock-label">Menü</span>
</button>
{dockRoutes.map(([href,short,full,icon])=>{
const active=isActive(href);
return <Link key={href} href={href} className={"dock-item"+(active?" dock-item-active":"")}
             aria-current={active?"page":undefined}
             aria-label={short===full?undefined:full}>
  <span className="dock-icon" aria-hidden="true">{dockIcons[icon]}</span>
  <span className="dock-label">{short}</span>
</Link>;
})}
<button type="button" className={"dock-item dock-cart"+(cartOpen?" dock-item-active":"")} onClick={onCart}
        aria-expanded={cartOpen}
        aria-label={cartCount>0?`Warenkorb, ${cartCount} Artikel`:"Warenkorb, leer"}>
  <span className="dock-icon" aria-hidden="true">
    {dockIcons.cart}
    {cartCount>0&&<span className="dock-badge" aria-hidden="true">{cartCount}</span>}
  </span>
  <span className="dock-label">Korb</span>
</button>
</div>
</nav>;
}

export function Footer(){return <footer><div><Mark/><p>Matcha aus Japan.<br/>Gemacht in Berlin.</p></div><div><p className="eyebrow">KAUFEN</p><Link href="/shop">Matcha</Link><Link href="/our-matcha">Unser Matcha</Link></div><div><p className="eyebrow">GLOA</p><Link href="/about">Über GLOA</Link>{RECIPES_VISIBLE&&<Link href="/rezepte">Rezepte</Link>}<Link href="/contact">Kontakt</Link></div><div><p className="eyebrow">BUSINESS</p><Link href="/for-cafes">B2B</Link><Link href="/for-cafes#lead">B2B-Anfrage</Link><Link href="/for-cafes?intent=sample#lead">Sample anfragen</Link></div><div><p className="eyebrow">LEGAL</p>{[["impressum","Impressum"],["datenschutz","Datenschutz"],["agb","AGB"],["widerruf","Widerruf"],["versand","Versand"]].map(([h,l])=><Link key={h} href={`/${h}`}>{l}</Link>)}</div><div className="social-note"><p className="eyebrow">SOCIAL</p><a href="https://www.tiktok.com/@gloa.matcha" target="_blank" rel="noopener noreferrer">TikTok</a><a href={`https://instagram.com/${BRAND.instagram}`} target="_blank" rel="noopener noreferrer">Instagram</a></div><p className="image-note">Bildhinweis: Die aktuell auf dieser Website gezeigten Bilder sind KI-generierte Visualisierungen und werden schrittweise durch finale Fotografien ersetzt.</p><div className="legal"><span>© 2026 GLOA</span><span>GLOA · BERLIN</span></div></footer>}
