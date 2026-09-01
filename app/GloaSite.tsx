"use client";
import { useEffect, useState, useRef, useCallback, useSyncExternalStore } from "react";
import Link from "next/link";
import { Header, Footer } from "./Chrome";
import { BRAND, PRODUCT, SHOP_STATUS } from "./content";
import { useCatalog, useCatalogList, fmtCents, per100gCents } from "./useCatalog";
import type { CatalogProduct } from "./useCatalog";
import { getProductPresentation, showsUnitPricePer100g, showsFoodInformation, isWeighedProduct, getProductImage, getProductSubtitle, getProductEyebrow, MATCHA_NOT_INCLUDED_SHORT } from "../lib/productPresentation";
import { BusinessCalculator } from "./BusinessCalculator";
import { AccountPortal } from "./AccountPortal";
import { OrderSuccess } from "./OrderSuccess";
import { track } from "./analytics";
// The launch countdown's arithmetic lives in a pure leaf: it takes `now`
// as an argument, clamps at zero and owns the one new fact this page
// introduces - the launch instant.
import { GLOA_LAUNCH_LABEL, launchCountdown, padCountdownUnit } from "../lib/launchCountdown";
import { useCart } from "./cart";
import { AuthProvider, useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { AUTH_CONFIRM_PATH, PASSWORD_RESET_PATH, browserAuthRedirectUrl } from "../lib/authRedirect";
import { SHIPPING_ZONES, SHIPPING_PRICING, getShippingZone, getCountryLabel, computeShippingGrossCents, SHIPPING_COUNTRY_OPTIONS, DELIVERY_TIME_NOTE, CUSTOMS_NOTE } from "../lib/shipping";
import { createCheckoutSession } from "./createCheckoutSession";


type Recipe={slug:string;title:string;category:string;time:string;servings:string;tags:string[];image:string;alt:string;excerpt:string;description:string;ingredients:string[];steps:string[];featured:boolean};
const recipes:Recipe[]=[
{slug:"classic-matcha-latte",title:"Classic Matcha Latte",category:"REZEPT",time:"5 MIN",servings:"1 Tasse",tags:["LATTE"],image:"/img/gloa-morning.jpg",alt:"Classic Matcha Latte",excerpt:"Der Klassiker. Cremig, warm und easy.",description:"Der GLOA-Klassiker: warme Milch oder Pflanzendrink, aufgeschäumt und über Matcha gegossen. Cremig und unkompliziert.",ingredients:["1 TL Matcha (ca. 3\u20134 g)","30 ml heißes Wasser (ca. 80 \u00b0C)","200 ml Milch oder Pflanzendrink","Optional: Süße nach Geschmack"],steps:["Matcha in eine Schale oder ein Glas geben.","Mit heißem Wasser übergießen und glatt rühren.","Milch oder Pflanzendrink erwärmen und aufschäumen.","Matcha-Mischung in die Tasse geben, Milch darüber gießen.","Optional süßen und genießen."],featured:true},
{slug:"iced-matcha-latte",title:"Iced Matcha Latte",category:"REZEPT",time:"4 MIN",servings:"1 Glas",tags:["ICED","LATTE"],image:"/img/gloa-iced.jpg",alt:"Iced Matcha Latte",excerpt:"Kalt, cremig und erfrischend.",description:"Matcha Latte, nur kalt. Für warme Tage und unterwegs.",ingredients:["1 TL Matcha (ca. 3\u20134 g)","30 ml heißes Wasser (ca. 80 \u00b0C)","150\u2013200 ml kalte Milch oder Pflanzendrink","Eiswürfel","Optional: Süße nach Geschmack"],steps:["Matcha mit heißem Wasser glatt rühren.","Ein Glas mit Eiswürfeln füllen.","Kalte Milch oder Pflanzendrink eingießen.","Matcha-Mischung langsam darüber gießen.","Optional süßen und genießen."],featured:true},
{slug:"strawberry-matcha-latte",title:"Strawberry Matcha Latte",category:"REZEPT",time:"5 MIN",servings:"1 Glas",tags:["ICED","FRUITY","LATTE"],image:"/img/gloa-recipe-strawberry-matcha.jpg",alt:"Strawberry Matcha Latte",excerpt:"Fruchtige Erdbeere trifft auf soften Matcha.",description:"Fruchtig, cremig und sofort sommerlich. Erdbeere und Matcha funktionieren zusammen besser, als man denkt.",ingredients:["3 TL zerdrückte oder gemixte Erdbeeren","15 ml Vanillesirup","150\u2013180 ml Milch oder Pflanzendrink","Eiswürfel","1 TL Matcha (ca. 4 g)","60 ml Wasser zum Anrühren","Optional: Erdbeerpulver als Topping"],steps:["Erdbeeren mit Vanillesirup am Glasboden verteilen.","Eis ins Glas geben.","Milch oder Pflanzendrink einfüllen.","Matcha mit Wasser glatt rühren.","Matcha-Mischung langsam als obere Schicht eingießen.","Optional mit Erdbeerpulver toppen."],featured:true},
{slug:"orange-zest-matcha-tonic",title:"Orange Zest Matcha Tonic",category:"REZEPT",time:"4 MIN",servings:"1 Glas",tags:["ICED","SPARKLING","REFRESHING"],image:"/img/gloa-recipe-orange-zest-tonic.jpg",alt:"Orange Zest Matcha Tonic",excerpt:"Zitrisch, sparkling und super frisch.",description:"Zitrisch, frisch und leicht bitter. Ein klarer Sommerdrink mit Matcha-Tonic-Twist.",ingredients:["30 ml Orange-Zest-Sirup oder 60 ml Orangensaft","60\u2013100 ml Tonic Water","Eiswürfel","1 TL Matcha (ca. 4 g)","60 ml Wasser zum Anrühren","Optional: Orangenzeste"],steps:["Orange-Zest-Sirup oder Orangensaft in ein Glas geben.","Eis hinzufügen.","Mit Tonic Water auffüllen.","Matcha mit Wasser glatt rühren.","Langsam über die Eiswürfel gießen, damit eine schöne Schichtung entsteht.","Optional mit Orangenzeste finishen."],featured:true},
{slug:"lemon-raspberry-coconut-matcha",title:"Lemon Raspberry Coconut Matcha",category:"REZEPT",time:"5 MIN",servings:"1 Glas",tags:["ICED","TROPICAL","FRUITY"],image:"/img/gloa-recipe-lemon-raspberry-coconut.jpg",alt:"Lemon Raspberry Coconut Matcha",excerpt:"Frisch, exotisch und farblich ein echter Hingucker.",description:"Frisch, leicht exotisch und visuell super stark. Zitrone, Himbeere, Kokos und Matcha in einem Drink.",ingredients:["30 ml Himbeersirup","15 ml Zitronensaft","100\u2013150 ml Kokoswasser oder leichte Kokosbasis","Eiswürfel","1 TL Matcha (ca. 4 g)","60 ml Wasser zum Anrühren"],steps:["Himbeersirup und Zitronensaft ins Glas geben.","Eis einfüllen.","Mit Kokoswasser auffüllen.","Matcha mit Wasser glatt rühren.","Langsam über das Eis gießen, damit sich die grüne Schicht oben absetzt."],featured:false},
{slug:"affogato-matcha-cloud",title:"Affogato & Matcha Cloud",category:"REZEPT",time:"5 MIN",servings:"1 Glas",tags:["ICED","COFFEE"],image:"/img/gloa-recipe-affogato-cloud.jpg",alt:"Affogato mit Matcha Cloud",excerpt:"Espresso, Eis und cremiger Matcha-Finish.",description:"Kräftiger Espresso trifft auf eine cremige Matcha-Cloud. Intensiv, kühl und für alle, die Kaffee und Matcha nicht trennen wollen.",ingredients:["2 Shots Espresso","Eiswürfel","1 Kugel Vanille-Gelato oder 1\u20132 TL Vanilleeis","1 TL Matcha (ca. 4\u20135 g)","2 TL Sahne oder Whipping Cream","1 TL Milch","Optional: etwas Süße"],steps:["Espresso zubereiten und leicht abkühlen lassen.","Ein Glas mit Eis füllen und den Espresso eingießen.","Für die Matcha-Cloud Matcha mit wenig Wasser glatt rühren.","Sahne und Milch leicht aufschäumen oder cremig verrühren.","Matcha-Cloud unterheben und als obere Schicht auf den Espresso geben.","Optional mit Vanille-Gelato servieren."],featured:false}
];
const ALL_TAGS=["ALLE","LATTE","ICED","FRUITY"];
// The rail shows all four recipes rather than the two flagged `featured`.
// That flag stays on the data for the recipes page; deriving a two-item
// list here is what left a wide desktop rail half empty.
// The six lifestyle tiles, in the order the wall reads:
//   MORNING | WORK | CAFÉ
//   ON THE GO | ICED | SOCIAL
// `focus` is an object-position, added because a 3x2 grid crops far
// harder than the old wide strip did - a centre crop was cutting the
// cup out of two of them. The image FILES are untouched.
const dailyTiles=[{label:"MORNING",src:"/img/gloa-morning.jpg",alt:"Matcha am Morgen",focus:"center 38%"},{label:"WORK",src:"/img/gloa-work.jpg",alt:"Iced Matcha am Arbeitsplatz",focus:"center 45%"},{label:"CAFÉ",src:"/img/gloa-cafe.jpg",alt:"Matcha-Zubereitung im Café",focus:"center 42%"},{label:"ON THE GO",src:"/img/gloa-on-the-go.jpg",alt:"Iced Matcha unterwegs in Berlin",focus:"center 35%"},{label:"ICED",src:"/img/gloa-iced.jpg",alt:"Iced Matcha",focus:"center center"},{label:"SOCIAL",src:"/img/gloa-social.jpg",alt:"Freunde mit Matcha",focus:"center 32%"}];
// TODO: Replace local community items with Instagram Graph API data after account/API credentials are configured.
type CommunityItem={id:string;image:string;href?:string;alt:string;label:string}
const communityItems:CommunityItem[]=[{id:"1",image:"/img/gloa-cafe.jpg",alt:"Matcha-Zubereitung im Café",label:"CAFÉ"},{id:"2",image:"/img/gloa-on-the-go.jpg",alt:"Iced Matcha unterwegs in Berlin",label:"ON THE GO"},{id:"3",image:"/img/gloa-iced.jpg",alt:"Iced Matcha",label:"ICED"},{id:"4",image:"/img/gloa-social.jpg",alt:"Freunde mit Matcha",label:"SOCIAL"},{id:"5",image:"/img/gloa-morning.jpg",alt:"Matcha am Morgen",label:"MORNING"},{id:"6",image:"/img/gloa-work.jpg",alt:"Iced Matcha am Arbeitsplatz",label:"WORK"}];
function Placeholder({children=""}:{children?:string}){return <span className="placeholder-label">{children}</span>}
/** The product feature's visual. `contain`, because the pouch and its
 *  COMING SOON stamp are the subject and a crop would cut one of them. */
/* The homepage product card and its visual were removed with the
 * prelaunch redesign: this page no longer merchandises the product
 * before it is on sale. The shop, the product pages, the catalog and
 * public/img/Produkt BILD.png are all untouched and still carry it. */
// The two preparation modules. Inline SVG rather than an icon package:
// two 22px line marks are not worth a dependency, and drawing them here
// keeps them on currentColor, which is what makes them matcha green.
const howToModules=[{
  number:"01",title:"MATCHA LATTE",dose:"3 g Matcha",
  steps:["Matcha dosieren","mit Wasser aufschlagen","Milch oder Pflanzendrink dazu","heiß oder iced genießen"],
  icon:<svg className="how-to-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="M5.4 5h10.2v9.6a4.6 4.6 0 0 1-4.6 4.6h-1a4.6 4.6 0 0 1-4.6-4.6z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="M15.6 7.8h1.8a2.5 2.5 0 0 1 0 5h-1.8" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M5.4 10.2h10.2" stroke="currentColor" strokeWidth="1.4"/></svg>,
},{
  number:"02",title:"PURE MATCHA",dose:"3 g Matcha",
  steps:["Matcha dosieren","mit wenig Wasser glattrühren","mit Wasser aufschlagen","direkt genießen"],
  icon:<svg className="how-to-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="M3.4 10.6h17.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><path d="M4.9 10.6a7.1 7.1 0 0 0 14.2 0" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M9.6 7.4c0-1.3 1.3-1.6 1.3-2.9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><path d="M13.6 7.4c0-1.3 1.3-1.6 1.3-2.9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
}];
function HowTo(){return <section className="how-to"><div className="how-to-inner home-rail"><div className="how-to-body"><div className="how-to-copy"><p className="eyebrow how-to-eyebrow">HOW TO GLOA</p><h2 className="how-to-headline"><span className="how-to-line">Latte oder pur.</span><i className="how-to-line how-to-line-accent">Mehr brauchst du nicht.</i></h2></div><div className="how-to-modules">{howToModules.map(m=><article className="how-to-module" key={m.number}><div className="how-to-module-head">{m.icon}<span className="how-to-module-number">{m.number}</span></div><h3 className="how-to-module-title">{m.title}</h3><p className="how-to-module-dose">{m.dose}</p><ol className="how-to-steps">{m.steps.map((step,i)=><li key={step}><span className="how-to-step-number">{String(i+1).padStart(2,"0")}</span><span className="how-to-step-text">{step}</span></li>)}</ol></article>)}</div></div></div></section>}
/**
 * The community photo strip.
 *
 * ── SAME SEAMLESS ARCHITECTURE AS THE RECIPE CAROUSEL ─────────
 *
 * Three identical passes of the same six photos, translated by exactly
 * calc(-100% / 3), so the loop restarts on a frame identical to the one
 * before it. The gutter is a margin-right on the tile rather than a flex
 * gap: a third of an 18-tile track is then exactly one pass, trailing
 * gutter included, instead of a third of a gutter short.
 *
 * At any offset the content still to the right of the left edge is never
 * less than TWO passes - 6 x (230..280 + 18) = 1488..1788px each - and
 * the strip occupies at most the right column of the rail, so it cannot
 * run dry. This replaces a setInterval that stepped 25% at a time and
 * snapped back to zero, which is what made the reset visible.
 *
 * The second and third passes are aria-hidden with no alt text. Under
 * reduced motion, and on touch, they are display:none and the strip is a
 * native snap scroller instead.
 */
function CommunityFeed(){
const track=[...communityItems,...communityItems,...communityItems];
return <div className="community-strip"><div className="community-strip-track">
{track.map((item,i)=>{const clone=i>=communityItems.length;return <figure className="community-tile" key={`cf-${i}`} aria-hidden={clone||undefined}>
<img src={item.image} alt={clone?"":item.alt} loading="lazy"/>
<figcaption>{item.label}</figcaption>
</figure>})}
</div></div>}
function RecipeCarousel(){
const track=[...recipes,...recipes,...recipes];
return <section className="featured-recipes">
<div className="featured-recipes-head home-rail-pad">
<p className="eyebrow featured-recipes-eyebrow">GLOA RECIPES</p>
<h2 className="featured-recipes-headline">
<span className="featured-recipes-line">Matcha.</span>
<i className="featured-recipes-line featured-recipes-line-accent">Mach was draus.</i>
</h2>
</div>
<div className="recipe-marquee">
<div className="recipe-marquee-track">
{track.map((r,i)=>{const clone=i>=recipes.length;return <Link key={`rm-${i}`} href={`/rezepte/${r.slug}`} className="recipe-card" aria-hidden={clone||undefined} tabIndex={clone?-1:undefined}>
<p className="recipe-card-time">{r.time}</p>
<div className="recipe-card-img"><img src={r.image} alt={clone?"":r.alt} loading="lazy"/></div>
<h3 className="recipe-card-title">{r.title}</h3>
</Link>})}
</div></div>
<div className="featured-recipes-foot home-rail-pad">
<p className="featured-recipes-sub">Unsere liebsten Matcha-Rezepte.</p>
<Link className="featured-recipes-cta" href="/rezepte">ALLE REZEPTE <span aria-hidden="true">→</span></Link>
</div>
</section>
}

/**
 * The launch countdown.
 *
 * ── ONE TIMER, ONE SECOND, AND IT STOPS ───────────────────────
 *
 * Every value comes from launchCountdown() in lib/launchCountdown.ts,
 * which is pure and clamps at zero, so this component owns no arithmetic
 * and cannot render a negative day. The interval is cleared on unmount
 * and again the moment the launch instant passes: a page left open past
 * midnight settles into the launched state instead of ticking forever.
 *
 * ── AND IT DOES NOT TALK TO SCREEN READERS EVERY SECOND ───────
 *
 * The ticking block is aria-hidden and there is no aria-live anywhere
 * near it. A countdown that announced itself once a second would make
 * the page unusable with a screen reader. The heading and the date carry
 * the meaning instead, and both are real text.
 */
let clockTick=0;
/**
 * ONE clock for the whole page, read through useSyncExternalStore.
 *
 * The snapshot is a cached number that only changes when the interval
 * fires, so React is never handed a new value on every render, the
 * subscription is torn down with the component, and the SERVER snapshot
 * is null - the band renders without numbers on the server and hydrates
 * without a mismatch, because a server clock and a browser clock are
 * never the same instant.
 */
const clockStore={
subscribe(onChange:()=>void){
clockTick=Date.now();
const id=setInterval(()=>{clockTick=Date.now();onChange()},1000);
return()=>clearInterval(id);
},
getSnapshot(){return clockTick||Date.now()},
getServerSnapshot(){return null as number|null},
};

function LaunchCountdown(){
const now=useSyncExternalStore(clockStore.subscribe,clockStore.getSnapshot,clockStore.getServerSnapshot);
const state=now===null?null:launchCountdown(now);
return <section className="countdown" aria-labelledby="countdown-title">
<div className="countdown-inner home-rail">
<div className="countdown-head">
<h2 className="countdown-title" id="countdown-title">{state?.launched?"GLOA is here":"GLOA is coming"}</h2>
<p className="countdown-date">{GLOA_LAUNCH_LABEL}</p>
</div>
{state?.launched
?<p className="countdown-live">Der Shop ist offen.</p>
:<div className="countdown-units" aria-hidden="true">
{([["Days",state?.days],["Hours",state?.hours],["Min",state?.minutes],["Sec",state?.seconds]] as const).map(([label,value])=>
<div className="countdown-unit" key={label}>
<span className="countdown-value">{value===undefined?"--":padCountdownUnit(value)}</span>
<span className="countdown-label">{label}</span>
</div>)}
</div>}
</div>
</section>
}

/**
 * The hero's scroll-linked typography.
 *
 * ── SCROLL-LINKED, NOT A MARQUEE ──────────────────────────────
 *
 * One requestAnimationFrame reader writes ONE CSS variable,
 * --hero-scroll, as a 0..1 progress value across the first viewport of
 * scrolling. The two headline lines and the lead each translate by a
 * different multiple of it in globals.css, so the movement is tied to
 * the reader's own scrolling and stops when they stop. Nothing loops,
 * nothing animates on its own, and the copy is fully legible at every
 * point - the largest displacement is a few dozen pixels.
 *
 * prefers-reduced-motion: reduce turns it off in CSS AND skips the
 * listener entirely here, so a reduced-motion visitor pays for no
 * scroll work at all. Mobile keeps a much smaller displacement (see the
 * 900px media query) so a narrow line never drifts toward an edge.
 */
function useHeroScrollProgress(){
const ref=useRef<HTMLElement|null>(null);
useEffect(()=>{
const node=ref.current;
if(!node)return;
if(window.matchMedia("(prefers-reduced-motion: reduce)").matches)return;
let frame=0;
const read=()=>{
frame=0;
const height=window.innerHeight||1;
const raw=Math.min(1,Math.max(0,window.scrollY/height));
// SMOOTHSTEP. The raw ratio is linear, which reads as mechanical: the
// type starts moving the instant the page does and stops dead at the
// end. Easing it in and out is what makes the same displacement feel
// deliberate rather than dragged along.
const progress=raw*raw*(3-2*raw);
node.style.setProperty("--hero-scroll",progress.toFixed(4));
};
const onScroll=()=>{if(!frame)frame=window.requestAnimationFrame(read)};
read();
window.addEventListener("scroll",onScroll,{passive:true});
window.addEventListener("resize",onScroll,{passive:true});
return()=>{
if(frame)window.cancelAnimationFrame(frame);
window.removeEventListener("scroll",onScroll);
window.removeEventListener("resize",onScroll);
};
},[]);
return ref;
}

function Home(){
const heroRef=useHeroScrollProgress();
return <main><section className="hero"><div className="hero-copy" ref={heroRef as React.RefObject<HTMLDivElement>}><p className="eyebrow">MATCHA AUS SHIZUOKA.</p><h1>Matcha.<br/><span className="hero-line-2">Is for everyone.</span></h1><p className="lead">Für Latte, pur, iced oder wie du willst.</p><div className="hero-actions"><Link className="cta berry" href="/about">GLOA entdecken</Link></div></div><div className="hero-art"><img src="/img/Header.png" alt="GLOA Matcha in Bewegung" className="hero-img" fetchPriority="high"/></div></section><LaunchCountdown/><section className="prelaunch"><div className="prelaunch-inner"><p className="eyebrow prelaunch-eyebrow">PRELAUNCH</p><h2 className="prelaunch-headline"><span className="prelaunch-line-1">Zum Launch</span><i className="prelaunch-line-2">benachrichtigt</i><span className="prelaunch-line-3">werden.</span></h2><p className="prelaunch-body">Trag dich ein und wir schicken dir eine Nachricht,<br/>wenn GLOA online geht. Nur ein kurzes Update zum Launch.</p><Link className="cta prelaunch-cta" href="/contact" onClick={()=>track("notify_click")}>Zum Launch benachrichtigen</Link><a className="prelaunch-social" href={`https://instagram.com/${BRAND.instagram}`} target="_blank" rel="noopener noreferrer"><svg className="prelaunch-social-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" strokeWidth="1.6"/><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.6"/><circle cx="17.2" cy="6.8" r="1.1" fill="currentColor"/></svg><span>Oder folge uns einfach auf Instagram →</span></a></div></section><section className="daily"><div className="daily-inner home-rail"><div className="daily-copy"><p className="eyebrow daily-eyebrow">MATCHA FÜR JEDEN TAG</p><h2 className="daily-headline"><span className="daily-line">Morgens.</span><span className="daily-line">Im Meeting.</span><i className="daily-line daily-line-accent">Nachmittags.</i></h2><span className="daily-rule" aria-hidden="true"/><p className="daily-note">Reiner Genuss. Klare Energie.<br/>Für jeden Moment deines Tages.</p><Link className="daily-link" href="/our-matcha">Matcha entdecken <span aria-hidden="true">→</span></Link></div><div className="daily-grid">{dailyTiles.map(t=><figure className="daily-tile" key={t.label}><img src={t.src} alt={t.alt} loading="lazy" style={{objectPosition:t.focus}}/><figcaption>{t.label}</figcaption></figure>)}</div></div></section><section className="origin"><div className="origin-inner home-rail"><div className="origin-copy"><p className="eyebrow origin-eyebrow">ORIGIN</p><h2 className="origin-headline"><span className="origin-line">From Shizuoka,</span><i className="origin-line origin-line-accent">Japan.</i></h2></div><span className="origin-divider" aria-hidden="true"/><div className="origin-facts"><p className="origin-intro">100 % Bio-Matcha aus Shizuoka, fein vermahlen.</p><dl className="origin-list"><div><dt>MATCHA</dt><dd>100 % Bio</dd></div><div><dt>MADE FOR</dt><dd>Latte + pur</dd></div></dl></div></div></section><HowTo/><RecipeCarousel/><section className="community"><div className="community-inner home-rail"><div className="community-copy"><p className="eyebrow community-eyebrow">#GLOAMATCHA</p><h2 className="community-headline"><span className="community-line">Zeig uns</span><i className="community-line community-line-accent">deinen Matcha.</i></h2><a className="community-cta" href={`https://instagram.com/${BRAND.instagram}`} target="_blank" rel="noopener noreferrer">{`@${BRAND.instagram} folgen`}</a></div><CommunityFeed/></div></section><BrandNote/></main>}

// -- Catalog-driven shop --------------------------------------------
//
// The shop renders whatever the public catalog exposes. Visibility is
// decided by RLS, so a draft product cannot appear here even by accident.
//
// Per-product presentation (image, subtitle, eyebrow, food vs accessory)
// is resolved by lib/productPresentation.ts, so a card, a detail page and
// a cart line cannot drift apart. Nothing is invented for a product that
// has no data: a missing image or subtitle simply renders nothing.
const MATCHA_SLUG="matcha";

/**
 * Products /shop withholds for now.
 *
 * HIDDEN, NEVER DELETED: the catalog row, the price, the variants, the
 * IDs, the route /shop/metal-case, the tax category, the image and the
 * "Matcha nicht enthalten" notice are all exactly where they were. This
 * page skips them, and the hero's "ab" price skips them with it, so the
 * page cannot advertise a price for something it does not list.
 *
 * Bringing the case back is deleting one string from this array.
 */
const SHOP_HIDDEN_SLUGS=Object.freeze(["metal-case"]);
const visibleShopProducts=(products:CatalogProduct[])=>products.filter(p=>!SHOP_HIDDEN_SLUGS.includes(p.slug));

/**
 * The image /shop renders for a product, when it differs from the shared
 * presentation image.
 *
 * Deliberately NOT a change to getProductImage(): that map also serves
 * the cart line, the product card and the product page, and this pass
 * only re-frames the shop section.
 */
const SHOP_SECTION_IMAGE:Readonly<Record<string,{src:string;alt:string}>>=Object.freeze({
[MATCHA_SLUG]:{src:"/img/Produkt Bild (2).png",alt:"Grünes Matcha-Pulver"},
});

function VariantSelector({product,selected,onSelect,name}:{product:CatalogProduct;selected:number;onSelect:(i:number)=>void;name:string}){
if(product.variants.length<2)return null;
const weighed=isWeighedProduct(product.variants[selected]);
return <div className="size-selector" role="radiogroup" aria-label={weighed?"Größe wählen":"Variante wählen"}>
{product.variants.map((mv,i)=><label key={mv.id} className={`size-option${i===selected?" active":""}`}><input type="radio" name={name} className="sr-only" value={mv.id} checked={i===selected} onChange={()=>onSelect(i)}/><span className="size-option-size">{mv.label}</span><span className="size-option-price">{fmtCents(mv.price_gross_cents)} €</span></label>)}
</div>}

/** One product's purchase block on the shop page. Keeps its own variant
 *  state, so several products on one page never share a selection. */
function ShopProductBlock({product,onAdd}:{product:CatalogProduct;onAdd:()=>void}){
const {addItem}=useCart();
const [idx,setIdx]=useState(0);
const safe=Math.min(idx,product.variants.length-1);
const v=product.variants[safe];
const presentation=getProductPresentation(product.slug,v);
const per100=showsUnitPricePer100g(v)?per100gCents(v.price_gross_cents,v.size_grams as number):null;
const own=SHOP_SECTION_IMAGE[product.slug];
const img=own??(getProductImage(product)?{src:getProductImage(product) as string,alt:product.name}:null);
const sub=getProductSubtitle(product);
const handleAdd=()=>{addItem({productId:product.id,productName:product.name,productSlug:product.slug,variantId:v.id,label:v.label,grams:v.size_grams,purchaseType:"once",unitPriceCents:v.price_gross_cents});track("add_to_cart");onAdd()};
return <div className="shop-product-row home-rail">
{img&&<div className="shop-product-visual"><img src={img.src} alt={img.alt} loading="lazy"/></div>}
<div className="shop-product-info"><p className="eyebrow shop-product-eyebrow">{getProductEyebrow(product)}</p><h2 className="shop-product-title">{product.name.toUpperCase()}</h2>
{sub&&<p className="shop-product-sub">{sub}</p>}

<VariantSelector product={product} selected={safe} onSelect={setIdx} name={`variant-${product.slug}`}/>

<p className="shop-product-price">{fmtCents(v.price_gross_cents)} €</p>
{per100!==null&&<p className="shop-product-per100g">{fmtCents(per100)} € / 100 g</p>}
{presentation.matchaNotIncludedNotice&&<p className="product-not-included">{presentation.matchaNotIncludedNotice}</p>}

<button className="cta shop-cta" onClick={SHOP_STATUS==="prelaunch"?()=>window.location.href="/contact":handleAdd}>{SHOP_STATUS==="prelaunch"?"Fragen zum Launch":"In den Warenkorb"}</button>
</div></div>}

/** Confirmed GLOA Matcha food information. Rendered only for the Matcha
 *  product itself - an accessory must never inherit any of this. */
function MatchaShopDetails({product}:{product:CatalogProduct}){
return <section className="shop-accordion"><div className="shop-accordion-inner home-rail">
<details className="product-accordion">
<summary><span>Produktdetails &amp; Pflichtangaben</span><span className="product-accordion-icon" aria-hidden="true"/></summary>
<div className="product-accordion-body">
<dl><div><dt>LEBENSMITTELBEZEICHNUNG</dt><dd>Matcha (Grünteepulver)</dd></div><div><dt>HERKUNFT</dt><dd>Shizuoka, Japan</dd></div><div><dt>QUALITÄT</dt><dd>100 % Bio-Matcha</dd></div><div><dt>LAGERUNG</dt><dd>{PRODUCT.storage}</dd></div><div><dt>GROESSEN</dt><dd>{product.variants.map(x=>x.label).join(" · ")}</dd></div></dl>
<p className="product-operator-note">Lebensmittelunternehmer: Cara 2 GmbH, Hardenbergstr. 4, 10623 Berlin, Deutschland</p>
</div>
</details>
<details className="product-accordion">
<summary><span>Zutaten</span><span className="product-accordion-icon" aria-hidden="true"/></summary>
<div className="product-accordion-body">
{/* THE ROW IS "ZUTATEN", NOT "ZUTATEN & NÄHRWERTE". No nutrition data
    exists in this repository, and tests/legal-content.test.mjs bans the
    word outright so that none can be invented. A row promising a table
    nobody measured is the failure that guard exists to prevent. */}
<dl><div><dt>ZUTAT</dt><dd>100 % Matcha-Grünteepulver, keine Zusätze</dd></div></dl>
</div>
</details>
<details className="product-accordion">
<summary><span>Zubereitung</span><span className="product-accordion-icon" aria-hidden="true"/></summary>
<div className="product-accordion-body">
<dl><div><dt>ZUBEREITUNG</dt><dd>Ca. 3 g Matcha mit wenig heißem Wasser (ca. 80 °C) glattrühren, dann aufgießen. Latte, iced oder pur.</dd></div></dl>
<div className="product-accordion-links"><Link className="shop-details-link" href="/our-matcha" onClick={()=>track("shop_to_matcha")}>MEHR ÜBER UNSEREN MATCHA →</Link></div>
</div>
</details>
<details className="product-accordion">
<summary><span>Versand &amp; Lieferung</span><span className="product-accordion-icon" aria-hidden="true"/></summary>
<div className="product-accordion-body">
<dl><div><dt>VERSAND</dt><dd>Deutschland: 2–4 Werktage · Andere Länder: 3–10 Werktage</dd></div></dl>
<div className="product-accordion-links"><Link className="shop-details-link" href="/versand">VERSAND & LIEFERZEITEN →</Link></div>
</div>
</details>
</div></section>}

/** Replaces the newsletter signup on /shop. A brand note, not a module:
 *  no form, no consent checkbox, no marketing promise to keep. */
function BrandNote(){
return <section className="brand-note"><div className="brand-note-inner home-rail">
<div className="brand-note-left">
<p className="eyebrow">KEIN NEWSLETTER-LÄRM</p>
<p className="brand-note-text">Wir melden uns nicht.<br/><i>Und das ist Absicht.</i></p>
</div>
<div className="brand-note-right">
<p className="brand-note-sub">Keine Rabattschreie. Kein E-Mail-Dauerfeuer.<br/>Wenn es etwas zu sagen gibt, findest du es hier.</p>
<p className="brand-note-micro">Nur GLOA.</p>
<Link className="brand-note-link" href="/contact">Fragen? Schreib uns →</Link>
</div>
</div></section>}

/**
 * The shop's launch band.
 *
 * ── ONE COUNTDOWN, ONE CLOCK, ONE LAUNCH INSTANT ──────────────
 *
 * This is a second PRESENTATION of the countdown, never a second
 * implementation: the instant comes from GLOA_LAUNCH_ISO, the
 * arithmetic from launchCountdown() and the tick from the same
 * clockStore the homepage band subscribes to, so the two can never
 * disagree and a page showing both pays for one interval.
 *
 * Everything the homepage band does about correctness holds here for the
 * same reason: the server snapshot is null so the numbers hydrate
 * instead of mismatching, the ticking row is aria-hidden rather than
 * announced once a second, and launchCountdown() clamps at zero so
 * there is no negative countdown - the launched state takes over.
 */
function ShopLaunchStrip(){
const now=useSyncExternalStore(clockStore.subscribe,clockStore.getSnapshot,clockStore.getServerSnapshot);
const state=now===null?null:launchCountdown(now);
return <section className="shop-strip" aria-label="GLOA Launch">
<div className="shop-strip-inner home-rail">
<p className="shop-strip-title">{state?.launched?"GLOA is here":"GLOA is coming"}</p>
{state?.launched
?<p className="shop-strip-live">Der Shop ist offen.</p>
:<div className="shop-strip-units" aria-hidden="true">
{([["Tage",state?.days],["Stunden",state?.hours],["Minuten",state?.minutes],["Sekunden",state?.seconds]] as const).map(([label,value])=>
<span className="shop-strip-unit" key={label}>
<b>{value===undefined?"--":padCountdownUnit(value)}</b>
<span>{label}</span>
</span>)}
</div>}
<p className="shop-strip-date">{GLOA_LAUNCH_LABEL}</p>
</div>
</section>
}

/** The supporting line, as one sentence over two rows. No dash. */
const SHOP_HERO_LEAD=<>Premium Matcha aus Shizuoka, Japan<br/>und alles, was dazugehört.</>;

/**
 * The shop hero. TYPE ONLY - no pouch, no packaging mockup, no powder.
 * The product's own photography lives in the cards below and on the
 * product page; nothing was deleted, this hero simply does not render it.
 */
function ShopHero({lead,price}:{lead:React.ReactNode;price:React.ReactNode}){
return <section className="shop-hero"><div className="shop-hero-inner home-rail">
<p className="eyebrow shop-hero-eyebrow">GLOA · SHOP</p>
<span className="shop-hero-rule" aria-hidden="true"/>
<h1 className="shop-hero-headline">
<span className="shop-hero-line">Alles von</span>
<span className="shop-hero-line">GLOA.</span>
<i className="shop-hero-line shop-hero-line-accent">alles was du brauchst.</i>
</h1>
<p className="shop-hero-lead">{lead}</p>
{price}
<p className="shop-hero-meta">LAUNCH AM {GLOA_LAUNCH_LABEL}</p>
<Link className="cta shop-hero-cta" href="#product" onClick={()=>track("shop_scroll_product")}>PRODUKTE ENTDECKEN <span aria-hidden="true">→</span></Link>
</div></section>
}

function Shop({onAdd}:{onAdd:()=>void}){
const {products,loading,error}=useCatalogList();
const shell=(lead:React.ReactNode,price:React.ReactNode)=><main className="shop-page"><ShopHero lead={lead} price={price}/><ShopLaunchStrip/></main>;

if(loading)return shell(SHOP_HERO_LEAD,<p className="shop-hero-price">Laden…</p>);
if(error)return shell("Shop vorübergehend nicht verfügbar.",null);
if(!visibleShopProducts(products).length)return shell("Aktuell keine Produkte verfügbar.",null);

// The hero's "ab" price is computed from what the page actually LISTS,
// so a hidden product cannot set the number a customer reads.
const shown=visibleShopProducts(products);
const lowestCents=Math.min(...shown.flatMap(p=>p.variants.map(x=>x.price_gross_cents)));

return <main className="shop-page">
<ShopHero lead={SHOP_HERO_LEAD} price={<p className="shop-hero-price">AB {fmtCents(lowestCents)} €</p>}/>
<ShopLaunchStrip/>

<section id="product" className="shop-products">
{shown.map(p=><article key={p.id} id={`product-${p.slug}`} className="shop-column">
<ShopProductBlock product={p} onAdd={onAdd}/>
{p.slug===MATCHA_SLUG&&<MatchaShopDetails product={p}/>}
</article>)}
</section>
</main>}

// The anti-newsletter band is NOT rendered here. It is a homepage
// statement, and /shop ends on the product it sells: hero, launch
// band, product, details, footer. The component itself is untouched
// and still runs on / and /rezepte.

// -- Product detail ---------------------------------------------------

/** GLOA Matcha's own detail page. Unchanged storytelling layout. */
function MatchaProductPage({product,onAdd}:{product:CatalogProduct;onAdd:()=>void}){
const {addItem}=useCart();
const [sizeIdx,setSizeIdx]=useState(0);
const safe=Math.min(sizeIdx,product.variants.length-1);
const v=product.variants[safe];
const per100=showsUnitPricePer100g(v)?per100gCents(v.price_gross_cents,v.size_grams as number):null;
const handleAdd=()=>{addItem({productId:product.id,productName:product.name,productSlug:product.slug,variantId:v.id,label:v.label,grams:v.size_grams,purchaseType:"once",unitPriceCents:v.price_gross_cents});track("add_to_cart");onAdd()};

return <main className="pdp">
<section className="pdp-hero"><div className="pdp-hero-image"><img src="/img/gloa-hero-packaging.jpg" alt="GLOA Matcha Verpackung"/></div><div className="pdp-hero-info"><p className="eyebrow">MATCHA · SHIZUOKA</p><h1>{PRODUCT.name}</h1><p>Für Latte, iced und pure Zubereitung.</p>

<VariantSelector product={product} selected={safe} onSelect={setSizeIdx} name="pdp-size"/>

<p className="pdp-price">{fmtCents(v.price_gross_cents)} €</p>
{per100!==null&&<p className="pdp-per100g">{fmtCents(per100)} € / 100 g</p>}

<button className="cta shop-cta" onClick={SHOP_STATUS==="prelaunch"?()=>window.location.href="/contact":handleAdd}>{SHOP_STATUS==="prelaunch"?"Fragen zum Launch":"In den Warenkorb"}</button>
</div></section>

<section className="pdp-facts"><div><p className="eyebrow">WHAT WE KNOW</p><h2>Clear facts.<br/>Nothing invented.</h2></div><dl><div><dt>LEBENSMITTELBEZEICHNUNG</dt><dd>Matcha (Grünteepulver)</dd></div><div><dt>ZUTAT</dt><dd>100 % Matcha-Grünteepulver, keine Zusätze</dd></div><div><dt>HERKUNFT</dt><dd>Shizuoka, Japan</dd></div><div><dt>VERWENDUNG</dt><dd>Latte · Iced · Pur</dd></div><div><dt>LAGERUNG</dt><dd>{PRODUCT.storage}</dd></div><div><dt>GROESSEN</dt><dd>{product.variants.map(x=>x.label).join(" · ")}</dd></div></dl><p className="product-operator-note">Lebensmittelunternehmer: Cara 2 GmbH, Hardenbergstr. 4, 10623 Berlin, Deutschland</p></section>
<HowTo/>
</main>}

/** Detail page for a non-food product. Deliberately short: name, image,
 *  description, price, variants, disclosure, buy. The long Matcha
 *  storytelling layout is not forced onto an accessory, and no food field
 *  appears anywhere. */
function AccessoryProductPage({product,onAdd}:{product:CatalogProduct;onAdd:()=>void}){
const {addItem}=useCart();
const [idx,setIdx]=useState(0);
const safe=Math.min(idx,product.variants.length-1);
const v=product.variants[safe];
const presentation=getProductPresentation(product.slug,v);
const img=getProductImage(product);
const handleAdd=()=>{addItem({productId:product.id,productName:product.name,productSlug:product.slug,variantId:v.id,label:v.label,grams:v.size_grams,purchaseType:"once",unitPriceCents:v.price_gross_cents});track("add_to_cart");onAdd()};

return <main className="pdp">
<section className="pdp-hero">
{img&&<div className="pdp-hero-image"><img src={img} alt={product.name}/></div>}
<div className="pdp-hero-info"><p className="eyebrow">{getProductEyebrow(product)}</p><h1>{product.name}</h1>
{product.short_description&&<p>{product.short_description}</p>}

<VariantSelector product={product} selected={safe} onSelect={setIdx} name={`pdp-variant-${product.slug}`}/>

<p className="pdp-price">{fmtCents(v.price_gross_cents)} €</p>
{presentation.matchaNotIncludedNotice&&<p className="product-not-included">{presentation.matchaNotIncludedNotice}</p>}

<button className="cta shop-cta" onClick={SHOP_STATUS==="prelaunch"?()=>window.location.href="/contact":handleAdd}>{SHOP_STATUS==="prelaunch"?"Fragen zum Launch":"In den Warenkorb"}</button>
</div></section>

{product.description&&<section className="pdp-facts"><div><p className="eyebrow">PRODUKT</p><h2>{product.name}</h2></div><p className="pdp-description">{product.description}</p></section>}
</main>}

/** Route entry for /shop/<slug>. Picks the layout from the catalog rather
 *  than from a hardcoded product. */
function ProductPage({slug,onAdd}:{slug:string;onAdd:()=>void}){
const {product,loading,error}=useCatalog(slug);

const shell=(message:string)=><main className="pdp"><section className="pdp-hero"><div className="pdp-hero-info"><p className="eyebrow">GLOA</p><h1>{product?.name||"Produkt"}</h1><p>{message}</p></div></section></main>;

if(loading)return shell("Laden…");
if(error||!product)return shell("Produkt vorübergehend nicht verfügbar.");
if(!product.variants.length)return shell("Aktuell nicht verfügbar.");

return showsFoodInformation(product.slug)
 ?<MatchaProductPage product={product} onAdd={onAdd}/>
 :<AccessoryProductPage product={product} onAdd={onAdd}/>}

// Unused - kept for potential future use
// function PageHero({index,eyebrow,title,text,tone}:{index:string;eyebrow:string;title:React.ReactNode;text:string;tone:string}){return <section className={`inner-hero ${tone}`}><span className="page-index">{index}</span><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="lead">{text}</p></div></section>}
const matchaFaq:[string,string][]=[
["Was ist Matcha?","Matcha ist gemahlener grüner Tee. Du trinkst dabei das fein vermahlene Blatt direkt mit, nicht nur einen Aufguss."],
["Woher kommt GLOA Matcha?","Aus Shizuoka, einer der bekanntesten Teeregionen Japans."],
["Wie schmeckt er?","Ausgewogen und cremig, mit natürlicher Süße und angenehmem Umami, dazu eine dezente, frische Herbe."],
["Kann ich ihn pur trinken?","Ja. Matcha mit wenig heißem Wasser glattrühren, aufgießen und direkt genießen."],
["Funktioniert er für Matcha Latte?","Ja. GLOA Matcha ist weich genug für den puren Genuss und gleichzeitig intensiv genug für Lattes."],
["Wie bereite ich ihn zu?","Matcha mit wenig heißem Wasser (ca. 80 °C) glattrühren, dann mit Wasser, Milch oder Pflanzendrink auffüllen, heiß oder auf Eis."],
["Enthält Matcha Koffein?","Ja, Matcha enthält von Natur aus Koffein. Wie viel genau, hängt unter anderem von Zubereitung und Dosierung ab."],
["Wie lagere ich ihn?","Kühl, trocken und lichtgeschützt. Nach dem Öffnen gut verschlossen aufbewahren."],
["Ist GLOA Matcha Bio?","Ja, unser Matcha ist Bio-zertifiziert."],
];
/**
 * The legacy plum origin section on /our-matcha.
 *
 * HIDDEN, NOT DELETED. Its eyebrow, both headline lines, both
 * paragraphs, the TikTok link and its .matcha-shizuoka styles are all
 * still here - the page just does not render it while this is false.
 * The Shizuoka story is carried by the hero map and the blue product
 * section now, so the plum block was saying it a third time.
 *
 * Typed as boolean rather than left to infer `false`, so the JSX below
 * stays type-checked instead of being narrowed away.
 */
const SHOW_LEGACY_ORIGIN_SECTION:boolean=false;

function MatchaPage(){return <main className="matcha-page">

<section className="matcha-hero"><div className="matcha-hero-inner home-rail"><div className="matcha-hero-copy"><p className="eyebrow matcha-hero-eyebrow">UNSER MATCHA</p><h1 className="matcha-hero-headline"><span className="matcha-hero-line">Matcha.</span><i className="matcha-hero-line matcha-hero-line-accent">Ohne Umwege.</i></h1><p className="matcha-hero-lead">100 % Bio-Matcha aus Shizuoka, Japan.<br/>Für Latte, pur oder iced.<br/>Klar beschrieben, nichts erfunden.</p></div><div className="matcha-hero-map"><img src="/img/Japan_Karte.png" alt="Karte von Japan mit Shizuoka markiert" fetchPriority="high"/></div></div></section>

<section className="matcha-product"><div className="matcha-product-inner home-rail"><div className="matcha-product-copy"><p className="eyebrow matcha-product-eyebrow">DAS PRODUKT</p><h2 className="matcha-product-headline"><span className="matcha-product-line">Ein Grün.</span><i className="matcha-product-line matcha-product-line-accent">Klar erklärt.</i></h2></div><div className="matcha-product-detail"><p className="matcha-product-intro">GLOA Matcha ist 100 % Bio-Matcha aus Shizuoka, Japan: fein gemahlenes Grünteepulver, kein Zusatz, keine Mischung. Die Verpackung ist licht-, luft- und feuchtigkeitsdicht, damit Farbe und Geschmack erhalten bleiben.</p><dl className="matcha-fact-grid"><div><dt>HERKUNFT</dt><dd>Shizuoka, Japan</dd></div><div><dt>QUALITÄT</dt><dd>100 % Bio-Matcha</dd></div><div><dt>VERWENDUNG</dt><dd>Latte · Iced · Pur</dd></div><div><dt>GRÖSSEN</dt><dd>30 g · 50 g · 100 g</dd></div><div><dt>LAGER</dt><dd>Deutschland</dd></div></dl><div className="matcha-taste-block"><p className="eyebrow matcha-taste-eyebrow">GESCHMACK</p><h3 className="matcha-taste-headline"><span className="matcha-taste-line">Wie schmeckt</span><i className="matcha-taste-line matcha-taste-line-accent">GLOA?</i></h3><p className="matcha-taste-body">Der Matcha zeichnet sich durch seine leuchtend grüne Farbe, feine Textur und seinen ausgewogenen Geschmack aus. Natürliche Süße und angenehmes Umami treffen auf eine dezente, frische Herbe, weich genug für den puren Genuss und gleichzeitig intensiv genug für Matcha Lattes.</p><dl className="matcha-taste-pair"><div><dt>GESCHMACK</dt><dd>Ausgewogen, cremig, leicht süßlich & umami</dd></div><div><dt>AROMA</dt><dd>Frisch, vegetal & fein</dd></div></dl></div></div></div></section>

{SHOW_LEGACY_ORIGIN_SECTION&&<section className="matcha-shizuoka"><p className="eyebrow">HERKUNFT</p><h2>Aus Shizuoka,<br/><i>Japan.</i></h2><p>Unser Matcha kommt aus Shizuoka, einer der bekanntesten Teeregionen Japans. Das Blatt wird industriell zu feinem Pulver vermahlen.</p><p className="matcha-build-note">Wir planen, Shizuoka in Zukunft selbst zu besuchen und dir mehr von dort zu zeigen.</p><Link className="cta cream" href="https://www.tiktok.com/@gloa.matcha" target="_blank" rel="noopener noreferrer">AUF TIKTOK FOLGEN ↗</Link></section>}

<section className="matcha-what"><div><p className="eyebrow">WAS IST MATCHA</p><h2>Pulver statt<br/><i>Aufguss.</i></h2><p>Matcha ist gemahlener grüner Tee. Anders als bei klassisch aufgegossenem Tee trinkst du bei Matcha das fein vermahlene Blatt direkt mit, nicht nur den Sud. Deshalb enthält Matcha von Natur aus mehr Koffein, L-Theanin und Catechine wie EGCG als ein Aufguss aus derselben Teemenge. Wie viel genau, hängt unter anderem von Anbau, Ernte, Verarbeitung und Zubereitung ab.</p></div><div className="matcha-what-img"><img src="/img/gloa-work.jpg" alt="Iced Matcha am Arbeitsplatz"/></div></section>

<section className="matcha-transparency"><div className="matcha-transparency-inner"><p className="eyebrow">MATCHA & SCIENCE</p><h2>Forschung.<br/><i>Ehrlich eingeordnet.</i></h2><p>Wir wollen nichts versprechen, was sich nicht belegen lässt. Deshalb trennen wir hier klar, was Matcha enthält, was untersucht wurde und was offen bleibt.</p><div className="matcha-science-grid"><div><h3>Was Matcha enthält</h3><p>Von Natur aus Koffein, L-Theanin und Pflanzenstoffe aus der Catechin-Gruppe wie EGCG. Weil beim Matcha das ganze Blatt getrunken wird, enthält er davon spürbar mehr als klassisch aufgegossener Grüntee.</p></div><div><h3>In Studien untersucht</h3><p>Die Kombination aus Koffein und L-Theanin wird häufig im Zusammenhang mit Aufmerksamkeit untersucht. Einzelne Übersichtsarbeiten deuten auf kurzfristige Effekte hin, die Ergebnisse sind uneinheitlich und lassen sich nicht pauschal auf ein bestimmtes Produkt übertragen.</p></div><div><h3>Was die Forschung noch nicht beantworten kann</h3><p>Für Grüntee-Catechine wurden bislang keine gesundheitsbezogenen Aussagen, etwa zu Stoffwechsel, Herz-Kreislauf oder Zellschutz, als ausreichend belegt eingestuft. Deshalb machen wir dazu keine Versprechen.</p></div></div><p className="matcha-transparency-note">Wir behaupten nichts, was wir nicht belegen können.</p></div></section>

<section className="matcha-howto"><div className="section-head"><div><p className="eyebrow">ZUBEREITUNG</p><h2>Drei Wege.<br/><i>Alle einfach.</i></h2></div></div><div className="matcha-method-grid"><article><span>01</span><h3>Matcha Latte</h3><ol><li>Ca. 3 g Matcha mit wenig heißem Wasser (ca. 80 °C) glattrühren.</li><li>Milch oder Pflanzendrink erwärmen und dazugeben.</li><li>Heiß genießen.</li></ol></article><article><span>02</span><h3>Iced Matcha</h3><ol><li>Ca. 3 g Matcha mit wenig heißem Wasser (ca. 80 °C) glattrühren.</li><li>Über Eis geben.</li><li>Kalte Milch oder Pflanzendrink dazugeben.</li></ol></article><article><span>03</span><h3>Pure Matcha</h3><ol><li>Ca. 3 g Matcha mit wenig heißem Wasser (ca. 80 °C) glattrühren.</li><li>Mit ca. 60-70 ml Wasser aufgießen.</li><li>Direkt genießen.</li></ol></article></div><p className="matcha-section-text">Mengenangaben sind Zubereitungsempfehlungen, pass sie gern an deinen Geschmack an.</p></section>

<section className="matcha-use"><p className="eyebrow">VERWENDUNG</p><h2>Latte. Iced. Pur.<br/><i>Deine Wahl.</i></h2><div className="matcha-use-grid"><div><strong>LATTE</strong><p>Mit Milch oder Pflanzendrink, warm oder kalt aufgeschäumt. Der einfachste Einstieg in den Alltag.</p></div><div><strong>ICED</strong><p>Über Eis gegossen, cremig und erfrischend. Für unterwegs oder heiße Tage.</p></div><div><strong>PUR</strong><p>Nur Matcha und Wasser. Direkt, klar, ohne Umwege.</p></div></div></section>

<section className="matcha-image"><img src="/img/gloa-iced.jpg" alt="Iced Matcha von GLOA"/></section>

<section className="matcha-storage"><p className="eyebrow">LAGERUNG</p><p>Kühl, trocken und lichtgeschützt lagern. Nach dem Öffnen gut verschlossen aufbewahren.</p></section>

<section className="faq"><p className="eyebrow">FAQ</p><h2>Fragen?<br/><i>Antworten.</i></h2>{matchaFaq.map(([q,a])=><details key={q}><summary>{q}<span>+</span></summary><p>{a}</p></details>)}</section>

<section className="matcha-cta"><p className="eyebrow">MATCHA FOR REAL LIFE.</p><h2>Bereit für<br/><i>deinen Matcha?</i></h2><div className="matcha-cta-actions"><Link className="cta" href="/shop">Zum Shop</Link><Link className="cta secondary" href="/for-cafes">B2B →</Link></div></section>
</main>}
const aboutCares:[string,string][]=[
["01","Gutes Produkt statt komplizierter Begriffe."],
["02","Klare Infos statt erfundenem Prestige."],
["03","Matcha, der pur genauso funktioniert wie als Latte."],
];
function About(){return <main className="about-page">
<section className="about-hero"><span className="page-index">03</span><div><p className="eyebrow">ÜBER GLOA</p><h1>Good energy.<br/><i>No theatre.</i></h1><p className="lead">GLOA bringt Matcha aus Shizuoka in einen Alltag, der nicht nach Regeln fragt.</p><p className="about-sub-lead">Für Latte, iced, pur oder genau so, wie du ihn magst.</p></div><div className="about-hero-micro"><span>SHIZUOKA / JAPAN</span><span>BERLIN / GERMANY</span><span>EST. 2026</span></div></section>

<section className="about-why"><div className="about-why-left"><p className="eyebrow">WHY GLOA EXISTS</p><h2>Matcha gehört<br/>nicht in eine<br/><i>Schublade.</i></h2></div><div className="about-why-right"><p>Wir mögen Matcha, aber nicht die Regeln, die manchmal darum gebaut werden.</p><p>GLOA soll unkompliziert funktionieren: im Café, im Büro, unterwegs oder zu Hause.</p><p>Kein Dresscode.<br/>Kein Pflichtprogramm.<br/>Ein gutes Produkt. Und du entscheidest, was du daraus machst.</p></div></section>

<section className="statement"><div><p className="eyebrow">MATCHA FOR REAL LIFE</p></div><h2>Nicht kompliziert.<br/><i>Einfach gut.</i></h2><p>Morgens, im Büro, im Café, unterwegs, iced oder als Latte. Dein Tag entscheidet, nicht ein Regelwerk. GLOA funktioniert überall dort, wo du gerade bist.</p></section>

<section className="about-origin"><div><p className="eyebrow">HERKUNFT</p><p>Unser Matcha kommt aus Shizuoka, Japan: 100 % Bio-Matcha, fein vermahlen.</p></div><Link className="text-link" href="/our-matcha">Unser Matcha →</Link></section>

<section className="about-cares"><p className="eyebrow">WAS UNS WICHTIG IST</p><h2>Worauf wir<br/><i>Wert legen.</i></h2><div className="about-cares-list">{aboutCares.map(([n,text])=><div key={n}><span>{n}</span><h3>{text}</h3></div>)}</div></section>

<section className="about-tiktok"><p className="eyebrow">BUILDING GLOA</p><h2>Schau vorbei,<br/><i>während es entsteht.</i></h2><p>Wir bauen GLOA gerade auf: Produkt, Packaging, Cafés und alles dazwischen. Auf TikTok zeigen wir, was hinter der Marke passiert.</p><Link className="about-handle" href="https://www.tiktok.com/@gloa.matcha" target="_blank" rel="noopener noreferrer">@gloa.matcha</Link><Link className="cta cream" href="https://www.tiktok.com/@gloa.matcha" target="_blank" rel="noopener noreferrer">Auf TikTok folgen ↗</Link><p className="about-micro">BUILDING IN PUBLIC · BERLIN · 2026</p></section>

<section className="about-final"><h2>Genug über uns.<br/><i>Zeit für Matcha.</i></h2><div className="about-final-actions"><Link className="cta cream" href="/shop">Zum Shop</Link><Link className="cta about-cta-outline" href="/our-matcha">Unser Matcha →</Link></div></section>
</main>}
function ForCafes(){useEffect(()=>track("b2b_page_view"),[]);return <main className="business"><section className="b2b-hero"><div><p className="eyebrow">GLOA FOR BUSINESS</p><h1>Matcha for<br/><i>your menu.</i></h1><p>Matcha aus Shizuoka für moderne Menüs.</p><div><Link className="cta cream" href="?intent=sample#lead" onClick={()=>track("sample_request_start")}>Sample anfragen</Link><Link className="cta b2b-outline" href="#calculator">Umsatzpotenzial berechnen →</Link></div></div><div className="b2b-visual"><div className="hero-tin"><span>GLOA</span><small>FOR BUSINESS</small></div><Placeholder/></div></section><section className="quick-facts">{["SHIZUOKA, JAPAN","LATTE · ICED · PUR","LAGER IN DEUTSCHLAND","SCHNELLE NACHBESTELLUNG","500 G · 1 KG GASTRO"].map(x=><strong key={x}>{x}</strong>)}</section><section className="behind-bar"><div><p className="eyebrow">FÜR DEINE BAR GEMACHT.</p><h2>Einfach zubereiten.<br/><i>Easy skalieren.</i></h2><p>Classic, iced, Strawberry oder pur. Ein Produkt, viele Drinks auf der Karte.</p></div><div className="servings"><span className="eyebrow servings-label">BEISPIELRECHNUNG</span><span><b>3 G</b>PRO DRINK</span><i>→</i><span><b>CA. 333</b>DRINKS / KG</span><small>Beispiel bei 3 g Matcha pro Drink.</small></div></section><BusinessCalculator/><BusinessFaq/></main>}
function BusinessFaq(){const qs:[string,string][]=[["Wo kommt GLOA Matcha her?","Shizuoka, Japan."],["Ist GLOA für Matcha Latte geeignet?","Ja. Das Produkt ist für Latte, iced und pur geeignet."],["Welche Großhandelsformate gibt es?","500 g und 1 kg Gastroformate."],["Habt ihr Lager in Deutschland?","Ja. Bestand in Deutschland."],["Wie schnell liefert ihr?","Lieferzeit und Verfügbarkeit bestätigen wir bei Bestellung."],["Wie viele Drinks bekomme ich aus 1 kg?","Abhängig von der Dosierung: Bei 2 g pro Drink ca. 500 Drinks, bei 3 g ca. 333 Drinks, bei 4 g ca. 250 Drinks. Mengenbeispiele."],["Was kostet es im Großhandel?","Unsere B2B-Konditionen werden individuell mit dir abgestimmt. Frag sie direkt über das B2B-Formular an."],["Was ist die regelmäßige Belieferung?","Ein flexibles Bezugsmodell mit monatlicher Lieferung und 5 % Preisvorteil. Mindestlaufzeit 3 Monate, danach monatlich kündbar."],["Wie funktioniert die 12-Monats-Partnerschaft?","Du vereinbarst eine monatliche Mindestabnahme für 12 Monate und erhältst 10 % Preisvorteil. Lieferung und Abrechnung erfolgen monatlich."],["Muss ich beim Jahresmodell alles im Voraus bezahlen?","Nein. Die Abrechnung erfolgt monatlich. Du zahlst nur die jeweils gelieferte Menge."],["Kann ich mehr als die vereinbarte Menge bestellen?","Ja. Zusätzliche Mengen können jederzeit angefragt werden, zum gleichen Kilopreis deines Modells."],["Was passiert, wenn ich noch nicht weiß, wie viel Matcha ich brauche?","Starte mit einer Einzelbestellung oder einem Sample. Sobald du deinen Bedarf besser einschätzen kannst, kannst du jederzeit auf ein Bezugsmodell wechseln."]];return <section className="faq"><p className="eyebrow">B2B FAQ</p><h2>Fragen?<br/><i>Antworten.</i></h2>{qs.map(([q,a])=><details key={q}><summary>{q}<span>+</span></summary><p>{a}</p></details>)}</section>}
function Rezepte(){const [filter,setFilter]=useState("ALLE");const filtered=filter==="ALLE"?recipes:recipes.filter(r=>r.tags.includes(filter));return <main className="rezepte-page">
<section className="rezepte-hero"><p className="eyebrow">GLOA · REZEPTE</p><h1>Matcha Rezepte.<br/><i>GLOA Edition.</i></h1><p className="lead">Signature Drinks. Einfach, visuell stark und passend zur GLOA-Welt.</p></section>
<section className="rezepte-filters">{ALL_TAGS.map(t=><button key={t} className={filter===t?"active":""} onClick={()=>setFilter(t)}>{t}</button>)}</section>
<section className="rezepte-grid">{filtered.map(r=><article key={r.slug} className="rezept-card"><Link href={`/rezepte/${r.slug}`}><div className="rezept-card-img"><img src={r.image} alt={r.alt} loading="lazy"/></div><div className="rezept-card-body"><p className="eyebrow">{r.category} · {r.time}</p><h2>{r.title}</h2><p className="rezept-card-excerpt">{r.excerpt}</p><span className="rezept-card-cta">Rezept ansehen →</span></div></Link></article>)}</section>
<BrandNote/>
</main>}
function RezeptDetail({slug}:{slug:string}){const r=recipes.find(x=>x.slug===slug);if(!r)return <main className="not-found"><h1>404</h1><p>Rezept nicht gefunden.</p><Link href="/rezepte">← Alle Rezepte</Link></main>;return <main className="rezept-detail">
<section className="rezept-detail-hero"><div className="rezept-detail-image"><img src={r.image} alt={r.alt}/></div><div className="rezept-detail-intro"><p className="eyebrow">{r.category} · {r.time} · {r.servings}</p><h1>{r.title}</h1><p className="rezept-detail-desc">{r.description}</p><div className="rezept-detail-tags">{r.tags.map(t=><span key={t}>{t}</span>)}</div></div></section>
<section className="rezept-detail-content"><div className="rezept-detail-ingredients"><h2>Zutaten</h2><ul>{r.ingredients.map((ing,i)=><li key={i}>{ing}</li>)}</ul></div><div className="rezept-detail-steps"><h2>Zubereitung</h2><ol>{r.steps.map((step,i)=><li key={i}><span>{String(i+1).padStart(2,"0")}</span><p>{step}</p></li>)}</ol></div></section>
<section className="rezept-detail-nav"><Link href="/rezepte">← Alle Rezepte</Link><Link href="/shop" className="cta">Matcha kaufen</Link></section>
</main>}
function Contact(){
const [status,setStatus]=useState<"idle"|"sending"|"success"|"error">("idle");
const [errorMsg,setErrorMsg]=useState("");

const handleSubmit=async(e:React.FormEvent<HTMLFormElement>)=>{
e.preventDefault();
if(status==="sending")return;
const form=e.currentTarget;
const f=new FormData(form);
setStatus("sending");setErrorMsg("");
try{
const res=await fetch("/api/contact",{
method:"POST",
headers:{"Content-Type":"application/json"},
body:JSON.stringify({
name:String(f.get("name")||""),
email:String(f.get("email")||""),
anliegen:String(f.get("anliegen")||""),
orderNumber:String(f.get("orderNumber")||""),
message:String(f.get("message")||""),
website:String(f.get("website")||""),
}),
});
const body=await res.json().catch(()=>null);
if(!res.ok){
setStatus("error");
setErrorMsg(body?.error||"Nachricht konnte nicht gesendet werden. Schreib uns direkt an info@gloamatcha.com.");
return;
}
setStatus("success");
form.reset();
}catch{
setStatus("error");
setErrorMsg("Nachricht konnte nicht gesendet werden. Schreib uns direkt an info@gloamatcha.com.");
}
};

return <main className="contact-main">
<section className="contact-hero"><p className="eyebrow">KONTAKT</p><h1>Schreib<br/><i>uns.</i></h1><p className="contact-sub">Wähl den richtigen Weg und deine Nachricht landet da, wo sie hingehört.</p></section>
<section className="contact-choices"><a href="#customer-form"><span>PRIVATKUNDE</span><h2>Fragen zu<br/>Produkt & Bestellung.</h2><b>Kontaktformular →</b></a><Link href="/for-cafes"><span>BUSINESS</span><h2>Großhandel,<br/>Samples & Cafés.</h2><b>Zum B2B-Bereich →</b></Link></section>
{status==="success"?
<section id="customer-form" className="customer-form"><p className="eyebrow">NACHRICHT GESENDET</p><p className="success-line">Danke! Wir melden uns so schnell wie möglich bei dir.</p></section>
:
<form id="customer-form" className="customer-form" onSubmit={handleSubmit}>
<p className="eyebrow">NACHRICHT SENDEN</p>
<input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" style={{position:"absolute",left:"-9999px",width:1,height:1,opacity:0}}/>
<div className="customer-form-row"><label>Name*<input required name="name" placeholder="Vor- und Nachname" maxLength={200} disabled={status==="sending"}/></label><label>E-Mail*<input required name="email" type="email" placeholder="deine@email.de" maxLength={254} disabled={status==="sending"}/></label></div>
<div className="customer-form-row"><label>Anliegen*<select required name="anliegen" defaultValue="" disabled={status==="sending"}><option value="" disabled>Bitte auswählen</option><option>Bestellung</option><option>Produkt</option><option>Abo</option><option>Sonstiges</option></select></label><label>Bestellnummer<input name="orderNumber" placeholder="Optional" maxLength={100} disabled={status==="sending"}/></label></div>
<label>Nachricht*<textarea required name="message" placeholder="Wie können wir helfen?" rows={5} minLength={10} maxLength={5000} disabled={status==="sending"}/></label>
{status==="error"&&<p className="account-error">{errorMsg}</p>}
<button className="cta" type="submit" disabled={status==="sending"}>{status==="sending"?"Wird gesendet …":"Nachricht senden"}</button>
<p className="legal-note">Lieber direkt per E-Mail? Schreib uns an <a href="mailto:info@gloamatcha.com">info@gloamatcha.com</a>.</p>
</form>
}
</main>}
function Legal({route}:{route:string}){
const title:Record<string,string>={impressum:"Impressum",datenschutz:"Datenschutz",agb:"Allgemeine Geschäftsbedingungen",widerruf:"Widerruf",versand:"Versandinformationen"};
if(route==="versand"){
const zoneLabel:Record<string,string>={germany:"Deutschland",eu:"EU",nonEuCore:"Schweiz / UK / Norwegen",restOfEurope:"Übriges Europa"};
return <main className="legal-page">
<p className="eyebrow">LEGAL</p>
<h1>{title.versand}</h1>
<div className="legal-shipping-zones">
{(Object.keys(SHIPPING_ZONES) as (keyof typeof SHIPPING_ZONES)[]).map(key=>{
const zone=SHIPPING_ZONES[key];
const pricing=SHIPPING_PRICING[key];
return <div className="legal-shipping-zone" key={key}>
<h3>{zoneLabel[key]}</h3>
<dl>
<div><dt>Lieferzeit</dt><dd>{zone.deliveryTimeLabel}</dd></div>
<div><dt>Versand</dt><dd>{fmtCents(pricing.shippingGrossCents)} €</dd></div>
{pricing.freeShippingThresholdGrossCents!==null&&<div><dt>Kostenlos ab</dt><dd>{fmtCents(pricing.freeShippingThresholdGrossCents)} €</dd></div>}
</dl>
</div>
})}
</div>
<p className="legal-note">{DELIVERY_TIME_NOTE}</p>
<p className="legal-note">{CUSTOMS_NOTE}</p>
</main>;
}
if(route==="widerruf"){
return <main className="legal-page">
<p className="eyebrow">LEGAL</p>
<h1>{title.widerruf}</h1>

<h2>Widerrufsrecht</h2>
<p>Verbraucherinnen und Verbrauchern steht ein gesetzliches Widerrufsrecht zu. Verbraucher ist jede natürliche Person, die ein Rechtsgeschäft zu Zwecken abschließt, die überwiegend weder ihrer gewerblichen noch ihrer selbständigen beruflichen Tätigkeit zugerechnet werden können.</p>
<p>Du hast das Recht, binnen vierzehn Tagen ohne Angabe von Gründen diesen Vertrag zu widerrufen.</p>
<p>Die Widerrufsfrist beträgt vierzehn Tage ab dem Tag, an dem du oder ein von dir benannter Dritter, der nicht der Beförderer ist, die Waren in Besitz genommen hat bzw. haben. Hast du in einer einheitlichen Bestellung mehrere Waren bestellt, die getrennt geliefert werden, beginnt die Frist mit dem Erhalt der letzten Ware.</p>
<p>Um dein Widerrufsrecht auszuüben, musst du uns</p>
<p>Cara 2 GmbH<br/>Hardenbergstr. 4<br/>10623 Berlin<br/>Deutschland<br/>E-Mail: <a href="mailto:info@gloamatcha.com">info@gloamatcha.com</a></p>
<p>mittels einer eindeutigen Erklärung (z. B. ein mit der Post versandter Brief oder eine E-Mail) über deinen Entschluss, diesen Vertrag zu widerrufen, informieren. Du kannst dafür das Muster-Widerrufsformular weiter unten verwenden, das ist aber nicht vorgeschrieben.</p>
<p>Zur Wahrung der Widerrufsfrist reicht es aus, dass du die Mitteilung über die Ausübung des Widerrufsrechts vor Ablauf der Widerrufsfrist absendest.</p>

<h2>Elektronische Widerrufsfunktion</h2>
<p>Für Verträge, die du über unsere Online-Benutzeroberfläche geschlossen hast, kannst du dein Widerrufsrecht zusätzlich über die elektronische Widerrufsfunktion weiter unten auf dieser Seite ausüben. Sie steht während der gesamten Widerrufsfrist zur Verfügung und ist ohne Anmeldung nutzbar, auch als Gast. Nach dem Absenden bestätigen wir dir unverzüglich auf einem dauerhaften Datenträger (in der Regel per E-Mail) den Eingang deiner Widerrufserklärung mit Inhalt, Datum und Uhrzeit.</p>

<h2>Folgen des Widerrufs</h2>
<p>Wenn du diesen Vertrag widerrufst, haben wir dir alle Zahlungen, die wir von dir erhalten haben, einschließlich der Lieferkosten (mit Ausnahme der zusätzlichen Kosten, die sich daraus ergeben, dass du eine andere Art der Lieferung als die von uns angebotene, günstigste Standardlieferung gewählt hast), unverzüglich und spätestens binnen vierzehn Tagen ab dem Tag zurückzuzahlen, an dem die Mitteilung über deinen Widerruf dieses Vertrags bei uns eingegangen ist. Für diese Rückzahlung verwenden wir dasselbe Zahlungsmittel, das du bei der ursprünglichen Transaktion eingesetzt hast, es sei denn, mit dir wurde ausdrücklich etwas anderes vereinbart; in keinem Fall werden dir wegen dieser Rückzahlung Entgelte berechnet.</p>
<p>Wir können die Rückzahlung verweigern, bis wir die Waren wieder zurückerhalten haben oder bis du den Nachweis erbracht hast, dass du die Waren zurückgesandt hast, je nachdem, welches der frühere Zeitpunkt ist.</p>
<p>Du hast die Waren unverzüglich und in jedem Fall spätestens binnen vierzehn Tagen ab dem Tag, an dem du uns über den Widerruf dieses Vertrags unterrichtest, an uns zurückzusenden oder zu übergeben. Die Frist ist gewahrt, wenn du die Waren vor Ablauf der Frist von vierzehn Tagen absendest. Du trägst die unmittelbaren Kosten der Rücksendung der Waren.</p>
<p>Du musst für einen etwaigen Wertverlust der Waren nur aufkommen, wenn dieser Wertverlust auf einen zur Prüfung der Beschaffenheit, Eigenschaften und Funktionsweise der Waren nicht notwendigen Umgang mit ihnen zurückzuführen ist.</p>

<h2>Muster-Widerrufsformular</h2>
<p>(Wenn du den Vertrag widerrufen willst, fülle bitte dieses Formular aus und sende es zurück, oder nutze die elektronische Widerrufsfunktion unten.)</p>
<p>An:<br/>Cara 2 GmbH, Hardenbergstr. 4, 10623 Berlin, Deutschland, E-Mail: info@gloamatcha.com</p>
<p>Hiermit widerrufe(n) ich/wir den von mir/uns abgeschlossenen Vertrag über den Kauf der folgenden Waren:<br/>
Bestellt am:<br/>
Name des/der Verbraucher(s):<br/>
Anschrift des/der Verbraucher(s):<br/>
Datum:</p>

<h2>Vertrag widerrufen</h2>
<p>Alternativ kannst du dein Widerrufsrecht direkt hier elektronisch ausüben (§ 356a BGB). Ein Konto ist dafür nicht nötig.</p>
<WithdrawalFunction/>
</main>;
}
if(route==="impressum"){
return <main className="legal-page">
<p className="eyebrow">LEGAL</p>
<h1>{title.impressum}</h1>
<div className="legal-placeholder">
<h2>Angaben gemäß § 5 DDG</h2>
<p>Cara 2 GmbH<br/>Hardenbergstr. 4<br/>10623 Berlin<br/>Deutschland</p>
<p>Vertreten durch: Serwan Amedi (Geschäftsführer)</p>
<p>E-Mail: <a href="mailto:info@gloamatcha.com">info@gloamatcha.com</a></p>
<p>Registergericht: Amtsgericht Charlottenburg<br/>Handelsregisternummer: HRB 278728 B</p>
<p>Umsatzsteuer-Identifikationsnummer gemäß § 27a Umsatzsteuergesetz: DE457414734</p>
</div>
</main>;
}
if(route==="datenschutz"){
return <main className="legal-page">
<p className="eyebrow">LEGAL</p>
<h1>{title.datenschutz}</h1>

<h2>1. Verantwortlicher</h2>
<p>Cara 2 GmbH<br/>Hardenbergstr. 4<br/>10623 Berlin<br/>Deutschland<br/>E-Mail: <a href="mailto:info@gloamatcha.com">info@gloamatcha.com</a></p>
<p>Für alle Anliegen zum Datenschutz erreichst du uns unter der oben genannten E-Mail-Adresse.</p>

<h2>2. Bereitstellung der Website (Hosting)</h2>
<p>Beim Aufruf dieser Website verarbeitet die Hosting-Infrastruktur, über die sie technisch bereitgestellt wird, automatisch Verbindungsdaten (u. a. IP-Adresse, Datum und Uhrzeit des Zugriffs, aufgerufene Seite, verwendeter Browser), wie es für die technisch sichere Auslieferung jeder Website zwangsläufig erforderlich ist. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an einem funktionsfähigen, sicheren Betrieb der Website).</p>

<h2>3. Kontoerstellung und Bestellung</h2>
<p>Wenn du ein GLOA-Konto erstellst oder als Gast bestellst, verarbeiten wir die dafür notwendigen Angaben (z. B. Name, Kontaktdaten, Lieferadresse, Bestellinhalt) über unseren Datenbank- und Authentifizierungs-Dienstleister Supabase. Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO (Vertragserfüllung bzw. vorvertragliche Maßnahmen). Einen Newsletter bieten wir nicht an: Es gibt weder eine Newsletter-Anmeldung noch eine entsprechende Einwilligung oder einen Newsletter-Versand. Wir verarbeiten deine E-Mail-Adresse nur für die Abwicklung deines Kontos und deiner Bestellung sowie für Nachrichten, die du uns selbst schickst.</p>

<h2>4. Zahlungsabwicklung</h2>
<p>Die Zahlungsabwicklung erfolgt über unseren Zahlungsdienstleister Stripe. Dabei werden die für die Zahlung notwendigen Daten (u. a. Bestellbetrag, Zahlungsart, Rechnungs-/Lieferadresse) an Stripe übermittelt. Stripe verarbeitet Zahlungsdaten wie Kartendaten ausschließlich auf eigenen, gesicherten Systemen; wir selbst erhalten und speichern keine vollständigen Zahlungsdaten. Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO.</p>

<h2>5. Kontaktformular, B2B-Anfrage und Bestell-/Widerrufsbestätigungen</h2>
<p>Nutzt du das Kontaktformular oder die B2B-Anfrage, verarbeiten wir deine Angaben (Name, E-Mail, Nachricht, ggf. Bestellnummer bzw. Unternehmensangaben), um deine Anfrage zu beantworten. Rechtsgrundlage ist Art. 6 Abs. 1 lit. b bzw. lit. f DSGVO. Nach einer Bestellung bzw. einem Widerruf verwenden wir dieselbe technische Anbindung, um dir eine Bestell- oder Widerrufsbestätigung zuzusenden. Für den Versand dieser E-Mails setzen wir den E-Mail-Dienstleister Resend ein.</p>

<h2>6. Cookies und lokale Speicherung</h2>
<p>Diese Website verwendet ausschließlich technisch notwendige Speicherung: den Inhalt deines Warenkorbs (lokal in deinem Browser) und, falls du dich anmeldest, deine Anmeldesitzung. Ohne diese Speicherung stünden Warenkorb und Login-Funktion nicht zur Verfügung. Rechtsgrundlage ist § 25 Abs. 2 Nr. 2 TDDDG (vormals TTDSG) in Verbindung mit Art. 6 Abs. 1 lit. b DSGVO. Es werden keine Marketing-, Analyse- oder Tracking-Cookies gesetzt und keine entsprechenden Drittanbieter-Tools eingebunden.</p>

<h2>7. Keine Analyse- oder Tracking-Tools</h2>
<p>Wir setzen aktuell keine Web-Analyse-, Tracking- oder Werbetools ein.</p>

<h2>8. Empfänger deiner Daten</h2>
<p>Im Rahmen der oben beschriebenen Zwecke geben wir Daten an folgende Dienstleister weiter, die als Auftragsverarbeiter bzw. eigenständig Verantwortliche für uns tätig werden: Supabase (Datenbank/Authentifizierung), Stripe (Zahlungsabwicklung), Resend (E-Mail-Versand) sowie den Anbieter der technischen Hosting-Infrastruktur. Eine Weitergabe darüber hinaus findet nicht statt, außer wir sind gesetzlich dazu verpflichtet.</p>

<h2>9. Speicherdauer</h2>
<p>Wir speichern personenbezogene Daten nur so lange, wie es für die genannten Zwecke erforderlich ist oder wie es gesetzliche Aufbewahrungspflichten (z. B. handels- und steuerrechtliche Vorgaben) verlangen. Die konkrete Aufbewahrungsfrist hängt von der Datenkategorie ab und wird laufend anhand dieser Vorgaben bestimmt.</p>

<h2>10. Deine Rechte</h2>
<p>Du hast das Recht auf Auskunft (Art. 15 DSGVO), Berichtigung (Art. 16 DSGVO), Löschung (Art. 17 DSGVO), Einschränkung der Verarbeitung (Art. 18 DSGVO), Datenübertragbarkeit (Art. 20 DSGVO) sowie Widerspruch gegen die Verarbeitung (Art. 21 DSGVO). Wende dich dafür an <a href="mailto:info@gloamatcha.com">info@gloamatcha.com</a>.</p>
<p>Außerdem hast du das Recht, dich bei einer Datenschutz-Aufsichtsbehörde zu beschweren, insbesondere in dem Mitgliedstaat deines Aufenthaltsorts, Arbeitsplatzes oder des Orts des mutmaßlichen Verstoßes. Für uns als Unternehmen mit Sitz in Berlin ist dies die Berliner Beauftragte für Datenschutz und Informationsfreiheit.</p>
</main>;
}
if(route==="agb"){
return <main className="legal-page">
<p className="eyebrow">LEGAL</p>
<h1>{title.agb}</h1>
<p className="legal-note">Diese AGB gelten für Bestellungen von Privatkunden (B2C) im GLOA Online-Shop. Für Geschäftskunden (GLOA for Business) gelten individuell vereinbarte Konditionen, die gesondert und vertraulich zwischen GLOA und dem jeweiligen Geschäftskunden abgestimmt werden.</p>

<h2>1. Geltungsbereich, Vertragspartner</h2>
<p>Vertragspartner ist die Cara 2 GmbH, Hardenbergstr. 4, 10623 Berlin, Deutschland (im Folgenden &bdquo;GLOA&ldquo;). Diese AGB gelten für alle Bestellungen von Waren über den GLOA Online-Shop durch Verbraucher.</p>

<h2>2. Vertragsschluss</h2>
<p>Die Darstellung der Produkte im Shop stellt kein bindendes Angebot dar, sondern eine Aufforderung zur Bestellung. Mit dem Absenden der Bestellung über die Kasse (Stripe Checkout) gibst du ein verbindliches Angebot zum Kauf der ausgewählten Waren ab. Der Kaufvertrag kommt zustande, sobald wir deine Bestellung bestätigen bzw. die Ware versenden.</p>

<h2>3. Preise und Zahlung</h2>
<p>Alle angegebenen Preise sind Endpreise. Die Zahlung erfolgt über die im Bestellvorgang angebotenen, tatsächlich verfügbaren Zahlungsarten. Der Versandpreis wird dir vor Abschluss der Bestellung gesondert ausgewiesen, siehe <Link href="/versand">Versandinformationen</Link>.</p>

<h2>4. Lieferung und Versand</h2>
<p>Es gelten die auf <Link href="/versand">/versand</Link> ausgewiesenen Liefergebiete, Versandkosten und Lieferzeiten. Nicht alle Länder werden beliefert.</p>

<h2>5. Eigentumsvorbehalt</h2>
<p>Die gelieferte Ware bleibt bis zur vollständigen Bezahlung Eigentum von GLOA.</p>

<h2>6. Gewährleistung</h2>
<p>Es gelten die gesetzlichen Gewährleistungsrechte.</p>

<h2>7. Widerrufsrecht</h2>
<p>Als Verbraucher steht dir ein gesetzliches Widerrufsrecht zu. Einzelheiten findest du in unserer <Link href="/widerruf">Widerrufsbelehrung</Link>, einschließlich der elektronischen Widerrufsfunktion.</p>

<h2>8. Haftung</h2>
<p>GLOA haftet unbeschränkt für Vorsatz und grobe Fahrlässigkeit sowie nach den gesetzlichen Vorschriften für Schäden aus der Verletzung des Lebens, des Körpers oder der Gesundheit sowie nach dem Produkthaftungsgesetz. Im Übrigen haftet GLOA im Rahmen der gesetzlichen Vorschriften.</p>

<h2>9. Vertragssprache</h2>
<p>Der Vertrag wird in deutscher Sprache geschlossen.</p>

<h2>10. Schlussbestimmungen</h2>
<p>Es gilt das Recht der Bundesrepublik Deutschland unter Ausschluss des UN-Kaufrechts; zwingende verbraucherschützende Bestimmungen deines gewöhnlichen Aufenthaltsorts bleiben unberührt. Sollte eine Bestimmung dieser AGB unwirksam sein, bleibt die Wirksamkeit der übrigen Bestimmungen unberührt.</p>
</main>;
}
return <main className="legal-page"><p className="eyebrow">LEGAL</p><h1>{title[route]||"Legal"}</h1><div className="legal-placeholder"><h2>Rechtlicher Inhalt ausstehend.</h2><p>Vor dem öffentlichen Shop-Launch muss dieser Inhalt von GLOA beziehungsweise einer qualifizierten Rechtsberatung bereitgestellt und geprüft werden.</p></div></main>}

// Electronic withdrawal function (§ 356a BGB, in force since 19 June
// 2026). Two explicit steps as required by the statute: an initial
// "Vertrag widerrufen" action, then a separate "Widerruf bestätigen"
// confirmation action. Guest-usable - no account/login/Stripe/Supabase
// identifiers are ever requested, only what § 356a Abs. 2 actually
// requires from the customer.
type WithdrawalStep="form"|"review"|"success";
function WithdrawalFunction(){
const[step,setStep]=useState<WithdrawalStep>("form");
const[name,setName]=useState("");
const[email,setEmail]=useState("");
const[orderReference,setOrderReference]=useState("");
const[scope,setScope]=useState<"whole_order"|"partial">("whole_order");
const[scopeNote,setScopeNote]=useState("");
const[customerNote,setCustomerNote]=useState("");
const[busy,setBusy]=useState(false);
const[error,setError]=useState("");
const[result,setResult]=useState<{submittedAt:string;confirmationEmailSent:boolean}|null>(null);

const startReview=(e:React.FormEvent<HTMLFormElement>)=>{
e.preventDefault();
if(!name.trim()||!email.trim()||!orderReference.trim()){setError("Bitte fülle alle Pflichtfelder aus.");return}
if(scope==="partial"&&!scopeNote.trim()){setError("Bitte gib an, welcher Teil der Bestellung widerrufen wird.");return}
setError("");
setStep("review");
};

const confirmWithdrawal=async()=>{
setBusy(true);setError("");
try{
const res=await fetch("/api/withdrawal",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name.trim(),email:email.trim(),orderReference:orderReference.trim(),scope,scopeNote:scope==="partial"?scopeNote.trim():null,customerNote:customerNote.trim()||null})});
const body=await res.json().catch(()=>null);
if(!res.ok){setError(body?.error||"Widerruf konnte nicht übermittelt werden.");setBusy(false);return}
setResult({submittedAt:body.submittedAt,confirmationEmailSent:body.confirmationEmailSent});
setStep("success");
}catch{
setError("Widerruf konnte nicht übermittelt werden. Bitte versuche es erneut oder schreib uns an info@gloamatcha.com.");
}
setBusy(false);
};

