"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { Header, Footer, Newsletter } from "./Chrome";
import { BRAND, BUSINESS_FACTS, PRODUCT, MATCHA_VARIANTS, FLEX_DISCOUNT, ANNUAL_DISCOUNT, SHOP_STATUS, flexPrice, annualPrice, pricePer100g, lowestPrice } from "./content";
import { BusinessCalculator } from "./BusinessCalculator";
import { track } from "./analytics";
import { useCart } from "./cart";

const fmt=(n:number)=>n.toLocaleString("de-DE",{minimumFractionDigits:2,maximumFractionDigits:2});
const purchaseLabel=(t:string)=>t==="flex"?"Flex-Abo":t==="annual"?"12-Monats-Abo":"Einmal";

type Recipe={slug:string;title:string;category:string;time:string;tags:string[];image:string;alt:string;excerpt:string;description:string;ingredients:string[];steps:string[];featured:boolean};
const recipes:Recipe[]=[
{slug:"classic-matcha-latte",title:"Classic Matcha Latte",category:"REZEPT",time:"5 MIN",tags:["LATTE"],image:"/img/gloa-morning.png",alt:"Classic Matcha Latte",excerpt:"Der Klassiker. Cremig, warm und easy.",description:"Der GLOA-Klassiker. Matcha mit Milch oder Pflanzendrink, heiss oder iced, wie du magst.",ingredients:["1 TL Matcha (ca. 3\u20134 g)","30 ml heisses Wasser (ca. 80 \u00b0C)","200 ml Milch oder Pflanzendrink","Optional: Suesse nach Geschmack"],steps:["Matcha in eine Schale oder ein Glas geben.","Mit heissem Wasser uebergiessen und glatt ruehren.","Milch oder Pflanzendrink erwaermen und aufschaeumen.","Matcha in die Tasse geben, Milch darueber giessen.","Optional suessen und geniessen."],featured:true},
{slug:"iced-matcha-latte",title:"Iced Matcha Latte",category:"REZEPT",time:"4 MIN",tags:["ICED","LATTE"],image:"/img/gloa-iced.png",alt:"Iced Matcha Latte",excerpt:"Kalt, cremig und refreshing.",description:"Matcha Latte, aber kalt. Perfekt fuer warme Tage und unterwegs.",ingredients:["1 TL Matcha (ca. 3\u20134 g)","30 ml heisses Wasser (ca. 80 \u00b0C)","150\u2013200 ml kalte Milch oder Pflanzendrink","Eiswuerfel","Optional: Suesse nach Geschmack"],steps:["Matcha mit heissem Wasser glatt ruehren.","Ein Glas mit Eiswuerfeln fuellen.","Kalte Milch oder Pflanzendrink eingiessen.","Matcha langsam darueber giessen.","Optional suessen und geniessen."],featured:true},
{slug:"strawberry-matcha-latte",title:"Strawberry Matcha Latte",category:"REZEPT",time:"5 MIN",tags:["ICED","FRUITY","LATTE"],image:"/img/gloa-recipe-strawberry-matcha.png",alt:"Strawberry Matcha Latte",excerpt:"Fruchtige Erdbeere trifft auf soften Matcha.",description:"Fruchtig, cremig und sofort sommerlich. Erdbeere und Matcha funktionieren zusammen besser, als man denkt.",ingredients:["3 TL zerdrueckte oder gemixte Erdbeeren","15 ml Vanillesirup","150\u2013180 ml Milch oder Pflanzendrink","Eiswuerfel","1 TL Matcha (ca. 4 g)","60 ml Wasser zum Anruehren","Optional: Erdbeerpulver als Topping"],steps:["Erdbeeren mit Vanillesirup am Glasboden verteilen.","Eis ins Glas geben.","Milch oder Pflanzendrink einfuellen.","Matcha mit Wasser glatt ruehren.","Matcha langsam als obere Schicht eingiessen.","Optional mit Erdbeerpulver toppen."],featured:true},
{slug:"orange-zest-matcha-tonic",title:"Orange Zest Matcha Tonic",category:"REZEPT",time:"4 MIN",tags:["ICED","SPARKLING","REFRESHING"],image:"/img/gloa-recipe-orange-zest-tonic.png",alt:"Orange Zest Matcha Tonic",excerpt:"Zitrisch, sparkling und super frisch.",description:"Zitrisch, frisch und leicht bitter. Ein klarer Sommerdrink mit Matcha-Tonic-Twist.",ingredients:["30 ml Orange-Zest-Sirup oder 60 ml Orangensaft","60\u2013100 ml Tonic Water","Eiswuerfel","1 TL Matcha (ca. 4 g)","60 ml Wasser zum Anruehren","Optional: Orangenzeste"],steps:["Orange-Zest-Sirup oder Orangensaft in ein Glas geben.","Eis hinzufuegen.","Mit Tonic Water auffuellen.","Matcha mit Wasser glatt ruehren.","Langsam ueber die Eiswuerfel giessen, damit eine schoene Schichtung entsteht.","Optional mit Orangenzeste finishen."],featured:true},
{slug:"lemon-raspberry-coconut-matcha",title:"Lemon Raspberry Coconut Matcha",category:"REZEPT",time:"5 MIN",tags:["ICED","TROPICAL","FRUITY"],image:"/img/gloa-recipe-lemon-raspberry-coconut.png",alt:"Lemon Raspberry Coconut Matcha",excerpt:"Frisch, exotisch und farblich ein echter Hingucker.",description:"Frisch, leicht exotisch und visuell super stark. Zitrone, Himbeere, Kokos und Matcha in einem Drink.",ingredients:["30 ml Himbeersirup","15 ml Zitronensaft","100\u2013150 ml Kokoswasser oder leichte Kokosbasis","Eiswuerfel","1 TL Matcha (ca. 4 g)","60 ml Wasser zum Anruehren"],steps:["Himbeersirup und Zitronensaft ins Glas geben.","Eis einfuellen.","Mit Kokoswasser auffuellen.","Matcha mit Wasser glatt ruehren.","Langsam ueber das Eis giessen, damit sich die gruene Schicht oben absetzt."],featured:false},
{slug:"affogato-matcha-cloud",title:"Affogato & Matcha Cloud",category:"REZEPT",time:"5 MIN",tags:["ICED","COFFEE","MATCHA"],image:"/img/gloa-recipe-affogato-cloud.png",alt:"Affogato mit Matcha Cloud",excerpt:"Espresso, Eis und cremiger Matcha-Finish.",description:"Kraeftiger Espresso trifft auf eine cremige Matcha-Cloud. Intensiv, kuehl und perfekt fuer Coffee- und Matcha-Fans.",ingredients:["2 Shots Espresso","Eiswuerfel","1 Kugel Vanille-Gelato oder 1\u20132 TL Vanilleeis","1 TL Matcha (ca. 4\u20135 g)","2 TL Sahne oder Whipping Cream","1 TL Milch","Optional: etwas Suesse"],steps:["Espresso zubereiten und leicht abkuehlen lassen.","Ein Glas mit Eis fuellen und den Espresso eingiessen.","Fuer die Matcha-Cloud Matcha mit wenig Wasser glatt ruehren.","Sahne und Milch leicht aufschaeumen oder cremig verruehren.","Matcha unterheben und als obere Schicht auf den Espresso geben.","Optional mit Vanille-Gelato servieren."],featured:false}
];
const ALL_TAGS=["ALLE","FRUITY","COFFEE","SPARKLING","LATTE","TROPICAL","REFRESHING"];
const featuredRecipes=recipes.filter(r=>r.featured);
const dailyTiles=[{label:"MORNING",src:"/img/gloa-morning.png",alt:"Matcha am Morgen"},{label:"WORK",src:"/img/gloa-work.png",alt:"Iced Matcha am Arbeitsplatz"},{label:"CAFÉ",src:"/img/gloa-cafe.png",alt:"Matcha-Zubereitung im Café"},{label:"ON THE GO",src:"/img/gloa-on-the-go.png",alt:"Iced Matcha unterwegs in Berlin"},{label:"ICED",src:"/img/gloa-iced.png",alt:"Iced Matcha"},{label:"SOCIAL",src:"/img/gloa-social.png",alt:"Freunde mit Matcha"}];
// TODO: Replace local community items with Instagram Graph API data after account/API credentials are configured.
type CommunityItem={id:string;image:string;href?:string;alt:string}
const communityItems:CommunityItem[]=[{id:"1",image:"/img/gloa-cafe.png",alt:"Matcha-Zubereitung im Café"},{id:"2",image:"/img/gloa-on-the-go.png",alt:"Iced Matcha unterwegs in Berlin"},{id:"3",image:"/img/gloa-iced.png",alt:"Iced Matcha"},{id:"4",image:"/img/gloa-social.png",alt:"Freunde mit Matcha"},{id:"5",image:"/img/gloa-morning.png",alt:"Matcha am Morgen"},{id:"6",image:"/img/gloa-work.png",alt:"Iced Matcha am Arbeitsplatz"}];
function Placeholder({children=""}:{children?:string}){return <span className="placeholder-label">{children}</span>}
function ProductVisual(){return <div className="product-visual lime"><img src="/img/gloa-hero-packaging.png" alt="GLOA Matcha Verpackung" loading="lazy"/></div>}
function ProductCard({onAdd}:{onAdd:()=>void}){
const {addItem}=useCart();
const handleAdd=()=>{const v=MATCHA_VARIANTS[2];addItem({productId:PRODUCT.slug,variantId:v.size,grams:v.grams,purchaseType:"once",unitPrice:v.price});track("add_to_cart");onAdd()};
return <article className="product-card"><a href="/shop" onClick={()=>track("product_view")}><ProductVisual/><div className="product-info"><div><h3>{PRODUCT.name}</h3><p>{PRODUCT.origin} · LATTE + ICED + PUR</p></div><strong>AB {fmt(lowestPrice())} €</strong></div></a><button className="add" onClick={handleAdd}>In den Warenkorb <span>+</span></button></article>}
function HowTo(){return <section className="how-to"><div className="section-head"><div><p className="eyebrow">HOW TO GLOA</p><h2>Latte oder Pur.<br/>Mehr brauchst du nicht.</h2></div></div><div className="method-grid"><article><span>01</span><h3>Matcha Latte</h3><ol><li>Matcha dosieren</li><li>Mit Wasser aufschlagen</li><li>Milch oder Pflanzendrink dazu</li><li>Heiss oder iced geniessen</li></ol></article><article><span>02</span><h3>Pure Matcha</h3><ol><li>Matcha dosieren</li><li>Mit wenig Wasser glattrühren</li><li>Mit Wasser aufschlagen</li><li>Direkt geniessen</li></ol></article></div></section>}
function CommunityFeed(){const [offset,setOffset]=useState(0);const [paused,setPaused]=useState(false);const [animate,setAnimate]=useState(true);const total=communityItems.length;useEffect(()=>{const mq=window.matchMedia("(prefers-reduced-motion: reduce)");if(mq.matches)return;let visible=true;const onVis=()=>{visible=document.visibilityState==="visible"};document.addEventListener("visibilitychange",onVis);const id=setInterval(()=>{if(!paused&&visible)setOffset(p=>p+1)},4500);return()=>{clearInterval(id);document.removeEventListener("visibilitychange",onVis)}},[paused]);useEffect(()=>{if(offset>=total){const t=setTimeout(()=>{setAnimate(false);setOffset(0);requestAnimationFrame(()=>requestAnimationFrame(()=>setAnimate(true)))},400);return()=>clearTimeout(t)}},[offset,total]);const track=[...communityItems,...communityItems.slice(0,4)];return <div className="community-feed" onMouseEnter={()=>setPaused(true)} onMouseLeave={()=>setPaused(false)}><div className="community-track" style={{transform:`translateX(-${offset*25}%)`,transition:animate?"transform 400ms ease":"none"}}>{track.map((item,i)=><div key={`cf-${i}`} className="community-card"><img src={item.image} alt={item.alt} loading="lazy"/></div>)}</div></div>}