if(step==="success"&&result){
const submitted=new Date(result.submittedAt);
return <div className="legal-withdrawal">
<h3>Dein Widerruf wurde aufgenommen.</h3>
<p>Eingegangen am {submitted.toLocaleDateString("de-DE")} um {submitted.toLocaleTimeString("de-DE",{hour:"2-digit",minute:"2-digit"})} Uhr.</p>
{result.confirmationEmailSent
?<p>Eine Eingangsbestätigung haben wir an {email.trim()} gesendet.</p>
:<p>Wir konnten dir gerade keine automatische Bestätigung per E-Mail senden. Dein Widerruf ist trotzdem gespeichert - wir bestätigen dir den Eingang manuell.</p>}
</div>;
}

if(step==="review")return <div className="legal-withdrawal">
<h3>Angaben prüfen</h3>
<p>Bitte prüfe deine Angaben. Mit Klick auf &bdquo;Widerruf bestätigen&ldquo; erklärst du verbindlich den Widerruf dieses Vertrags.</p>
<dl>
<div><dt>Name</dt><dd>{name}</dd></div>
<div><dt>E-Mail für Bestätigung</dt><dd>{email}</dd></div>
<div><dt>Bestellung/Vertrag</dt><dd>{orderReference}</dd></div>
<div><dt>Umfang</dt><dd>{scope==="whole_order"?"Die gesamte Bestellung":`Nur ein Teil: ${scopeNote}`}</dd></div>
{customerNote&&<div><dt>Anmerkung</dt><dd>{customerNote}</dd></div>}
</dl>
{error&&<p className="account-error">{error}</p>}
<div className="portal-form-actions">
<button type="button" className="portal-cancel-btn" onClick={()=>setStep("form")} disabled={busy}>Zurück</button>
<button type="button" className="cta" onClick={confirmWithdrawal} disabled={busy}>{busy?"WIRD ÜBERMITTELT…":"Widerruf bestätigen"}</button>
</div>
</div>;

return <form className="account-form legal-withdrawal" onSubmit={startReview}>
<label>Name *<input required name="name" value={name} onChange={e=>setName(e.target.value)}/></label>
<label>E-Mail für die Eingangsbestätigung *<input required type="email" name="email" value={email} onChange={e=>setEmail(e.target.value)}/></label>
<label>Bestellnummer oder andere Vertragsreferenz *<input required name="orderReference" placeholder="z. B. GLOA-2026-000123" value={orderReference} onChange={e=>setOrderReference(e.target.value)}/></label>
<label>Umfang des Widerrufs *<select name="scope" value={scope} onChange={e=>setScope(e.target.value as "whole_order"|"partial")}>
<option value="whole_order">Die gesamte Bestellung</option>
<option value="partial">Nur ein Teil der Bestellung</option>
</select></label>
{scope==="partial"&&<label>Welcher Teil? *<input required name="scopeNote" placeholder="z. B. 1x GLOA Matcha 50 g" value={scopeNote} onChange={e=>setScopeNote(e.target.value)}/></label>}
<label>Anmerkung (optional)<textarea name="customerNote" value={customerNote} onChange={e=>setCustomerNote(e.target.value)}/></label>
{error&&<p className="account-error">{error}</p>}
<button className="cta account-cta" type="submit">Vertrag widerrufen</button>
</form>;
}