function RecipeCarousel(){
const trackRef=useRef<HTMLDivElement>(null);
const [offset,setOffset]=useState(0);
const [paused,setPaused]=useState(false);
const [dragging,setDragging]=useState(false);
const startX=useRef(0);const startOffset=useRef(0);
const items=[...featuredRecipes,...featuredRecipes];
const cardW=280;const gap=20;const step=cardW+gap;
const totalW=featuredRecipes.length*step;

useEffect(()=>{
const mq=window.matchMedia("(prefers-reduced-motion: reduce)");
if(mq.matches)return;
let visible=true;
const onVis=()=>{visible=document.visibilityState==="visible"};
document.addEventListener("visibilitychange",onVis);
const id=setInterval(()=>{if(!paused&&!dragging&&visible)setOffset(p=>{const next=p+1;return next>=totalW?0:next})},30);
return()=>{clearInterval(id);document.removeEventListener("visibilitychange",onVis)}
},[paused,dragging,totalW]);

const onPointerDown=useCallback((e:React.PointerEvent)=>{setDragging(true);startX.current=e.clientX;startOffset.current=offset;(e.target as HTMLElement).setPointerCapture(e.pointerId)},[offset]);
const onPointerMove=useCallback((e:React.PointerEvent)=>{if(!dragging)return;const dx=startX.current-e.clientX;let next=startOffset.current+dx;if(next<0)next=totalW+next;if(next>=totalW)next=next-totalW;setOffset(next)},[dragging,totalW]);
const onPointerUp=useCallback(()=>{setDragging(false)},[]);

return <section className="featured-recipes"><div className="featured-recipes-head"><div><p className="eyebrow">GLOA RECIPES</p><h2>Matcha.<br/><i>Mach was draus.</i></h2><p className="featured-recipes-sub">Unsere liebsten Matcha-Rezepte.</p></div></div>
<div className="recipe-loop" onMouseEnter={()=>setPaused(true)} onMouseLeave={()=>setPaused(false)} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} style={{touchAction:"pan-y"}}>
<div ref={trackRef} className="recipe-loop-track" style={{transform:`translateX(-${offset}px)`,transition:dragging?"none":"transform 0.5s linear",width:`${items.length*step}px`}}>
{items.map((r,i)=><a key={`rl-${i}`} href={`/rezepte/${r.slug}`} className="recipe-loop-card" draggable={false} style={{width:cardW}}>
<div className="recipe-loop-img"><img src={r.image} alt={r.alt} loading="lazy" draggable={false}/></div>
<p className="eyebrow">{r.time}</p>
<h3>{r.title}</h3>
</a>)}
</div></div>
<div className="featured-recipes-link"><a href="/rezepte">ALLE REZEPTE →</a></div>
</section>
}