// B2B-Bereich: /account/business
// Geschäftskunden (customerType === "business") sehen den B2B-Menüpunkt.
// Privatkunden sehen keinen B2B-Menüpunkt.

function Account(){
const { user, loading: authLoading } = useAuth();
const [view,setView]=useState<"landing"|"login"|"choose"|"register"|"b2b-apply"|"forgot"|"confirm-pending">(()=>{if(typeof window!=="undefined"){const p=new URLSearchParams(window.location.search);if(p.get("type")==="business")return "b2b-apply";if(p.get("action")==="register")return "choose"}return "landing"});
const [pwError,setPwError]=useState("");
const [authError,setAuthError]=useState("");
const [authBusy,setAuthBusy]=useState(false);
const [forgotSent,setForgotSent]=useState(false);

const translateAuthErr=(msg:string)=>{if(msg==="Invalid login credentials")return "E-Mail oder Passwort falsch.";if(msg.includes("already registered"))return "Diese E-Mail ist bereits registriert.";if(msg.toLowerCase().includes("rate limit")||msg.includes("security purposes"))return "Zu viele Anfragen. Bitte warte einen Moment.";return msg};

// Logged-in users → dashboard
useEffect(()=>{if(!authLoading&&user)window.location.href="/account/dashboard"},[user,authLoading]);

const validatePw=(form:FormData)=>{
const pw=String(form.get("password")||"");
const pw2=String(form.get("password_confirm")||"");
if(pw.length<8){setPwError("Passwort muss mindestens 8 Zeichen lang sein.");return false}
if(pw!==pw2){setPwError("Passwörter stimmen nicht überein.");return false}
setPwError("");return true};

// Both go through the shared helper, so the two paths and the way the URL
// is built exist in exactly one place. See lib/authRedirect.ts for why a
// missing redirect is worth this much ceremony.
const confirmUrl=browserAuthRedirectUrl(AUTH_CONFIRM_PATH);
const resetUrl=browserAuthRedirectUrl(PASSWORD_RESET_PATH);

const handleLogin=async(e:React.FormEvent<HTMLFormElement>)=>{e.preventDefault();if(!supabase)return;setAuthBusy(true);setAuthError("");const f=new FormData(e.currentTarget);const{error}=await supabase.auth.signInWithPassword({email:String(f.get("email")),password:String(f.get("password"))});setAuthBusy(false);if(error){setAuthError(translateAuthErr(error.message));return}window.location.href="/account/dashboard"};

const handleForgot=async(e:React.FormEvent<HTMLFormElement>)=>{e.preventDefault();if(!supabase)return;setAuthBusy(true);setAuthError("");const f=new FormData(e.currentTarget);const{error}=await supabase.auth.resetPasswordForEmail(String(f.get("email")),{redirectTo:resetUrl});setAuthBusy(false);if(error){setAuthError(translateAuthErr(error.message));return}setForgotSent(true)};

const handlePrivate=async(e:React.FormEvent<HTMLFormElement>)=>{e.preventDefault();const f=new FormData(e.currentTarget);if(!validatePw(f))return;if(!supabase)return;setAuthBusy(true);setAuthError("");const{data,error}=await supabase.auth.signUp({email:String(f.get("email")),password:String(f.get("password")),options:{emailRedirectTo:confirmUrl,data:{customer_type:"private",first_name:String(f.get("first_name")),last_name:String(f.get("last_name")),phone:String(f.get("phone")||""),street:String(f.get("street")),house_number:String(f.get("house_number")),zip:String(f.get("zip")),city:String(f.get("city")),country:String(f.get("country")),accept_terms:true,newsletter:false}}});setAuthBusy(false);if(error){setAuthError(translateAuthErr(error.message));return}if(data.session){window.location.href="/account/dashboard"}else{setView("confirm-pending")}};

const handleB2B=async(e:React.FormEvent<HTMLFormElement>)=>{e.preventDefault();const f=new FormData(e.currentTarget);if(!validatePw(f))return;if(!supabase)return;setAuthBusy(true);setAuthError("");const{data,error}=await supabase.auth.signUp({email:String(f.get("email")),password:String(f.get("password")),options:{emailRedirectTo:confirmUrl,data:{customer_type:"business",first_name:String(f.get("contact_first_name")),last_name:String(f.get("contact_last_name")),contact_first_name:String(f.get("contact_first_name")),contact_last_name:String(f.get("contact_last_name")),phone:String(f.get("phone")||""),company_name:String(f.get("company_name")),legal_form:String(f.get("legal_form")||""),tax_number:String(f.get("tax_number")),vat_id:String(f.get("vat_id")||""),website:String(f.get("website")||""),street:String(f.get("street")),house_number:String(f.get("house_number")),zip:String(f.get("zip")),city:String(f.get("city")),country:String(f.get("country")),confirm_company_auth:!!f.get("confirm_company_auth"),accept_terms:true,newsletter:false}}});setAuthBusy(false);if(error){setAuthError(translateAuthErr(error.message));return}if(data.session){window.location.href="/account/dashboard"}else{setView("confirm-pending")}};

if(view==="confirm-pending")return <main className="account-page"><section className="account-section">
<p className="eyebrow">GLOA ACCOUNT</p>
<h1>Fast geschafft.</h1>
<p className="account-lead">Wir haben dir eine E-Mail zur Bestätigung deiner Adresse geschickt.</p>
<p className="account-confirm-hint">Prüfe dein Postfach und klicke auf den Bestätigungslink, um dein Konto zu aktivieren.</p>
<button className="cta secondary" onClick={()=>setView("login")}>Zur Anmeldung</button>
</section></main>;

if(view==="forgot")return <main className="account-page"><section className="account-section">
<button className="account-back" onClick={()=>{setView("login");setAuthError("");setForgotSent(false)}}>&#8592; Zurück</button>
<p className="eyebrow">PASSWORT ZURÜCKSETZEN</p>
<h1>Passwort<br/><i>vergessen?</i></h1>
{forgotSent?<p className="account-lead">Wir haben dir eine E-Mail gesendet. Prüfe dein Postfach.</p>:<form className="account-form" onSubmit={handleForgot}>
<label>E-Mail-Adresse<input required type="email" placeholder="deine@email.de" autoComplete="email" name="email"/></label>
{authError&&<p className="account-error">{authError}</p>}
<button className="cta account-cta" type="submit" disabled={authBusy}>{authBusy?"SENDEN…":"LINK SENDEN"}</button>
</form>}
</section></main>;

if(view==="login")return <main className="account-page"><section className="account-section">
<button className="account-back" onClick={()=>{setView("landing");setPwError("");setAuthError("")}}>&#8592; Zurück</button>
<p className="eyebrow">GLOA ACCOUNT</p>
<h1>Anmelden.</h1>
<form className="account-form" onSubmit={handleLogin}>
<label>E-Mail-Adresse<input required type="email" placeholder="deine@email.de" autoComplete="email" name="email"/></label>
<label>Passwort<input required type="password" placeholder="Passwort" autoComplete="current-password" name="password"/></label>
{authError&&<p className="account-error">{authError}</p>}
<button className="cta account-cta" type="submit" disabled={authBusy}>{authBusy?"ANMELDEN…":"Anmelden"}</button>
</form>
<button className="account-forgot" onClick={()=>{setView("forgot");setAuthError("")}}>Passwort vergessen?</button>
</section></main>;

if(view==="choose")return <main className="account-page"><section className="account-section">
<button className="account-back" onClick={()=>setView("landing")}>&#8592; Zurück</button>
<p className="eyebrow">KONTO ERSTELLEN</p>
<h1>Wie möchtest du<br/><i>GLOA nutzen?</i></h1>
<div className="account-type-grid">
<div className="account-type-card account-type-private">
<p className="eyebrow">PRIVATKUNDE</p>
<h2>Matcha für<br/>deinen Alltag.</h2>
<p>Bestellen, Abos verwalten und Rezepte speichern.</p>
<button className="cta account-type-cta" onClick={()=>{setView("register");setPwError("")}}>Privatkonto erstellen</button>
</div>
<div className="account-type-card account-type-business">
<p className="eyebrow">GESCHÄFTSKUNDE</p>
<h2>Matcha für<br/>dein Business.</h2>
<p>Großhandel, Samples und individuelle Konditionen.</p>
<button className="cta account-type-cta" onClick={()=>{setView("b2b-apply");setPwError("")}}>Geschäftskonto erstellen</button>
</div>
</div>
</section></main>;

if(view==="register")return <main className="account-page"><section className="account-section account-register">
<button className="account-back" onClick={()=>{setView("choose");setPwError("")}}>&#8592; Zurück</button>
<p className="eyebrow">PRIVATKONTO ERSTELLEN</p>
<h1>Willkommen<br/><i>bei GLOA.</i></h1>
<form className="account-form" onSubmit={handlePrivate}>
<p className="account-form-section">PERSÖNLICHE DATEN</p>
<div className="account-form-row">
<label>Vorname *<input required placeholder="Vorname" autoComplete="given-name" name="first_name"/></label>
<label>Nachname *<input required placeholder="Nachname" autoComplete="family-name" name="last_name"/></label>
</div>
<p className="account-form-section">KONTAKT</p>
<label>E-Mail-Adresse *<input required type="email" placeholder="deine@email.de" autoComplete="email" name="email"/></label>
<label>Telefonnummer<input type="tel" placeholder="Optional" autoComplete="tel" name="phone"/></label>
<p className="account-form-section">PASSWORT</p>
<div className="account-form-row">
<label>Passwort *<input required type="password" placeholder="Min. 8 Zeichen" autoComplete="new-password" name="password" minLength={8}/></label>
<label>Passwort wiederholen *<input required type="password" placeholder="Wiederholen" autoComplete="new-password" name="password_confirm" minLength={8}/></label>
</div>
<p className="account-form-section">ADRESSE</p>
<div className="account-form-row">
<label>Straße *<input required placeholder="Straße" autoComplete="address-line1" name="street"/></label>
<label>Hausnummer *<input required placeholder="Nr." autoComplete="address-line2" name="house_number"/></label>
</div>
<div className="account-form-row">
<label>PLZ *<input required placeholder="PLZ" autoComplete="postal-code" name="zip"/></label>
<label>Ort *<input required placeholder="Ort" autoComplete="address-level2" name="city"/></label>
</div>
<label>Land *<select required name="country" defaultValue="DE">{SHIPPING_COUNTRY_OPTIONS.map(c=><option key={c.code} value={c.code}>{c.label}</option>)}</select></label>
{pwError&&<p className="account-error">{pwError}</p>}
{authError&&<p className="account-error">{authError}</p>}
<label className="consent"><input required type="checkbox" name="accept_terms"/> Ich akzeptiere die <Link href="/agb">AGB</Link> und <Link href="/datenschutz">Datenschutzerklärung</Link>.</label>
<button className="cta account-cta" type="submit" disabled={authBusy}>{authBusy?"ERSTELLEN…":"Konto erstellen"}</button>
</form>
<p className="account-login-hint">Schon ein Konto? <button className="account-link-btn" onClick={()=>setView("login")}>Anmelden</button></p>
</section></main>;

if(view==="b2b-apply")return <main className="account-page"><section className="account-section account-b2b">
<button className="account-back" onClick={()=>{setView("choose");setPwError("")}}>&#8592; Zurück</button>
<p className="eyebrow">GESCHÄFTSKONTO ERSTELLEN</p>
<h1>Matcha für<br/><i>dein Business.</i></h1>
<p className="account-b2b-note">Mit einem Geschäftskonto erhältst du Zugang zum B2B-Bereich mit Preisen, Konditionen und weiteren Business-Funktionen.</p>
<form className="account-form" onSubmit={handleB2B}>
<p className="account-form-section">UNTERNEHMEN</p>
<label>Firmenname *<input required name="company_name" placeholder="Firmenname" autoComplete="organization"/></label>
<label>Rechtsform<input name="legal_form" placeholder="z. B. GmbH, UG, Einzelunternehmen" /></label>
<div className="account-form-row">
<label>Ansprechpartner Vorname *<input required name="contact_first_name" placeholder="Vorname" autoComplete="given-name"/></label>
<label>Ansprechpartner Nachname *<input required name="contact_last_name" placeholder="Nachname" autoComplete="family-name"/></label>
</div>
<p className="account-form-section">GESCHÄFTLICHER KONTAKT</p>
<label>Geschäftliche E-Mail-Adresse *<input required type="email" name="email" placeholder="business@email.de" autoComplete="email"/></label>
<label>Telefonnummer<input type="tel" name="phone" placeholder="Optional" autoComplete="tel"/></label>
<p className="account-form-section">RECHNUNGS- / GESCHÄFTSADRESSE</p>
<div className="account-form-row">
<label>Straße *<input required name="street" placeholder="Straße" autoComplete="address-line1"/></label>
<label>Hausnummer *<input required name="house_number" placeholder="Nr." autoComplete="address-line2"/></label>
</div>
<div className="account-form-row">
<label>PLZ *<input required name="zip" placeholder="PLZ" autoComplete="postal-code"/></label>
<label>Ort *<input required name="city" placeholder="Ort" autoComplete="address-level2"/></label>
</div>
<label>Land *<select required name="country" defaultValue="DE">{SHIPPING_COUNTRY_OPTIONS.map(c=><option key={c.code} value={c.code}>{c.label}</option>)}</select></label>
<p className="account-form-section">UNTERNEHMENSDATEN</p>
<div className="account-form-row">
<label>Steuernummer *<input required name="tax_number" placeholder="Steuernummer"/></label>
<label>USt-IdNr.<input name="vat_id" placeholder="Falls vorhanden"/></label>
</div>
<p className="account-form-hint">USt-IdNr. optional. Falls vorhanden.</p>
<label>Website<input type="url" name="website" placeholder="https://"/></label>
<p className="account-form-section">PASSWORT</p>
<div className="account-form-row">
<label>Passwort *<input required type="password" placeholder="Min. 8 Zeichen" autoComplete="new-password" name="password" minLength={8}/></label>
<label>Passwort wiederholen *<input required type="password" placeholder="Wiederholen" autoComplete="new-password" name="password_confirm" minLength={8}/></label>
</div>
{pwError&&<p className="account-error">{pwError}</p>}
{authError&&<p className="account-error">{authError}</p>}
<label className="consent"><input required type="checkbox" name="confirm_company_auth"/> Ich bestätige, dass ich im Namen des angegebenen Unternehmens handle.</label>
<label className="consent"><input required type="checkbox" name="accept_terms"/> Ich akzeptiere die <Link href="/agb">AGB</Link> und <Link href="/datenschutz">Datenschutzerklärung</Link>.</label>
<button className="cta account-cta" type="submit" disabled={authBusy}>{authBusy?"ERSTELLEN…":"Geschäftskonto erstellen"}</button>
</form>
<p className="account-login-hint">Schon ein Konto? <button className="account-link-btn" onClick={()=>setView("login")}>Anmelden</button></p>
</section></main>;

return <main className="account-page"><section className="account-section account-landing">
<p className="eyebrow">GLOA ACCOUNT</p>
<h1>Dein GLOA.<br/><i>An einem Ort.</i></h1>
<p className="account-lead">Bestellungen, Abos und alles rund um deinen Matcha.</p>
<div className="account-actions">
<button className="cta" onClick={()=>setView("login")}>Anmelden</button>
<button className="cta secondary" onClick={()=>setView("choose")}>Konto erstellen</button>
</div>
</section></main>;
}

// AccountBusiness moved to AccountPortal.tsx

const SHIPPING_COUNTRY_GROUPS:{label:string;codes:string[]}[]=[
{label:"Deutschland",codes:SHIPPING_ZONES.germany.countryCodes},
{label:"EU",codes:[...SHIPPING_ZONES.eu.countryCodes].sort((a,b)=>getCountryLabel(a).localeCompare(getCountryLabel(b),"de"))},
{label:"Schweiz / UK / Norwegen",codes:SHIPPING_ZONES.nonEuCore.countryCodes},
{label:"Übriges Europa",codes:[...SHIPPING_ZONES.restOfEurope.countryCodes].sort((a,b)=>getCountryLabel(a).localeCompare(getCountryLabel(b),"de"))},
];

function CartDrawer({open,onClose}:{open:boolean;onClose:()=>void}){
const cart=useCart();
const { session }=useAuth();
const closeRef=useRef<HTMLButtonElement>(null);
const [shippingCountry,setShippingCountry]=useState("DE");
const [checkoutBusy,setCheckoutBusy]=useState(false);
const [checkoutError,setCheckoutError]=useState("");

useEffect(()=>{
if(!open)return;
const prev=document.activeElement as HTMLElement|null;
document.body.style.overflow="hidden";
requestAnimationFrame(()=>closeRef.current?.focus());
const onKey=(e:KeyboardEvent)=>{if(e.key==="Escape")onClose()};
document.addEventListener("keydown",onKey);
return()=>{document.removeEventListener("keydown",onKey);document.body.style.overflow="";prev?.focus?.()};
},[open,onClose]);

if(!open)return null;

// Display-only: helps the customer see what to expect before checkout.
// Never trusted as-is - the server independently validates the country
// and recomputes the zone/price/free-shipping eligibility itself.
const zone=getShippingZone(shippingCountry);
const shippingCents=zone?computeShippingGrossCents(zone,cart.totalCents):null;
const threshold=zone?SHIPPING_PRICING[zone].freeShippingThresholdGrossCents:null;
const remainingForFreeShipping=threshold!==null?Math.max(0,threshold-cart.totalCents):null;

const handleCheckout=async()=>{
if(SHOP_STATUS==="prelaunch"){onClose();window.location.href="/contact";return}
setCheckoutBusy(true);setCheckoutError("");
try{
const requestId=crypto.randomUUID();
const{url}=await createCheckoutSession(cart.items,requestId,shippingCountry,session?.access_token);
window.location.href=url;
}catch(err){
setCheckoutError(err instanceof Error?err.message:"Checkout konnte nicht gestartet werden.");
setCheckoutBusy(false);
}
};

return <div className="cart-backdrop" onClick={onClose} onKeyDown={e=>e.key==="Escape"&&onClose()} role="button" tabIndex={0}>
{/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
<aside className="cart" onClick={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Warenkorb">
<button ref={closeRef} className="cart-close" onClick={onClose} aria-label="Warenkorb schließen">×</button>
<p className="eyebrow">WARENKORB</p>
{cart.items.length===0?<div className="cart-empty">
<h2>Dein Warenkorb<br/>ist leer.</h2>
<p>Zeit für Matcha?</p>
<Link href="/shop" className="cta" onClick={onClose}>Matcha</Link>
</div>:<>
<div className="cart-items">{cart.items.map(item=><div key={item.variantId} className="cart-item">
<div className="cart-item-info"><strong>{item.productName||PRODUCT.name}</strong><span>{item.label}</span>{item.productSlug&&getProductPresentation(item.productSlug,{size_grams:item.grams??null}).matchaNotIncluded&&<span className="cart-item-note">{MATCHA_NOT_INCLUDED_SHORT}</span>}</div>
<div className="cart-item-row">
<div className="cart-qty"><button onClick={()=>cart.updateQuantity(item.productId,item.variantId,item.quantity-1)} aria-label="Menge reduzieren">-</button><span>{item.quantity}</span><button onClick={()=>cart.updateQuantity(item.productId,item.variantId,item.quantity+1)} aria-label="Menge erhöhen">+</button></div>
<strong>{fmtCents(item.unitPriceCents*item.quantity)} €</strong>
</div>
<button className="cart-item-remove" onClick={()=>cart.removeItem(item.productId,item.variantId)} aria-label="Artikel entfernen">Entfernen</button>
</div>)}</div>
<div className="cart-shipping">
<label className="cart-shipping-label" htmlFor="cart-shipping-country">LIEFERLAND</label>
<select id="cart-shipping-country" value={shippingCountry} onChange={e=>setShippingCountry(e.target.value)}>
{SHIPPING_COUNTRY_GROUPS.map(group=><optgroup label={group.label} key={group.label}>
{group.codes.map(code=><option key={code} value={code}>{getCountryLabel(code)}</option>)}
</optgroup>)}
</select>
{zone&&<div className="cart-shipping-info">
<span>{SHIPPING_ZONES[zone].deliveryTimeLabel}</span>
<span>{shippingCents===0?"Kostenloser Versand":`${fmtCents(shippingCents??0)} € Versand`}</span>
</div>}
{remainingForFreeShipping!==null&&remainingForFreeShipping>0&&<p className="cart-shipping-hint">Noch {fmtCents(remainingForFreeShipping)} € bis zum kostenlosen Versand</p>}
{threshold!==null&&shippingCents===0&&<p className="cart-shipping-hint">Kostenloser Versand ab {fmtCents(threshold)} €</p>}
</div>
<div className="cart-footer">
<div className="cart-total"><span>SUMME</span><strong>{fmtCents(cart.totalCents)} €</strong></div>
{checkoutError&&<p className="cart-error">{checkoutError}</p>}
<button className="cta cart-checkout-cta" onClick={handleCheckout} disabled={checkoutBusy}>{checkoutBusy?"WIRD GELADEN…":SHOP_STATUS==="prelaunch"?"FRAGEN ZUM LAUNCH":"ZUR KASSE"}</button>
{SHOP_STATUS!=="prelaunch"&&<p className="cart-legal-note">Mit dem Bestellabschluss akzeptierst du unsere <Link href="/agb" onClick={onClose}>AGB</Link>. Es gilt unsere <Link href="/datenschutz" onClick={onClose}>Datenschutzerklärung</Link>. Informationen zu deinem <Link href="/widerruf" onClick={onClose}>Widerrufsrecht</Link>.</p>}
</div>
</>}
</aside></div>
}

function AuthConfirm(){
const [status,setStatus]=useState<"loading"|"success"|"error">(() => !supabase ? "error" : "loading");
useEffect(()=>{
  if(!supabase) return;
  // Supabase sends tokens in URL hash (#access_token=...&refresh_token=...)
  // or uses PKCE code in query params (?code=...)
  // supabase-js automatically picks them up via onAuthStateChange
  const params=new URLSearchParams(window.location.search);
  const hashParams=new URLSearchParams(window.location.hash.replace("#",""));
  const hasToken=hashParams.get("access_token")||params.get("code");
  if(!hasToken){
    // No token/code in URL, check if already logged in
    supabase.auth.getSession().then(({data:{session}})=>{
      if(session){window.location.href="/account/dashboard"}
      else{setStatus("error")}
    });
    return;
  }
  // Wait for onAuthStateChange to pick up the token
  const{data:{subscription}}=supabase.auth.onAuthStateChange((event,session)=>{
    if(event==="SIGNED_IN"&&session){
      setStatus("success");
      setTimeout(()=>{window.location.href="/account/dashboard"},1500);
    }
  });
  // Fallback: if tokens are in hash, getSession triggers exchange
  supabase.auth.getSession().then(({data:{session}})=>{
    if(session){setStatus("success");setTimeout(()=>{window.location.href="/account/dashboard"},1500)}
  });
  // Timeout after 10s
  const t=setTimeout(()=>setStatus(s=>s==="loading"?"error":s),10000);
  return()=>{subscription.unsubscribe();clearTimeout(t)};
},[]);
if(status==="success")return <main className="account-page"><section className="account-section"><p className="eyebrow">GLOA ACCOUNT</p><h1>E-Mail bestätigt.</h1><p className="account-lead">Dein Konto ist aktiv. Du wirst weitergeleitet…</p></section></main>;
if(status==="error")return <main className="account-page"><section className="account-section"><p className="eyebrow">GLOA ACCOUNT</p><h1>Link ungültig.</h1><p className="account-lead">Der Bestätigungslink ist ungültig oder abgelaufen.</p><Link className="cta" href="/account">Zur Anmeldung</Link></section></main>;
return <main className="account-page"><section className="account-section"><p className="eyebrow">GLOA ACCOUNT</p><h1>Verifizierung…</h1><p className="account-lead">Dein Konto wird aktiviert.</p></section></main>;
}

function ResetPassword(){
const{user,loading:authLoading}=useAuth();
const[pwError,setPwError]=useState("");
const[saving,setSaving]=useState(false);
const[done,setDone]=useState(false);

// Supabase puts the user in session after clicking the reset link (PASSWORD_RECOVERY event)
// If no user/session, the link was invalid
useEffect(()=>{
  if(!supabase)return;
  const{data:{subscription}}=supabase.auth.onAuthStateChange((event)=>{
    if(event==="PASSWORD_RECOVERY"){/* user is now set via AuthProvider */}
  });
  return()=>subscription.unsubscribe();
},[]);

const handleSubmit=async(e:React.FormEvent<HTMLFormElement>)=>{
  e.preventDefault();if(!supabase)return;
  const f=new FormData(e.currentTarget);
  const pw=String(f.get("password")||"");
  const pw2=String(f.get("password_confirm")||"");
  if(pw.length<8){setPwError("Passwort muss mindestens 8 Zeichen lang sein.");return}
  if(pw!==pw2){setPwError("Passwörter stimmen nicht überein.");return}
  setPwError("");setSaving(true);
  const{error}=await supabase.auth.updateUser({password:pw});
  setSaving(false);
  if(error){setPwError(error.message);return}
  setDone(true);
  setTimeout(()=>{window.location.href="/account/dashboard"},2000);
};

if(done)return <main className="account-page"><section className="account-section"><p className="eyebrow">GLOA ACCOUNT</p><h1>Passwort geändert.</h1><p className="account-lead">Dein neues Passwort ist aktiv. Du wirst weitergeleitet…</p></section></main>;
// The recovery session arrives asynchronously: supabase-js reads the
// token out of the URL and AuthProvider only then reports a user. Judging
// the link before that has settled would show "Link ungültig" to somebody
// holding a perfectly valid link, and a customer who reads that and
// leaves never resets their password.
if(authLoading)return <main className="account-page"><section className="account-section"><p className="eyebrow">GLOA ACCOUNT</p><h1>Einen Moment.</h1><p className="account-lead">Dein Reset-Link wird geprüft…</p></section></main>;
if(!user)return <main className="account-page"><section className="account-section"><p className="eyebrow">GLOA ACCOUNT</p><h1>Link ungültig.</h1><p className="account-lead">Der Reset-Link ist ungültig oder abgelaufen.</p><Link className="cta" href="/account">Zur Anmeldung</Link></section></main>;
return <main className="account-page"><section className="account-section"><p className="eyebrow">NEUES PASSWORT</p><h1>Passwort<br/><i>zurücksetzen.</i></h1>
<form className="account-form" onSubmit={handleSubmit}>
<label>Neues Passwort<input required type="password" placeholder="Min. 8 Zeichen" name="password" minLength={8} autoComplete="new-password"/></label>
<label>Passwort wiederholen<input required type="password" placeholder="Wiederholen" name="password_confirm" minLength={8} autoComplete="new-password"/></label>
{pwError&&<p className="account-error">{pwError}</p>}
<button className="cta account-cta" type="submit" disabled={saving}>{saving?"SPEICHERN…":"PASSWORT SPEICHERN"}</button>
</form></section></main>;
}

function GloaSiteInner({route}:{route:string}){
const cart=useCart();
const [cartOpen,setCartOpen]=useState(false);
const openCart=useCallback(()=>setCartOpen(true),[]);
const closeCart=useCallback(()=>setCartOpen(false),[]);

let page:React.ReactNode;
if(route==="home")page=<Home/>;
else if(route==="shop")page=<Shop onAdd={openCart}/>;
else if(route.startsWith("shop/"))page=<ProductPage slug={route.slice(5)==="gloa-matcha"?"matcha":route.slice(5)} onAdd={openCart}/>;
else if(route==="our-matcha")page=<MatchaPage/>;
else if(route==="about")page=<About/>;
else if(route==="for-cafes"||route==="wholesale")page=<ForCafes/>;
else if(route==="rezepte"||route==="journal")page=<Rezepte/>;
else if(route.startsWith("rezepte/"))page=<RezeptDetail slug={route.split("/")[1]}/>;
else if(route.startsWith("journal/"))page=<RezeptDetail slug={route.split("/")[1]}/>;
else if(route==="order/success")page=<OrderSuccess/>;
else if(route==="auth/confirm")page=<AuthConfirm/>;
else if(route==="account/reset-password")page=<ResetPassword/>;
else if(route.startsWith("account/orders/")&&route.split("/").length===3)page=<AccountPortal page="order-detail" orderId={route.split("/")[2]}/>;
else if(route.startsWith("account/subscriptions/")&&route.split("/").length===3)page=<AccountPortal page="subscription-detail" subscriptionId={route.split("/")[2]}/>;
else if(route.startsWith("account/business/supply/")&&route.split("/").length===4)page=<AccountPortal page="supply-detail" supplyId={route.split("/")[3]}/>;
else if(route==="account/dashboard"||route==="account/orders"||route==="account/subscriptions"||route==="account/addresses"||route==="account/profile"||route==="account/business")page=<AccountPortal page={route.split("/")[1] as "dashboard"|"orders"|"subscriptions"|"addresses"|"profile"|"business"}/>;
else if(route==="account")page=<Account/>;
else if(route==="contact")page=<Contact/>;
else if(["impressum","datenschutz","agb","widerruf","versand"].includes(route))page=<Legal route={route}/>;
else page=<main className="not-found"><h1>404</h1><Link href="/">Zurück zu GLOA →</Link></main>;

return <><Header onCart={openCart} cartCount={cart.totalCount}/>{page}<Footer/><CartDrawer open={cartOpen} onClose={closeCart}/></>
}

export function GloaSite({route}:{route:string}){
return <AuthProvider><GloaSiteInner route={route}/></AuthProvider>
}