function Home({onAdd}:{onAdd:()=>void}){return <main><div className="stack-pair"><section className="hero"><div className="hero-copy"><p className="eyebrow">MATCHA AUS SHIZUOKA.</p><h1>Matcha.<br/><i>Aber richtig.</i></h1><p className="lead">Aus Shizuoka, Japan. Für Latte, pur, iced oder wie du willst.</p><div className="hero-actions"><a className="cta" href="/shop" onClick={()=>track("shop_click")}>Zum Shop</a><a className="cta secondary" href="/about">GLOA entdecken →</a></div></div><div className="hero-art"><img src="/img/gloa-hero-packaging.png" alt="GLOA Matcha Verpackung" className="hero-img"/><span className="hero-micro">SHIZUOKA / JAPAN</span></div></section><section className="product-intro"><div><p className="eyebrow">MEET YOUR MATCHA.</p><h2>Ein Grün.<br/><i>Viele Momente.</i></h2><p>Aus Shizuoka, Japan. Für Matcha Latte und pur. Easy im Alltag, ehrlich im Produkt.</p><a className="cta" href="/shop">Shop GLOA</a></div><ProductCard onAdd={onAdd}/></section></div><div className="stack-pair"><section className="daily"><div className="daily-copy"><p className="eyebrow">MATCHA FÜR JEDEN TAG</p><h2>Morgens.<br/>Im Meeting.<br/><i>Nachmittags.</i></h2></div><div className="daily-grid">{dailyTiles.map(t=><div className="daily-tile" key={t.label}><img src={t.src} alt={t.alt} loading="lazy"/><span>{t.label}</span></div>)}</div></section><section className="origin"><div><p className="eyebrow">ORIGIN</p><h2>From Shizuoka,<br/><i>Japan.</i></h2></div><div><p>GLOA Matcha kommt aus Shizuoka, Japan. Mehr zum Produzenten, Cultivar und der Ernte teilen wir, sobald alles verifiziert ist.</p><dl><div><dt>ORIGIN</dt><dd>Shizuoka, Japan</dd></div><div><dt>MADE FOR</dt><dd>Latte + pure preparation</dd></div></dl></div></section></div><div className="stack-pair"><HowTo/><RecipeCarousel/></div><section className="community"><p className="eyebrow">#gloamatcha</p><h2>Zeig uns<br/><i>deinen Matcha.</i></h2><CommunityFeed/><a href={`https://instagram.com/${BRAND.instagram}`} target="_blank" rel="noopener noreferrer">@gloa.matcha folgen →</a></section><Newsletter/></main>}

function Shop({onAdd}:{onAdd:()=>void}){
const {addItem}=useCart();
const [sizeIdx,setSizeIdx]=useState(2);
const v=MATCHA_VARIANTS[sizeIdx];
const [option,setOption]=useState<"once"|"flex"|"annual">("once");
const fp=flexPrice(v.price);const ap=annualPrice(v.price);
const selectedPrice=option==="once"?v.price:option==="flex"?fp:ap;
const per100=pricePer100g(selectedPrice,v.grams);
const lowest=lowestPrice();

useEffect(()=>{if(!v.subscriptionEligible&&option!=="once")setOption("once")},[sizeIdx,v.subscriptionEligible,option]);

const handleAdd=()=>{addItem({productId:PRODUCT.slug,variantId:v.size,grams:v.grams,purchaseType:option,unitPrice:selectedPrice});track("add_to_cart");onAdd()};

const faqItems:[string,string][]=[
["Wie oft wird geliefert?","Alle Abos werden einmal im Monat geliefert. Du bekommst deinen Matcha regelmaessig, ohne selbst daran denken zu muessen."],
["Was ist das Flex-Abo?","Monatliche Lieferung, monatlich kuendbar. Du kannst jederzeit pausieren oder kuendigen, ohne Mindestlaufzeit."],
["Was ist das 12-Monats-Abo?","12 Monate Laufzeit mit dem besten Preis. Lieferung und Abrechnung erfolgen monatlich. Nach Ablauf wechselst du automatisch ins Flex-Abo."],
["Muss ich beim 12-Monats-Abo alles im Voraus bezahlen?","Nein. Die Abrechnung erfolgt monatlich. Du zahlst nur die jeweils gelieferte Menge."],
["Kann ich mein Abo pausieren?","Ja. Beim Flex-Abo kannst du jederzeit pausieren. Beim 12-Monats-Abo sind bis zu 2 Monate Pause innerhalb der Laufzeit moeglich."],
["Gibt es Abos auch fuer Merch oder Zubehoer?","Nein. Abo-Optionen gibt es nur fuer Matcha. Merch und Zubehoer sind ausschliesslich als Einzelkauf erhaeltlich."]
];
return <main className="shop-page">
<div className="stack-pair"><section className="shop-hero"><div className="shop-hero-inner"><p className="eyebrow">GLOA · MATCHA</p><h1>Dein Matcha.<br/><i>Deine Art.</i></h1><p className="lead">Matcha aus Shizuoka, Japan. Für Latte, iced, pur oder wie du ihn magst.</p><p className="shop-hero-price">AB {fmt(lowest)} €</p><p className="shop-hero-micro">Launch in Vorbereitung.</p><a className="cta secondary shop-hero-cta" href="#product" onClick={()=>track("shop_scroll_product")}>ZUM MATCHA →</a></div></section>

<section id="product" className="shop-product"><div className="shop-product-image"><img src="/img/gloa-hero-packaging.png" alt="GLOA Matcha Verpackung" loading="lazy"/></div><div className="shop-product-info"><p className="eyebrow">MATCHA</p><h2>GLOA MATCHA</h2><p className="shop-product-sub">Shizuoka, Japan · Latte · Iced · Pur</p>

<div className="size-selector" role="radiogroup" aria-label="Groesse waehlen">
{MATCHA_VARIANTS.map((mv,i)=><label key={mv.size} className={`size-option${i===sizeIdx?" active":""}`}><input type="radio" name="size" className="sr-only" value={mv.size} checked={i===sizeIdx} onChange={()=>setSizeIdx(i)}/><span className="size-option-size">{mv.size}</span><span className="size-option-price">{fmt(mv.price)} €</span></label>)}
</div>

<p className="shop-product-price">{fmt(selectedPrice)} €{option!=="once"&&<span> / Lieferung</span>}</p>
<p className="shop-product-per100g">{fmt(per100)} € / 100 g</p>

{v.subscriptionEligible?<div className="purchase-options" role="radiogroup" aria-label="Kaufoption waehlen">
<label className={`purchase-option${option==="once"?" active":""}`}><input type="radio" name="purchase-option" className="sr-only" value="once" checked={option==="once"} onChange={()=>setOption("once")}/><span className="purchase-option-head"><strong>EINMAL KAUFEN</strong><strong>{fmt(v.price)} €</strong></span><span className="purchase-option-desc">Einmalige Lieferung · Keine Bindung</span></label>
<label className={`purchase-option${option==="flex"?" active":""}`}><input type="radio" name="purchase-option" className="sr-only" value="flex" checked={option==="flex"} onChange={()=>setOption("flex")}/><span className="purchase-option-head"><strong>FLEX</strong><strong>{fmt(fp)} € <small>/ Lieferung</small></strong></span><span className="purchase-option-badge">10 % SPAREN</span><span className="purchase-option-desc">Monatlich · Kuendbar · Pausierbar</span></label>
<label className={`purchase-option${option==="annual"?" active":""}`}><input type="radio" name="purchase-option" className="sr-only" value="annual" checked={option==="annual"} onChange={()=>setOption("annual")}/><span className="purchase-option-head"><strong>12 MONATE</strong><strong>{fmt(ap)} € <small>/ Lieferung</small></strong></span><span className="purchase-option-badge">15 % SPAREN</span><span className="purchase-option-desc">12 Monate Laufzeit · Monatl. Lieferung + Abrechnung</span></label>
</div>:<p className="shop-only-once">Nur als Einzelkauf erhaeltlich.</p>}
{option==="annual"&&<p className="shop-annual-note">12 Monate Laufzeit. Lieferung und Abrechnung erfolgen monatlich.</p>}
<button className="cta shop-cta" onClick={handleAdd}>{SHOP_STATUS==="prelaunch"?"Zum Launch informieren":"In den Warenkorb"}</button>
</div></section></div>

<section className="shop-abo-explain"><div className="shop-abo-explain-inner"><p className="eyebrow">GLOA ON REPEAT</p><h2>Matcha.<br/><i>Jeden Monat.</i></h2><p className="shop-abo-lead">Du entscheidest, wie flexibel du bleiben moechtest. Wir liefern deinen Matcha einmal im Monat.</p><div className="shop-abo-grid"><article><span>01</span><div className="shop-abo-line"/><h3>EINMAL</h3><p>Einmalige Bestellung. Kein Abo, keine Bindung. Einfach Matcha bestellen.</p></article><article><span>02</span><div className="shop-abo-line"/><h3>FLEX</h3><p>Monatliche Lieferung. Jederzeit kuendbar oder pausierbar. 10 % guenstiger.</p></article><article><span>03</span><div className="shop-abo-line"/><h3>12 MONATE</h3><p>Der beste Preis. 12 Monate Laufzeit, monatliche Lieferung und Abrechnung. 15 % guenstiger.</p></article></div></div></section>

<section className="shop-details"><div className="shop-details-inner"><p className="eyebrow">PRODUKTDETAILS</p><dl><div><dt>HERKUNFT</dt><dd>Shizuoka, Japan</dd></div><div><dt>VERWENDUNG</dt><dd>Latte · Iced · Pur</dd></div><div><dt>ERNTE</dt><dd>2. und 3. Pflueckung</dd></div><div><dt>MINDESTHALTBARKEIT</dt><dd>3 Jahre</dd></div><div><dt>LAGERUNG</dt><dd>Kuehl und trocken</dd></div><div><dt>GROESSEN</dt><dd>{MATCHA_VARIANTS.map(v=>v.size).join(" · ")}</dd></div></dl><a className="shop-details-link" href="/our-matcha" onClick={()=>track("shop_to_matcha")}>MEHR UEBER UNSEREN MATCHA →</a></div></section>

<section className="shop-faq faq"><p className="eyebrow">ABO FAQ</p><h2>Fragen<br/>zum Abo?</h2>{faqItems.map(([q,a])=><details key={q}><summary>{q}<span>+</span></summary><p>{a}</p></details>)}</section>

<Newsletter/>
</main>}

function ProductPage({onAdd}:{onAdd:()=>void}){
const {addItem}=useCart();
const [sizeIdx,setSizeIdx]=useState(2);
const v=MATCHA_VARIANTS[sizeIdx];
const [option,setOption]=useState<"once"|"flex"|"annual">("once");
const fp=flexPrice(v.price);const ap=annualPrice(v.price);
const selectedPrice=option==="once"?v.price:option==="flex"?fp:ap;
const per100=pricePer100g(selectedPrice,v.grams);

useEffect(()=>{if(!v.subscriptionEligible&&option!=="once")setOption("once")},[sizeIdx,v.subscriptionEligible,option]);

const handleAdd=()=>{addItem({productId:PRODUCT.slug,variantId:v.size,grams:v.grams,purchaseType:option,unitPrice:selectedPrice});track("add_to_cart");onAdd()};

return <main className="pdp">
<section className="pdp-hero"><div className="pdp-hero-image"><img src="/img/gloa-hero-packaging.png" alt="GLOA Matcha Verpackung"/></div><div className="pdp-hero-info"><p className="eyebrow">MATCHA · SHIZUOKA</p><h1>{PRODUCT.name}</h1><p>Fuer Latte, iced und pure Zubereitung.</p>

<div className="size-selector" role="radiogroup" aria-label="Groesse waehlen">
{MATCHA_VARIANTS.map((mv,i)=><label key={mv.size} className={`size-option${i===sizeIdx?" active":""}`}><input type="radio" name="pdp-size" className="sr-only" value={mv.size} checked={i===sizeIdx} onChange={()=>setSizeIdx(i)}/><span className="size-option-size">{mv.size}</span><span className="size-option-price">{fmt(mv.price)} €</span></label>)}
</div>

<p className="pdp-price">{fmt(selectedPrice)} €{option!=="once"&&<span> / Lieferung</span>}</p>
<p className="pdp-per100g">{fmt(per100)} € / 100 g</p>

{v.subscriptionEligible?<div className="purchase-options" role="radiogroup" aria-label="Kaufoption waehlen">
<label className={`purchase-option${option==="once"?" active":""}`}><input type="radio" name="pdp-purchase" className="sr-only" value="once" checked={option==="once"} onChange={()=>setOption("once")}/><span className="purchase-option-head"><strong>EINMAL KAUFEN</strong><strong>{fmt(v.price)} €</strong></span><span className="purchase-option-desc">Einmalige Lieferung · Keine Bindung</span></label>
<label className={`purchase-option${option==="flex"?" active":""}`}><input type="radio" name="pdp-purchase" className="sr-only" value="flex" checked={option==="flex"} onChange={()=>setOption("flex")}/><span className="purchase-option-head"><strong>FLEX</strong><strong>{fmt(fp)} € <small>/ Lieferung</small></strong></span><span className="purchase-option-badge">10 % SPAREN</span><span className="purchase-option-desc">Monatlich · Kuendbar · Pausierbar</span></label>
<label className={`purchase-option${option==="annual"?" active":""}`}><input type="radio" name="pdp-purchase" className="sr-only" value="annual" checked={option==="annual"} onChange={()=>setOption("annual")}/><span className="purchase-option-head"><strong>12 MONATE</strong><strong>{fmt(ap)} € <small>/ Lieferung</small></strong></span><span className="purchase-option-badge">15 % SPAREN</span><span className="purchase-option-desc">12 Monate Laufzeit · Monatl. Lieferung + Abrechnung</span></label>
</div>:<p className="shop-only-once">Nur als Einzelkauf erhaeltlich.</p>}

<button className="cta shop-cta" onClick={handleAdd}>{SHOP_STATUS==="prelaunch"?"Zum Launch informieren":"In den Warenkorb"}</button>
</div></section>

<section className="pdp-facts"><div><p className="eyebrow">WHAT WE KNOW</p><h2>Clear facts.<br/>Nothing invented.</h2></div><dl><div><dt>HERKUNFT</dt><dd>Shizuoka, Japan</dd></div><div><dt>VERWENDUNG</dt><dd>Latte · Iced · Pur</dd></div><div><dt>LAGERUNG</dt><dd>{PRODUCT.storage}</dd></div><div><dt>GROESSEN</dt><dd>{MATCHA_VARIANTS.map(v=>v.size).join(" · ")}</dd></div></dl></section>
<HowTo/>
</main>}

function PageHero({index,eyebrow,title,text,tone}:{index:string;eyebrow:string;title:React.ReactNode;text:string;tone:string}){return <section className={`inner-hero ${tone}`}><span className="page-index">{index}</span><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="lead">{text}</p></div></section>}
function MatchaPage(){return <main className="matcha-page">
<div className="stack-pair"><section className="matcha-hero"><div className="matcha-hero-copy"><p className="eyebrow">UNSER MATCHA</p><h1>Aus Shizuoka.<br/><i>Für deinen Alltag.</i></h1><p className="lead">Was wir über unser Produkt wissen. Was wir noch nicht sagen können. Keine erfundenen Claims. Kein Marketing-Bullshit.</p></div><div className="matcha-hero-visual"><img src="/img/gloa-hero-packaging.png" alt="GLOA Matcha Verpackung"/></div></section>
<section className="matcha-facts"><p className="eyebrow">THE FACTS</p><h2>Was wir<br/><i>wissen.</i></h2><div className="matcha-facts-grid"><div><span>HERKUNFT</span><strong>Shizuoka, Japan</strong></div><div><span>ERNTE</span><strong>2. und 3. Pflueckung</strong></div><div><span>VERWENDUNG</span><strong>Latte · Iced · Pur</strong></div><div><span>MINDESTHALTBARKEIT</span><strong>3 Jahre</strong></div><div><span>LAGERUNG</span><strong>Kuehl und trocken</strong></div><div><span>LAGER</span><strong>Deutschland</strong></div></div><div className="matcha-facts-secondary"><p>GASTRO-FORMATE · 500 g · 1 kg</p><p>MAHLUNG · Industriell · ca. 6 Monate vor Kauf</p></div></section></div>
<div className="stack-pair"><section className="matcha-transparency"><div className="matcha-transparency-inner"><p className="eyebrow">TRANSPARENZ</p><h2>Was wir noch<br/><i>prüfen.</i></h2><p>Einige Details zum Produkt sind noch nicht vollständig verifiziert. Sobald sie bestätigt sind, ergänzen wir sie hier.</p><div className="matcha-pending-grid">{[["PRODUZENT / FARM","IN PRÜFUNG"],["CULTIVAR","IN PRÜFUNG"],["SINGLE CULTIVAR / BLEND","IN PRÜFUNG"],["GESCHMACKSPROFIL","IN PRÜFUNG"],["BIO-STATUS","IN PRÜFUNG"],["PRODUKTSPEZIFIKATION","IN PRÜFUNG"],["CHARGENANALYSE / COA","IN PRÜFUNG"],["PESTIZIDRÜCKSTÄNDE","UNTERLAGEN IN PRÜFUNG"],["MIKROBIOLOGISCHE ANALYSE","UNTERLAGEN IN PRÜFUNG"],["SCHWERMETALLANALYSE","UNTERLAGEN IN PRÜFUNG"],["MAHLVERFAHREN – DETAILS","IN PRÜFUNG"],["ERNTE- / PRODUKTIONSDATEN","IN PRÜFUNG"]].map(([label,status])=><div key={label}><span>{label}</span><strong>○ {status}</strong></div>)}</div><div className="matcha-price-note"><span>ENDKUNDENPREIS</span><strong>AB {fmt(lowestPrice())} €</strong></div><p className="matcha-transparency-note">Wir erfinden nichts. Was hier steht, ist geprüft.</p></div></section>
<section className="matcha-howto"><div className="section-head"><div><p className="eyebrow">HOW TO GLOA</p><h2>Drei Wege.<br/><i>Alle easy.</i></h2></div></div><div className="matcha-method-grid"><article><span>01</span><h3>Matcha Latte</h3><ol><li>Matcha dosieren</li><li>Mit wenig Wasser glatt ruehren</li><li>Milch oder Pflanzendrink dazu</li><li>Heiss geniessen</li></ol></article><article><span>02</span><h3>Iced Matcha</h3><ol><li>Matcha dosieren</li><li>Mit wenig Wasser glatt ruehren</li><li>Ueber Eis geben</li><li>Milch oder Pflanzendrink dazu</li></ol></article><article><span>03</span><h3>Pure Matcha</h3><ol><li>Matcha dosieren</li><li>Mit wenig Wasser glatt ruehren</li><li>Mit Wasser auffuellen</li><li>Direkt geniessen</li></ol></article></div></section></div>
<section className="matcha-image"><img src="/img/gloa-iced.png" alt="Iced Matcha von GLOA"/></section>
<section className="matcha-cta"><h2>Bereit?</h2><div className="matcha-cta-actions"><a className="cta" href="/shop">Zum Shop</a><a className="cta secondary" href="/for-cafes">B2B →</a></div></section>
</main>}
function About(){return <main className="about-page">
<div className="stack-pair"><section className="about-hero"><span className="page-index">03</span><div><p className="eyebrow">ÜBER GLOA</p><h1>Good energy.<br/><i>No theatre.</i></h1><p className="lead">GLOA bringt Matcha aus Shizuoka in einen Alltag, der nicht nach Regeln fragt.</p><p className="about-sub-lead">Für Latte, iced, pur oder genau so, wie du ihn magst.</p></div><div className="about-hero-micro"><span>SHIZUOKA / JAPAN</span><span>BERLIN / GERMANY</span><span>EST. 2026</span></div></section>
<section className="about-beliefs"><p className="eyebrow">WE BELIEVE IN</p><div className="about-beliefs-grid"><div className="about-belief"><span>01</span><h2>Gutes Produkt<br/>statt Hype.</h2></div><div className="about-belief"><span>02</span><h2>Echte Leute<br/>statt Bullshit.</h2></div><div className="about-belief accent"><span>03</span><h2>Matcha, der<br/><i>einfach Spass macht.</i></h2></div></div></section></div>
<section className="about-why"><div className="about-why-left"><p className="eyebrow">WHY GLOA EXISTS</p><h2>Matcha gehört<br/>nicht in eine<br/><i>Schublade.</i></h2></div><div className="about-why-right"><p>Wir mögen Matcha, aber nicht die Regeln, die manchmal darum gebaut werden.</p><p>GLOA soll unkompliziert funktionieren: im Café, im Büro, unterwegs oder zu Hause.</p><p>Kein Dresscode.<br/>Kein Ritual-Zwang.<br/>Ein gutes Produkt und du entscheidest, was du daraus machst.</p></div></section>
<section className="about-founders"><p className="eyebrow">BEHIND GLOA</p><h2>Vali <span className="about-x">×</span> Poli.</h2><p className="about-founders-lead">Wir bauen GLOA gemeinsam auf.</p><div className="about-founders-text"><p>Von Produkt und Packaging über Brand, Website und Cafés bis zum Launch: GLOA entsteht gerade Schritt für Schritt.</p><p>Wir wollen dabei nicht so tun, als wäre schon alles fertig. Du kannst dabei sein, während es entsteht.</p></div></section>
<div className="stack-pair"><section className="about-tiktok"><p className="eyebrow">BUILDING GLOA</p><h2>Begleite uns<br/><i>auf dem Weg.</i></h2><p>Wir bauen GLOA gerade auf.</p><p>Packaging, Produkt, Cafés, Launch und alles dazwischen. Auf TikTok zeigen wir, was hinter der Marke passiert.</p><a className="about-handle" href="https://www.tiktok.com/@gloa.matcha" target="_blank" rel="noopener noreferrer">@gloa.matcha</a><a className="cta cream" href="https://www.tiktok.com/@gloa.matcha" target="_blank" rel="noopener noreferrer">Auf TikTok folgen ↗</a><p className="about-micro">BUILDING IN PUBLIC · BERLIN · 2026</p></section>
<section className="about-final"><h2>Genug über uns.<br/><i>Zeit für Matcha.</i></h2><div className="about-final-actions"><a className="cta cream" href="/shop">Zum Shop</a><a className="cta about-cta-outline" href="/our-matcha">Unser Matcha →</a></div></section></div>
</main>}
function ForCafes(){useEffect(()=>track("b2b_page_view"),[]);return <main className="business"><div className="stack-pair"><section className="b2b-hero"><div><p className="eyebrow">GLOA FOR BUSINESS</p><h1>Matcha for<br/><i>your menu.</i></h1><p>Matcha aus Shizuoka für moderne Menüs.</p><div><a className="cta cream" href="?intent=sample#lead" onClick={()=>track("sample_request_start")}>Sample anfragen</a><a className="cta b2b-outline" href="#calculator">Umsatzpotenzial berechnen →</a></div></div><div className="b2b-visual"><div className="hero-tin"><span>GLOA</span><small>FOR BUSINESS</small></div><Placeholder/></div></section><section className="quick-facts">{["SHIZUOKA, JAPAN","LATTE · ICED · PUR","LAGER IN DEUTSCHLAND","SCHNELLE NACHBESTELLUNG","500 G · 1 KG GASTRO"].map(x=><strong key={x}>{x}</strong>)}</section></div><section className="behind-bar"><div><p className="eyebrow">FÜR DEINE BAR GEMACHT.</p><h2>Einfach zubereiten.<br/><i>Easy skalieren.</i></h2><p>Classic, iced, Strawberry oder pur. Ein Produkt, viele Drinks auf der Karte.</p></div><div className="servings"><span className="eyebrow servings-label">BEISPIELRECHNUNG</span><span><b>3 G</b>PRO DRINK</span><i>→</i><span><b>CA. 333</b>DRINKS / KG</span><small>Beispiel bei 3 g Matcha pro Drink.</small></div></section><BusinessCalculator/><BusinessFaq/></main>}
function BusinessFaq(){const qs:[string,string][]=[["Wo kommt GLOA Matcha her?","Shizuoka, Japan."],["Ist GLOA fuer Matcha Latte geeignet?","Ja. Das Produkt ist fuer Latte, iced und pur geeignet."],["Welche Grosshandelsformate gibt es?","500 g und 1 kg Gastroformate."],["Habt ihr Lager in Deutschland?","Ja. Bestand in Deutschland."],["Wie schnell liefert ihr?","Lieferzeit und Verfuegbarkeit bestaetigen wir bei Bestellung."],["Wie viele Drinks bekomme ich aus 1 kg?","Abhaengig von der Dosierung: Bei 2 g pro Drink ca. 500 Drinks, bei 3 g ca. 333 Drinks, bei 4 g ca. 250 Drinks. Mengenbeispiele."],["Was kostet es im Grosshandel?","Unsere B2B-Konditionen werden individuell mit dir abgestimmt. Frag sie direkt ueber das B2B-Formular an."],["Was ist die regelmaessige Belieferung?","Ein flexibles Bezugsmodell mit monatlicher Lieferung und 5 % Preisvorteil. Mindestlaufzeit 3 Monate, danach monatlich kuendbar."],["Wie funktioniert die 12-Monats-Partnerschaft?","Du vereinbarst eine monatliche Mindestabnahme fuer 12 Monate und erhaeltst 10 % Preisvorteil. Lieferung und Abrechnung erfolgen monatlich."],["Muss ich beim Jahresmodell alles im Voraus bezahlen?","Nein. Die Abrechnung erfolgt monatlich. Du zahlst nur die jeweils gelieferte Menge."],["Kann ich mehr als die vereinbarte Menge bestellen?","Ja. Zusaetzliche Mengen koennen jederzeit angefragt werden, zum gleichen Kilopreis deines Modells."],["Was passiert, wenn ich noch nicht weiss, wie viel Matcha ich brauche?","Starte mit einer Einzelbestellung oder einem Sample. Sobald du deinen Bedarf besser einschaetzen kannst, kannst du jederzeit auf ein Bezugsmodell wechseln."]];return <section className="faq"><p className="eyebrow">B2B FAQ</p><h2>Fragen?<br/><i>Antworten.</i></h2>{qs.map(([q,a])=><details key={q}><summary>{q}<span>+</span></summary><p>{a}</p></details>)}</section>}
function Rezepte(){const [filter,setFilter]=useState("ALLE");const filtered=filter==="ALLE"?recipes:recipes.filter(r=>r.tags.includes(filter));return <main className="rezepte-page">
<section className="rezepte-hero"><p className="eyebrow">GLOA · REZEPTE</p><h1>Matcha Rezepte.<br/><i>GLOA Edition.</i></h1><p className="lead">Signature Drinks. Einfach, visuell stark und passend zur GLOA-Welt.</p></section>
<section className="rezepte-filters">{ALL_TAGS.map(t=><button key={t} className={filter===t?"active":""} onClick={()=>setFilter(t)}>{t}</button>)}</section>
<section className="rezepte-grid">{filtered.map(r=><article key={r.slug} className="rezept-card"><a href={`/rezepte/${r.slug}`}><div className="rezept-card-img"><img src={r.image} alt={r.alt} loading="lazy"/></div><div className="rezept-card-body"><p className="eyebrow">{r.category} · {r.time}</p><h2>{r.title}</h2><p className="rezept-card-excerpt">{r.excerpt}</p><span className="rezept-card-cta">Rezept ansehen →</span></div></a></article>)}</section>
<Newsletter/>
</main>}
function RezeptDetail({slug}:{slug:string}){const r=recipes.find(x=>x.slug===slug);if(!r)return <main className="not-found"><h1>404</h1><p>Rezept nicht gefunden.</p><a href="/rezepte">← Alle Rezepte</a></main>;return <main className="rezept-detail">
<div className="stack-pair"><section className="rezept-detail-hero"><div className="rezept-detail-image"><img src={r.image} alt={r.alt}/></div><div className="rezept-detail-intro"><p className="eyebrow">{r.category} · {r.time}</p><h1>{r.title}</h1><p className="rezept-detail-desc">{r.description}</p><div className="rezept-detail-tags">{r.tags.map(t=><span key={t}>{t}</span>)}</div></div></section>
<section className="rezept-detail-content"><div className="rezept-detail-ingredients"><h2>Zutaten</h2><ul>{r.ingredients.map((ing,i)=><li key={i}>{ing}</li>)}</ul></div><div className="rezept-detail-steps"><h2>Zubereitung</h2><ol>{r.steps.map((step,i)=><li key={i}><span>{String(i+1).padStart(2,"0")}</span><p>{step}</p></li>)}</ol></div></section></div>
<section className="rezept-detail-nav"><a href="/rezepte">← Alle Rezepte</a><a href="/shop" className="cta">Matcha kaufen</a></section>
</main>}
function Contact(){return <main className="inner"><PageHero index="05" eyebrow="KONTAKT" title={<>Schreib<br/><i>uns.</i></>} text="Waehl den richtigen Weg und deine Nachricht landet da, wo sie hingehoert." tone="contact"/><section className="contact-choices"><a href="#customer"><span>KUNDE</span><h2>Fragen zu<br/>Produkt & Bestellung.</h2><b>Schreib uns</b></a><a href="/for-cafes"><span>BUSINESS</span><h2>Grosshandel,<br/>Samples & Cafés.</h2><b>Zum B2B-Bereich →</b></a></section><form id="customer" className="customer-form" onSubmit={e=>e.preventDefault()}><label>Name<input required/></label><label>E-Mail<input required type="email"/></label><label>Nachricht<textarea required/></label><button className="cta">Nachricht senden</button></form></main>}
function Legal({route}:{route:string}){const title:Record<string,string>={impressum:"Impressum",datenschutz:"Datenschutz",agb:"Allgemeine Geschaeftsbedingungen",widerruf:"Widerruf",versand:"Versandinformationen"};return <main className="legal-page"><p className="eyebrow">LEGAL</p><h1>{title[route]||"Legal"}</h1><div className="legal-placeholder"><h2>Rechtlicher Inhalt ausstehend.</h2><p>Vor dem oeffentlichen Shop-Launch muss dieser Inhalt von GLOA beziehungsweise einer qualifizierten Rechtsberatung bereitgestellt und geprüft werden.</p></div></main>}

function CartDrawer({open,onClose}:{open:boolean;onClose:()=>void}){
const cart=useCart();
const closeRef=useRef<HTMLButtonElement>(null);

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

return <div className="cart-backdrop" onClick={onClose}><aside className="cart" onClick={e=>e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Warenkorb">
<button ref={closeRef} className="cart-close" onClick={onClose} aria-label="Warenkorb schliessen">×</button>
<p className="eyebrow">WARENKORB</p>
{cart.items.length===0?<div className="cart-empty">
<h2>Dein Warenkorb<br/>ist leer.</h2>
<p>Zeit für Matcha?</p>
<a href="/shop" className="cta" onClick={onClose}>Matcha →</a>
</div>:<>
<div className="cart-items">{cart.items.map(item=><div key={`${item.variantId}-${item.purchaseType}`} className="cart-item">
<div className="cart-item-info"><strong>GLOA Matcha</strong><span>{item.grams} g · {purchaseLabel(item.purchaseType)}</span></div>
<div className="cart-item-row">
<div className="cart-qty"><button onClick={()=>cart.updateQuantity(item.productId,item.variantId,item.purchaseType,item.quantity-1)} aria-label="Menge reduzieren">-</button><span>{item.quantity}</span><button onClick={()=>cart.updateQuantity(item.productId,item.variantId,item.purchaseType,item.quantity+1)} aria-label="Menge erhoehen">+</button></div>
<strong>{fmt(item.unitPrice*item.quantity)} €</strong>
</div>
<button className="cart-item-remove" onClick={()=>cart.removeItem(item.productId,item.variantId,item.purchaseType)} aria-label="Artikel entfernen">Entfernen</button>
</div>)}</div>
<div className="cart-footer"><div className="cart-total"><span>SUMME</span><strong>{fmt(cart.totalPrice)} €</strong></div></div>
</>}
</aside></div>
}

export function GloaSite({route}:{route:string}){
const cart=useCart();
const [cartOpen,setCartOpen]=useState(false);
const openCart=useCallback(()=>setCartOpen(true),[]);
const closeCart=useCallback(()=>setCartOpen(false),[]);

let page:React.ReactNode;
if(route==="home")page=<Home onAdd={openCart}/>;
else if(route==="shop")page=<Shop onAdd={openCart}/>;
else if(route==="shop/gloa-matcha"||route==="shop/matcha")page=<ProductPage onAdd={openCart}/>;
else if(route==="our-matcha")page=<MatchaPage/>;
else if(route==="about")page=<About/>;
else if(route==="for-cafes"||route==="wholesale")page=<ForCafes/>;
else if(route==="rezepte"||route==="journal")page=<Rezepte/>;
else if(route.startsWith("rezepte/"))page=<RezeptDetail slug={route.split("/")[1]}/>;
else if(route.startsWith("journal/"))page=<RezeptDetail slug={route.split("/")[1]}/>;
else if(route==="contact")page=<Contact/>;
else if(["impressum","datenschutz","agb","widerruf","versand"].includes(route))page=<Legal route={route}/>;
else page=<main className="not-found"><h1>404</h1><a href="/">Zurück zu GLOA →</a></main>;

return <><Header onCart={openCart} cartCount={cart.totalCount}/>{page}<Footer/><CartDrawer open={cartOpen} onClose={closeCart}/></>
}
