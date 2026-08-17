"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { Header, Footer, Newsletter } from "./Chrome";
import { BRAND, BUSINESS_FACTS, PRODUCT, MATCHA_VARIANTS, FLEX_DISCOUNT, ANNUAL_DISCOUNT, SHOP_STATUS, flexPrice, annualPrice, pricePer100g, lowestPrice, B2B_BUSINESS_TYPES, B2B_DEMAND_OPTIONS, COUNTRIES } from "./content";
import { BusinessCalculator } from "./BusinessCalculator";
import { track } from "./analytics";
import { useCart } from "./cart";

const fmt=(n:number)=>n.toLocaleString("de-DE",{minimumFractionDigits:2,maximumFractionDigits:2});
const purchaseLabel=(t:string)=>t==="flex"?"Flex-Abo":t==="annual"?"12-Monats-Abo":"Einmal";

type Recipe={slug:string;title:string;category:string;time:string;tags:string[];image:string;alt:string;excerpt:string;description:string;ingredients:string[];steps:string[];featured:boolean};
const recipes:Recipe[]=[
{slug:"classic-matcha-latte",title:"Classic Matcha Latte",category:"REZEPT",time:"5 MIN",tags:["LATTE"],image:"/img/gloa-morning.png",alt:"Classic Matcha Latte",excerpt:"Der Klassiker. Cremig, warm und easy.",description:"Der GLOA-Klassiker. Matcha mit Milch oder Pflanzendrink, heiß oder iced, wie du magst.",ingredients:["1 TL Matcha (ca. 3\u20134 g)","30 ml heißes Wasser (ca. 80 \u00b0C)","200 ml Milch oder Pflanzendrink","Optional: Süße nach Geschmack"],steps:["Matcha in eine Schale oder ein Glas geben.","Mit heißem Wasser übergießen und glatt rühren.","Milch oder Pflanzendrink erwärmen und aufschäumen.","Matcha in die Tasse geben, Milch darüber gießen.","Optional süßen und genießen."],featured:true},
{slug:"iced-matcha-latte",title:"Iced Matcha Latte",category:"REZEPT",time:"4 MIN",tags:["ICED","LATTE"],image:"/img/gloa-iced.png",alt:"Iced Matcha Latte",excerpt:"Kalt, cremig und refreshing.",description:"Matcha Latte, aber kalt. Perfekt für warme Tage und unterwegs.",ingredients:["1 TL Matcha (ca. 3\u20134 g)","30 ml heißes Wasser (ca. 80 \u00b0C)","150\u2013200 ml kalte Milch oder Pflanzendrink","Eiswürfel","Optional: Süße nach Geschmack"],steps:["Matcha mit heißem Wasser glatt rühren.","Ein Glas mit Eiswürfeln füllen.","Kalte Milch oder Pflanzendrink eingießen.","Matcha langsam darüber gießen.","Optional süßen und genießen."],featured:true},
{slug:"strawberry-matcha-latte",title:"Strawberry Matcha Latte",category:"REZEPT",time:"5 MIN",tags:["ICED","FRUITY","LATTE"],image:"/img/gloa-recipe-strawberry-matcha.png",alt:"Strawberry Matcha Latte",excerpt:"Fruchtige Erdbeere trifft auf soften Matcha.",description:"Fruchtig, cremig und sofort sommerlich. Erdbeere und Matcha funktionieren zusammen besser, als man denkt.",ingredients:["3 TL zerdrueckte oder gemixte Erdbeeren","15 ml Vanillesirup","150\u2013180 ml Milch oder Pflanzendrink","Eiswürfel","1 TL Matcha (ca. 4 g)","60 ml Wasser zum Anrühren","Optional: Erdbeerpulver als Topping"],steps:["Erdbeeren mit Vanillesirup am Glasboden verteilen.","Eis ins Glas geben.","Milch oder Pflanzendrink einfüllen.","Matcha mit Wasser glatt rühren.","Matcha langsam als obere Schicht eingießen.","Optional mit Erdbeerpulver toppen."],featured:true},
{slug:"orange-zest-matcha-tonic",title:"Orange Zest Matcha Tonic",category:"REZEPT",time:"4 MIN",tags:["ICED","SPARKLING","REFRESHING"],image:"/img/gloa-recipe-orange-zest-tonic.png",alt:"Orange Zest Matcha Tonic",excerpt:"Zitrisch, sparkling und super frisch.",description:"Zitrisch, frisch und leicht bitter. Ein klarer Sommerdrink mit Matcha-Tonic-Twist.",ingredients:["30 ml Orange-Zest-Sirup oder 60 ml Orangensaft","60\u2013100 ml Tonic Water","Eiswürfel","1 TL Matcha (ca. 4 g)","60 ml Wasser zum Anrühren","Optional: Orangenzeste"],steps:["Orange-Zest-Sirup oder Orangensaft in ein Glas geben.","Eis hinzufügen.","Mit Tonic Water auffüllen.","Matcha mit Wasser glatt rühren.","Langsam über die Eiswürfel gießen, damit eine schöne Schichtung entsteht.","Optional mit Orangenzeste finishen."],featured:true},
{slug:"lemon-raspberry-coconut-matcha",title:"Lemon Raspberry Coconut Matcha",category:"REZEPT",time:"5 MIN",tags:["ICED","TROPICAL","FRUITY"],image:"/img/gloa-recipe-lemon-raspberry-coconut.png",alt:"Lemon Raspberry Coconut Matcha",excerpt:"Frisch, exotisch und farblich ein echter Hingucker.",description:"Frisch, leicht exotisch und visuell super stark. Zitrone, Himbeere, Kokos und Matcha in einem Drink.",ingredients:["30 ml Himbeersirup","15 ml Zitronensaft","100\u2013150 ml Kokoswasser oder leichte Kokosbasis","Eiswürfel","1 TL Matcha (ca. 4 g)","60 ml Wasser zum Anrühren"],steps:["Himbeersirup und Zitronensaft ins Glas geben.","Eis einfüllen.","Mit Kokoswasser auffüllen.","Matcha mit Wasser glatt rühren.","Langsam über das Eis gießen, damit sich die grüne Schicht oben absetzt."],featured:false},
{slug:"affogato-matcha-cloud",title:"Affogato & Matcha Cloud",category:"REZEPT",time:"5 MIN",tags:["ICED","COFFEE","MATCHA"],image:"/img/gloa-recipe-affogato-cloud.png",alt:"Affogato mit Matcha Cloud",excerpt:"Espresso, Eis und cremiger Matcha-Finish.",description:"Kräftiger Espresso trifft auf eine cremige Matcha-Cloud. Intensiv, kühl und perfekt für Coffee- und Matcha-Fans.",ingredients:["2 Shots Espresso","Eiswürfel","1 Kugel Vanille-Gelato oder 1\u20132 TL Vanilleeis","1 TL Matcha (ca. 4\u20135 g)","2 TL Sahne oder Whipping Cream","1 TL Milch","Optional: etwas Süße"],steps:["Espresso zubereiten und leicht abkühlen lassen.","Ein Glas mit Eis füllen und den Espresso eingießen.","Für die Matcha-Cloud Matcha mit wenig Wasser glatt rühren.","Sahne und Milch leicht aufschäumen oder cremig verrühren.","Matcha unterheben und als obere Schicht auf den Espresso geben.","Optional mit Vanille-Gelato servieren."],featured:false}
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
function HowTo(){return <section className="how-to"><div className="section-head"><div><p className="eyebrow">HOW TO GLOA</p><h2>Latte oder Pur.<br/>Mehr brauchst du nicht.</h2></div></div><div className="method-grid"><article><span>01</span><h3>Matcha Latte</h3><ol><li>Matcha dosieren</li><li>Mit Wasser aufschlagen</li><li>Milch oder Pflanzendrink dazu</li><li>Heiß oder iced genießen</li></ol></article><article><span>02</span><h3>Pure Matcha</h3><ol><li>Matcha dosieren</li><li>Mit wenig Wasser glattrühren</li><li>Mit Wasser aufschlagen</li><li>Direkt genießen</li></ol></article></div></section>}
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

function Home({onAdd}:{onAdd:()=>void}){return <main><section className="hero"><div className="hero-copy"><p className="eyebrow">MATCHA AUS SHIZUOKA.</p><h1>Matcha.<br/><i>Aber richtig.</i></h1><p className="lead">Aus Shizuoka, Japan. Für Latte, pur, iced oder wie du willst.</p><div className="hero-actions"><a className="cta" href="/shop" onClick={()=>track("shop_click")}>Zum Shop</a><a className="cta secondary" href="/about">GLOA entdecken →</a></div></div><div className="hero-art"><img src="/img/gloa-hero-packaging.png" alt="GLOA Matcha Verpackung" className="hero-img"/><span className="hero-micro">SHIZUOKA / JAPAN</span></div></section><section className="product-intro"><div><p className="eyebrow">MEET YOUR MATCHA.</p><h2>Ein Grün.<br/><i>Viele Momente.</i></h2><p>Aus Shizuoka, Japan. Für Matcha Latte und pur. Easy im Alltag, ehrlich im Produkt.</p><a className="cta" href="/shop">Shop GLOA</a></div><ProductCard onAdd={onAdd}/></section><section className="daily"><div className="daily-copy"><p className="eyebrow">MATCHA FÜR JEDEN TAG</p><h2>Morgens.<br/>Im Meeting.<br/><i>Nachmittags.</i></h2></div><div className="daily-grid">{dailyTiles.map(t=><div className="daily-tile" key={t.label}><img src={t.src} alt={t.alt} loading="lazy"/><span>{t.label}</span></div>)}</div></section><section className="origin"><div><p className="eyebrow">ORIGIN</p><h2>From Shizuoka,<br/><i>Japan.</i></h2></div><div><p>GLOA Matcha kommt aus Shizuoka, Japan. Mehr zum Produzenten, Cultivar und der Ernte teilen wir, sobald alles verifiziert ist.</p><dl><div><dt>ORIGIN</dt><dd>Shizuoka, Japan</dd></div><div><dt>MADE FOR</dt><dd>Latte + pure preparation</dd></div></dl></div></section><HowTo/><RecipeCarousel/><section className="community"><p className="eyebrow">#gloamatcha</p><h2>Zeig uns<br/><i>deinen Matcha.</i></h2><CommunityFeed/><a href={`https://instagram.com/${BRAND.instagram}`} target="_blank" rel="noopener noreferrer">@gloa.matcha folgen →</a></section><Newsletter/></main>}

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
["Wie oft wird geliefert?","Alle Abos werden einmal im Monat geliefert. Du bekommst deinen Matcha regelmäßig, ohne selbst daran denken zu müssen."],
["Was ist das Flex-Abo?","Monatliche Lieferung, monatlich kündbar. Du kannst jederzeit pausieren oder kündigen, ohne Mindestlaufzeit."],
["Was ist das 12-Monats-Abo?","12 Monate Laufzeit mit dem besten Preis. Lieferung und Abrechnung erfolgen monatlich. Nach Ablauf wechselst du automatisch ins Flex-Abo."],
["Muss ich beim 12-Monats-Abo alles im Voraus bezahlen?","Nein. Die Abrechnung erfolgt monatlich. Du zahlst nur die jeweils gelieferte Menge."],
["Kann ich mein Abo pausieren?","Ja. Beim Flex-Abo kannst du jederzeit pausieren. Beim 12-Monats-Abo sind bis zu 2 Monate Pause innerhalb der Laufzeit möglich."],
["Gibt es Abos auch für Merch oder Zubehör?","Nein. Abo-Optionen gibt es nur für Matcha. Merch und Zubehör sind ausschließlich als Einzelkauf erhältlich."]
];
return <main className="shop-page">
<section className="shop-hero"><div className="shop-hero-inner"><p className="eyebrow">GLOA · MATCHA</p><h1>Dein Matcha.<br/><i>Deine Art.</i></h1><p className="lead">Matcha aus Shizuoka, Japan. Für Latte, iced, pur oder wie du ihn magst.</p><p className="shop-hero-price">AB {fmt(lowest)} €</p><p className="shop-hero-micro">Launch in Vorbereitung.</p><a className="cta shop-hero-cta" href="#product" onClick={()=>track("shop_scroll_product")}>ZUM MATCHA</a></div></section>

<section id="product" className="shop-product"><div className="shop-product-image"><img src="/img/gloa-hero-packaging.png" alt="GLOA Matcha Verpackung" loading="lazy"/></div><div className="shop-product-info"><p className="eyebrow">MATCHA</p><h2>GLOA MATCHA</h2><p className="shop-product-sub">Shizuoka, Japan · Latte · Iced · Pur</p>

<div className="size-selector" role="radiogroup" aria-label="Größe wählen">
{MATCHA_VARIANTS.map((mv,i)=><label key={mv.size} className={`size-option${i===sizeIdx?" active":""}`}><input type="radio" name="size" className="sr-only" value={mv.size} checked={i===sizeIdx} onChange={()=>setSizeIdx(i)}/><span className="size-option-size">{mv.size}</span><span className="size-option-price">{fmt(mv.price)} €</span></label>)}
</div>

<p className="shop-product-price">{fmt(selectedPrice)} €{option!=="once"&&<span> / Lieferung</span>}</p>
<p className="shop-product-per100g">{fmt(per100)} € / 100 g</p>

{v.subscriptionEligible?<div className="purchase-options" role="radiogroup" aria-label="Kaufoption wählen">
<label className={`purchase-option${option==="once"?" active":""}`}><input type="radio" name="purchase-option" className="sr-only" value="once" checked={option==="once"} onChange={()=>setOption("once")}/><span className="purchase-option-head"><strong>EINMAL KAUFEN</strong><strong>{fmt(v.price)} €</strong></span><span className="purchase-option-desc">Einmalige Lieferung · Keine Bindung</span></label>
<label className={`purchase-option${option==="flex"?" active":""}`}><input type="radio" name="purchase-option" className="sr-only" value="flex" checked={option==="flex"} onChange={()=>setOption("flex")}/><span className="purchase-option-head"><strong>FLEX</strong><strong>{fmt(fp)} € <small>/ Lieferung</small></strong></span><span className="purchase-option-badge">10 % SPAREN</span><span className="purchase-option-desc">Monatlich · Kündbar · Pausierbar</span></label>
<label className={`purchase-option${option==="annual"?" active":""}`}><input type="radio" name="purchase-option" className="sr-only" value="annual" checked={option==="annual"} onChange={()=>setOption("annual")}/><span className="purchase-option-head"><strong>12 MONATE</strong><strong>{fmt(ap)} € <small>/ Lieferung</small></strong></span><span className="purchase-option-badge">15 % SPAREN</span><span className="purchase-option-desc">12 Monate Laufzeit · Monatl. Lieferung + Abrechnung</span></label>
</div>:<p className="shop-only-once">Nur als Einzelkauf erhältlich.</p>}
{option==="annual"&&<p className="shop-annual-note">12 Monate Laufzeit. Lieferung und Abrechnung erfolgen monatlich.</p>}
<button className="cta shop-cta" onClick={handleAdd}>{SHOP_STATUS==="prelaunch"?"Zum Launch informieren":"In den Warenkorb"}</button>
</div></section>

<section className="shop-abo-explain"><div className="shop-abo-explain-inner"><p className="eyebrow">GLOA ON REPEAT</p><h2>Matcha.<br/><i>Jeden Monat.</i></h2><p className="shop-abo-lead">Du entscheidest, wie flexibel du bleiben möchtest. Wir liefern deinen Matcha einmal im Monat.</p><div className="shop-abo-grid"><article><span>01</span><div className="shop-abo-line"/><h3>EINMAL</h3><p>Einmalige Bestellung. Kein Abo, keine Bindung. Einfach Matcha bestellen.</p></article><article><span>02</span><div className="shop-abo-line"/><h3>FLEX</h3><p>Monatliche Lieferung. Jederzeit kündbar oder pausierbar. 10 % günstiger.</p></article><article><span>03</span><div className="shop-abo-line"/><h3>12 MONATE</h3><p>Der beste Preis. 12 Monate Laufzeit, monatliche Lieferung und Abrechnung. 15 % günstiger.</p></article></div></div></section>

<section className="shop-details"><div className="shop-details-inner"><p className="eyebrow">PRODUKTDETAILS</p><dl><div><dt>HERKUNFT</dt><dd>Shizuoka, Japan</dd></div><div><dt>VERWENDUNG</dt><dd>Latte · Iced · Pur</dd></div><div><dt>ERNTE</dt><dd>2. und 3. Pflückung</dd></div><div><dt>MINDESTHALTBARKEIT</dt><dd>3 Jahre</dd></div><div><dt>LAGERUNG</dt><dd>Kühl und trocken</dd></div><div><dt>GROESSEN</dt><dd>{MATCHA_VARIANTS.map(v=>v.size).join(" · ")}</dd></div></dl><a className="shop-details-link" href="/our-matcha" onClick={()=>track("shop_to_matcha")}>MEHR ÜBER UNSEREN MATCHA →</a></div></section>

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
<section className="pdp-hero"><div className="pdp-hero-image"><img src="/img/gloa-hero-packaging.png" alt="GLOA Matcha Verpackung"/></div><div className="pdp-hero-info"><p className="eyebrow">MATCHA · SHIZUOKA</p><h1>{PRODUCT.name}</h1><p>Für Latte, iced und pure Zubereitung.</p>

<div className="size-selector" role="radiogroup" aria-label="Größe wählen">
{MATCHA_VARIANTS.map((mv,i)=><label key={mv.size} className={`size-option${i===sizeIdx?" active":""}`}><input type="radio" name="pdp-size" className="sr-only" value={mv.size} checked={i===sizeIdx} onChange={()=>setSizeIdx(i)}/><span className="size-option-size">{mv.size}</span><span className="size-option-price">{fmt(mv.price)} €</span></label>)}
</div>

<p className="pdp-price">{fmt(selectedPrice)} €{option!=="once"&&<span> / Lieferung</span>}</p>
<p className="pdp-per100g">{fmt(per100)} € / 100 g</p>

{v.subscriptionEligible?<div className="purchase-options" role="radiogroup" aria-label="Kaufoption wählen">
<label className={`purchase-option${option==="once"?" active":""}`}><input type="radio" name="pdp-purchase" className="sr-only" value="once" checked={option==="once"} onChange={()=>setOption("once")}/><span className="purchase-option-head"><strong>EINMAL KAUFEN</strong><strong>{fmt(v.price)} €</strong></span><span className="purchase-option-desc">Einmalige Lieferung · Keine Bindung</span></label>
<label className={`purchase-option${option==="flex"?" active":""}`}><input type="radio" name="pdp-purchase" className="sr-only" value="flex" checked={option==="flex"} onChange={()=>setOption("flex")}/><span className="purchase-option-head"><strong>FLEX</strong><strong>{fmt(fp)} € <small>/ Lieferung</small></strong></span><span className="purchase-option-badge">10 % SPAREN</span><span className="purchase-option-desc">Monatlich · Kündbar · Pausierbar</span></label>
<label className={`purchase-option${option==="annual"?" active":""}`}><input type="radio" name="pdp-purchase" className="sr-only" value="annual" checked={option==="annual"} onChange={()=>setOption("annual")}/><span className="purchase-option-head"><strong>12 MONATE</strong><strong>{fmt(ap)} € <small>/ Lieferung</small></strong></span><span className="purchase-option-badge">15 % SPAREN</span><span className="purchase-option-desc">12 Monate Laufzeit · Monatl. Lieferung + Abrechnung</span></label>
</div>:<p className="shop-only-once">Nur als Einzelkauf erhältlich.</p>}

<button className="cta shop-cta" onClick={handleAdd}>{SHOP_STATUS==="prelaunch"?"Zum Launch informieren":"In den Warenkorb"}</button>
</div></section>

<section className="pdp-facts"><div><p className="eyebrow">WHAT WE KNOW</p><h2>Clear facts.<br/>Nothing invented.</h2></div><dl><div><dt>HERKUNFT</dt><dd>Shizuoka, Japan</dd></div><div><dt>VERWENDUNG</dt><dd>Latte · Iced · Pur</dd></div><div><dt>LAGERUNG</dt><dd>{PRODUCT.storage}</dd></div><div><dt>GROESSEN</dt><dd>{MATCHA_VARIANTS.map(v=>v.size).join(" · ")}</dd></div></dl></section>
<HowTo/>
</main>}

function PageHero({index,eyebrow,title,text,tone}:{index:string;eyebrow:string;title:React.ReactNode;text:string;tone:string}){return <section className={`inner-hero ${tone}`}><span className="page-index">{index}</span><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="lead">{text}</p></div></section>}
function MatchaPage(){return <main className="matcha-page">
<section className="matcha-hero"><div className="matcha-hero-copy"><p className="eyebrow">UNSER MATCHA</p><h1>Aus Shizuoka.<br/><i>Für deinen Alltag.</i></h1><p className="lead">Was wir über unser Produkt wissen. Was wir noch nicht sagen können. Keine erfundenen Claims. Kein Marketing-Bullshit.</p></div><div className="matcha-hero-visual"><img src="/img/gloa-hero-packaging.png" alt="GLOA Matcha Verpackung"/></div></section>

<section className="matcha-facts"><p className="eyebrow">HERKUNFT</p><h2>Shizuoka,<br/><i>Japan.</i></h2><p className="matcha-section-text">GLOA Matcha kommt aus Shizuoka, einer der bekanntesten Teeanbauregionen Japans. Genauere Angaben zum Produzenten oder zur Farm können wir aktuell noch nicht machen.</p></section>

<section className="matcha-taste"><p className="eyebrow">GESCHMACK</p><h2>Wie schmeckt<br/><i>GLOA?</i></h2><div className="matcha-pending-grid"><div><span>GESCHMACKSPROFIL</span><strong>○ WIRD AKTUELL FINAL VERIFIZIERT</strong></div></div><p className="matcha-section-text">Sobald das finale Geschmacksprofil bestätigt ist, ergänzen wir hier die konkreten Noten und Eigenschaften unseres Matchas.</p></section>

<section className="matcha-use"><p className="eyebrow">VERWENDUNG</p><h2>Latte. Iced. Pur.<br/><i>Deine Wahl.</i></h2><div className="matcha-use-grid"><div><strong>LATTE</strong><p>Matcha glatt rühren. Milch oder Pflanzendrink dazu. Heiß genießen.</p></div><div><strong>ICED</strong><p>Matcha glatt rühren. Über Eis geben. Milch oder Pflanzendrink dazu.</p></div><div><strong>PUR</strong><p>Matcha glatt rühren. Mit Wasser auffüllen. Direkt genießen.</p></div></div></section>

<section className="matcha-facts matcha-known"><p className="eyebrow">WAS WIR WISSEN</p><h2>Bestätigte<br/><i>Fakten.</i></h2><div className="matcha-facts-grid"><div><span>HERKUNFT</span><strong>Shizuoka, Japan</strong></div><div><span>ERNTE</span><strong>2. und 3. Pflückung</strong></div><div><span>VERWENDUNG</span><strong>Latte · Iced · Pur</strong></div><div><span>MINDESTHALTBARKEIT</span><strong>3 Jahre</strong></div><div><span>LAGERUNG</span><strong>Kühl und trocken</strong></div><div><span>LAGER</span><strong>Deutschland</strong></div></div></section>

<section className="matcha-transparency"><div className="matcha-transparency-inner"><p className="eyebrow">TRANSPARENZ</p><h2>Was wir noch<br/><i>prüfen.</i></h2><p>Einige Details zum Produkt sind noch nicht vollständig verifiziert. Sobald sie bestätigt sind, ergänzen wir sie hier.</p><div className="matcha-pending-grid">{[["GESCHMACKSPROFIL","IN PRÜFUNG"],["CULTIVAR","IN PRÜFUNG"],["SINGLE CULTIVAR / BLEND","IN PRÜFUNG"],["PRODUZENT / FARM","IN PRÜFUNG"],["BIO-STATUS","IN PRÜFUNG"],["MAHLVERFAHREN – DETAILS","IN PRÜFUNG"]].map(([label,status])=><div key={label}><span>{label}</span><strong>○ {status}</strong></div>)}</div><p className="eyebrow matcha-pending-subhead">QUALITÄT & DOKUMENTATION</p><div className="matcha-pending-grid">{[["PRODUKTSPEZIFIKATION","IN PRÜFUNG"],["CHARGENANALYSE / COA","IN PRÜFUNG"],["PESTIZIDRÜCKSTÄNDE","UNTERLAGEN IN PRÜFUNG"],["MIKROBIOLOGISCHE ANALYSE","UNTERLAGEN IN PRÜFUNG"],["SCHWERMETALLANALYSE","UNTERLAGEN IN PRÜFUNG"],["ERNTE- / PRODUKTIONSDATEN","IN PRÜFUNG"]].map(([label,status])=><div key={label}><span>{label}</span><strong>○ {status}</strong></div>)}</div><div className="matcha-price-note"><span>ENDKUNDENPREIS</span><strong>AB {fmt(lowestPrice())} €</strong></div><p className="matcha-transparency-note">Wir erfinden nichts. Was hier steht, ist geprüft.</p></div></section>

<section className="matcha-shizuoka"><p className="eyebrow">SHIZUOKA</p><h2>Bald<br/><i>vor Ort.</i></h2><p>Wir planen einen Besuch vor Ort in Shizuoka. Sobald alles steht, nehmen wir euch mit und zeigen euch mehr über Herkunft, Verarbeitung und die Menschen hinter dem Produkt.</p><p className="matcha-build-note">Wir zeigen euch den Weg bis zum fertigen GLOA Produkt Schritt für Schritt.</p><a className="cta cream" href="https://www.tiktok.com/@gloa.matcha" target="_blank" rel="noopener noreferrer">AUF TIKTOK FOLGEN ↗</a></section>

<section className="matcha-howto"><div className="section-head"><div><p className="eyebrow">ZUBEREITUNG</p><h2>Drei Wege.<br/><i>Alle easy.</i></h2></div></div><div className="matcha-method-grid"><article><span>01</span><h3>Matcha Latte</h3><ol><li>Matcha glatt rühren.</li><li>Milch oder Pflanzendrink dazu.</li><li>Heiß genießen.</li></ol></article><article><span>02</span><h3>Iced Matcha</h3><ol><li>Matcha glatt rühren.</li><li>Über Eis geben.</li><li>Milch oder Pflanzendrink dazu.</li></ol></article><article><span>03</span><h3>Pure Matcha</h3><ol><li>Matcha glatt rühren.</li><li>Mit Wasser auffüllen.</li><li>Direkt genießen.</li></ol></article></div></section>

<section className="matcha-image"><img src="/img/gloa-iced.png" alt="Iced Matcha von GLOA"/></section>
<section className="matcha-cta"><h2>Bereit?</h2><div className="matcha-cta-actions"><a className="cta" href="/shop">Zum Shop</a><a className="cta secondary" href="/for-cafes">B2B →</a></div></section>
</main>}
function About(){return <main className="about-page">
<section className="about-hero"><span className="page-index">03</span><div><p className="eyebrow">ÜBER GLOA</p><h1>Good energy.<br/><i>No theatre.</i></h1><p className="lead">GLOA bringt Matcha aus Shizuoka in einen Alltag, der nicht nach Regeln fragt.</p><p className="about-sub-lead">Für Latte, iced, pur oder genau so, wie du ihn magst.</p></div><div className="about-hero-micro"><span>SHIZUOKA / JAPAN</span><span>BERLIN / GERMANY</span><span>EST. 2026</span></div></section>
<section className="about-beliefs"><p className="eyebrow">WE BELIEVE IN</p><div className="about-beliefs-grid"><div className="about-belief"><span>01</span><h2>Gutes Produkt<br/>statt Hype.</h2></div><div className="about-belief"><span>02</span><h2>Echte Leute<br/>statt Bullshit.</h2></div><div className="about-belief accent"><span>03</span><h2>Matcha, der<br/><i>einfach Spaß macht.</i></h2></div></div></section>
<section className="about-why"><div className="about-why-left"><p className="eyebrow">WHY GLOA EXISTS</p><h2>Matcha gehört<br/>nicht in eine<br/><i>Schublade.</i></h2></div><div className="about-why-right"><p>Wir mögen Matcha, aber nicht die Regeln, die manchmal darum gebaut werden.</p><p>GLOA soll unkompliziert funktionieren: im Café, im Büro, unterwegs oder zu Hause.</p><p>Kein Dresscode.<br/>Kein Ritual-Zwang.<br/>Ein gutes Produkt und du entscheidest, was du daraus machst.</p></div></section>
<section className="about-founders"><p className="eyebrow">BEHIND GLOA</p><h2>Vali <span className="about-x">×</span> Poli.</h2><p className="about-founders-lead">Wir bauen GLOA gemeinsam auf.</p><div className="about-founders-text"><p>Von Produkt und Packaging über Brand, Website und Cafés bis zum Launch: GLOA entsteht gerade Schritt für Schritt.</p><p>Wir wollen dabei nicht so tun, als wäre schon alles fertig. Du kannst dabei sein, während es entsteht.</p></div></section>
<section className="about-tiktok"><p className="eyebrow">BUILDING GLOA</p><h2>Begleite uns<br/><i>auf dem Weg.</i></h2><p>Wir bauen GLOA gerade auf.</p><p>Packaging, Produkt, Cafés, Launch und alles dazwischen. Auf TikTok zeigen wir, was hinter der Marke passiert.</p><a className="about-handle" href="https://www.tiktok.com/@gloa.matcha" target="_blank" rel="noopener noreferrer">@gloa.matcha</a><a className="cta cream" href="https://www.tiktok.com/@gloa.matcha" target="_blank" rel="noopener noreferrer">Auf TikTok folgen ↗</a><p className="about-micro">BUILDING IN PUBLIC · BERLIN · 2026</p></section>
<section className="about-final"><h2>Genug über uns.<br/><i>Zeit für Matcha.</i></h2><div className="about-final-actions"><a className="cta cream" href="/shop">Zum Shop</a><a className="cta about-cta-outline" href="/our-matcha">Unser Matcha →</a></div></section>
</main>}
function ForCafes(){useEffect(()=>track("b2b_page_view"),[]);return <main className="business"><section className="b2b-hero"><div><p className="eyebrow">GLOA FOR BUSINESS</p><h1>Matcha for<br/><i>your menu.</i></h1><p>Matcha aus Shizuoka für moderne Menüs.</p><div><a className="cta cream" href="?intent=sample#lead" onClick={()=>track("sample_request_start")}>Sample anfragen</a><a className="cta b2b-outline" href="#calculator">Umsatzpotenzial berechnen →</a></div></div><div className="b2b-visual"><div className="hero-tin"><span>GLOA</span><small>FOR BUSINESS</small></div><Placeholder/></div></section><section className="quick-facts">{["SHIZUOKA, JAPAN","LATTE · ICED · PUR","LAGER IN DEUTSCHLAND","SCHNELLE NACHBESTELLUNG","500 G · 1 KG GASTRO"].map(x=><strong key={x}>{x}</strong>)}</section><section className="behind-bar"><div><p className="eyebrow">FÜR DEINE BAR GEMACHT.</p><h2>Einfach zubereiten.<br/><i>Easy skalieren.</i></h2><p>Classic, iced, Strawberry oder pur. Ein Produkt, viele Drinks auf der Karte.</p></div><div className="servings"><span className="eyebrow servings-label">BEISPIELRECHNUNG</span><span><b>3 G</b>PRO DRINK</span><i>→</i><span><b>CA. 333</b>DRINKS / KG</span><small>Beispiel bei 3 g Matcha pro Drink.</small></div></section><BusinessCalculator/><BusinessFaq/></main>}
function BusinessFaq(){const qs:[string,string][]=[["Wo kommt GLOA Matcha her?","Shizuoka, Japan."],["Ist GLOA für Matcha Latte geeignet?","Ja. Das Produkt ist für Latte, iced und pur geeignet."],["Welche Großhandelsformate gibt es?","500 g und 1 kg Gastroformate."],["Habt ihr Lager in Deutschland?","Ja. Bestand in Deutschland."],["Wie schnell liefert ihr?","Lieferzeit und Verfügbarkeit bestätigen wir bei Bestellung."],["Wie viele Drinks bekomme ich aus 1 kg?","Abhängig von der Dosierung: Bei 2 g pro Drink ca. 500 Drinks, bei 3 g ca. 333 Drinks, bei 4 g ca. 250 Drinks. Mengenbeispiele."],["Was kostet es im Großhandel?","Unsere B2B-Konditionen werden individuell mit dir abgestimmt. Frag sie direkt über das B2B-Formular an."],["Was ist die regelmäßige Belieferung?","Ein flexibles Bezugsmodell mit monatlicher Lieferung und 5 % Preisvorteil. Mindestlaufzeit 3 Monate, danach monatlich kündbar."],["Wie funktioniert die 12-Monats-Partnerschaft?","Du vereinbarst eine monatliche Mindestabnahme für 12 Monate und erhältst 10 % Preisvorteil. Lieferung und Abrechnung erfolgen monatlich."],["Muss ich beim Jahresmodell alles im Voraus bezahlen?","Nein. Die Abrechnung erfolgt monatlich. Du zahlst nur die jeweils gelieferte Menge."],["Kann ich mehr als die vereinbarte Menge bestellen?","Ja. Zusätzliche Mengen können jederzeit angefragt werden, zum gleichen Kilopreis deines Modells."],["Was passiert, wenn ich noch nicht weiß, wie viel Matcha ich brauche?","Starte mit einer Einzelbestellung oder einem Sample. Sobald du deinen Bedarf besser einschätzen kannst, kannst du jederzeit auf ein Bezugsmodell wechseln."]];return <section className="faq"><p className="eyebrow">B2B FAQ</p><h2>Fragen?<br/><i>Antworten.</i></h2>{qs.map(([q,a])=><details key={q}><summary>{q}<span>+</span></summary><p>{a}</p></details>)}</section>}
function Rezepte(){const [filter,setFilter]=useState("ALLE");const filtered=filter==="ALLE"?recipes:recipes.filter(r=>r.tags.includes(filter));return <main className="rezepte-page">
<section className="rezepte-hero"><p className="eyebrow">GLOA · REZEPTE</p><h1>Matcha Rezepte.<br/><i>GLOA Edition.</i></h1><p className="lead">Signature Drinks. Einfach, visuell stark und passend zur GLOA-Welt.</p></section>
<section className="rezepte-filters">{ALL_TAGS.map(t=><button key={t} className={filter===t?"active":""} onClick={()=>setFilter(t)}>{t}</button>)}</section>
<section className="rezepte-grid">{filtered.map(r=><article key={r.slug} className="rezept-card"><a href={`/rezepte/${r.slug}`}><div className="rezept-card-img"><img src={r.image} alt={r.alt} loading="lazy"/></div><div className="rezept-card-body"><p className="eyebrow">{r.category} · {r.time}</p><h2>{r.title}</h2><p className="rezept-card-excerpt">{r.excerpt}</p><span className="rezept-card-cta">Rezept ansehen →</span></div></a></article>)}</section>
<Newsletter/>
</main>}
function RezeptDetail({slug}:{slug:string}){const r=recipes.find(x=>x.slug===slug);if(!r)return <main className="not-found"><h1>404</h1><p>Rezept nicht gefunden.</p><a href="/rezepte">← Alle Rezepte</a></main>;return <main className="rezept-detail">
<section className="rezept-detail-hero"><div className="rezept-detail-image"><img src={r.image} alt={r.alt}/></div><div className="rezept-detail-intro"><p className="eyebrow">{r.category} · {r.time}</p><h1>{r.title}</h1><p className="rezept-detail-desc">{r.description}</p><div className="rezept-detail-tags">{r.tags.map(t=><span key={t}>{t}</span>)}</div></div></section>
<section className="rezept-detail-content"><div className="rezept-detail-ingredients"><h2>Zutaten</h2><ul>{r.ingredients.map((ing,i)=><li key={i}>{ing}</li>)}</ul></div><div className="rezept-detail-steps"><h2>Zubereitung</h2><ol>{r.steps.map((step,i)=><li key={i}><span>{String(i+1).padStart(2,"0")}</span><p>{step}</p></li>)}</ol></div></section>
<section className="rezept-detail-nav"><a href="/rezepte">← Alle Rezepte</a><a href="/shop" className="cta">Matcha kaufen</a></section>
</main>}
function Contact(){return <main className="contact-main">
<section className="contact-hero"><p className="eyebrow">KONTAKT</p><h1>Schreib<br/><i>uns.</i></h1><p className="contact-sub">Wähl den richtigen Weg und deine Nachricht landet da, wo sie hingehört.</p></section>
<section className="contact-choices"><a href="#customer-form"><span>PRIVATKUNDE</span><h2>Fragen zu<br/>Produkt & Bestellung.</h2><b>Kontaktformular →</b></a><a href="/for-cafes"><span>BUSINESS</span><h2>Großhandel,<br/>Samples & Cafés.</h2><b>Zum B2B-Bereich →</b></a></section>
<form id="customer-form" className="customer-form" onSubmit={e=>e.preventDefault()}><p className="eyebrow">NACHRICHT SENDEN</p><div className="customer-form-row"><label>Name*<input required placeholder="Vor- und Nachname"/></label><label>E-Mail*<input required type="email" placeholder="deine@email.de"/></label></div><div className="customer-form-row"><label>Anliegen*<select required defaultValue=""><option value="" disabled>Bitte auswählen</option><option>Bestellung</option><option>Produkt</option><option>Abo</option><option>Sonstiges</option></select></label><label>Bestellnummer<input placeholder="Optional"/></label></div><label>Nachricht*<textarea required placeholder="Wie können wir helfen?" rows={5}/></label><button className="cta" type="submit">Nachricht senden</button></form>
</main>}
function Legal({route}:{route:string}){const title:Record<string,string>={impressum:"Impressum",datenschutz:"Datenschutz",agb:"Allgemeine Geschäftsbedingungen",widerruf:"Widerruf",versand:"Versandinformationen"};return <main className="legal-page"><p className="eyebrow">LEGAL</p><h1>{title[route]||"Legal"}</h1><div className="legal-placeholder"><h2>Rechtlicher Inhalt ausstehend.</h2><p>Vor dem öffentlichen Shop-Launch muss dieser Inhalt von GLOA beziehungsweise einer qualifizierten Rechtsberatung bereitgestellt und geprüft werden.</p></div></main>}

// TODO: BUSINESS ACCOUNT DASHBOARD (nach Supabase + B2B-Freigabe)
// Tabs / Sektionen für freigeschaltete B2B-Accounts:
//   - ÜBERSICHT (Dashboard-Landing)
//   - BESTELLUNGEN (B2B-Bestellhistorie)
//   - REGELMÄSSIGE BELIEFERUNG (laufende Belieferungsvertraege)
//   - RECHNUNGEN (B2B-Rechnungen)
//   - UNTERNEHMEN (Firmenprofil bearbeiten)
//   - LIEFERADRESSEN (Lieferadressen verwalten)
//   - KONTO (Account-Einstellungen, Passwort, E-Mail)
//
// Freischaltung: Nur wenn b2b_status === "approved" (serverseitig gesetzt).
// Kein Zugang zu B2B-Preisen oder Business-Dashboard ohne Freigabe.

function Account(){
const [view,setView]=useState<"landing"|"login"|"choose"|"register"|"b2b-apply">("landing");
const [pwError,setPwError]=useState("");

const validatePw=(form:FormData)=>{
const pw=String(form.get("password")||"");
const pw2=String(form.get("password_confirm")||"");
if(pw.length<8){setPwError("Passwort muss mindestens 8 Zeichen lang sein.");return false}
if(pw!==pw2){setPwError("Passwörter stimmen nicht überein.");return false}
setPwError("");return true};

const handlePrivate=(e:React.FormEvent<HTMLFormElement>)=>{e.preventDefault();const f=new FormData(e.currentTarget);if(!validatePw(f))return};
const handleB2B=(e:React.FormEvent<HTMLFormElement>)=>{e.preventDefault();const f=new FormData(e.currentTarget);if(!validatePw(f))return};

if(view==="login")return <main className="account-page"><section className="account-section">
<button className="account-back" onClick={()=>{setView("landing");setPwError("")}}>&#8592; Zurück</button>
<p className="eyebrow">GLOA ACCOUNT</p>
<h1>Anmelden.</h1>
<form className="account-form" onSubmit={e=>e.preventDefault()}>
<label>E-Mail-Adresse<input required type="email" placeholder="deine@email.de" autoComplete="email" name="email"/></label>
<label>Passwort<input required type="password" placeholder="Passwort" autoComplete="current-password" name="password"/></label>
<button className="cta account-cta" type="submit">Anmelden</button>
</form>
<button className="account-forgot" onClick={()=>{}}>Passwort vergessen?</button>
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
<button className="cta account-type-cta" onClick={()=>{setView("b2b-apply");setPwError("")}}>B2B Zugang anfragen</button>
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
<label>Land *<select required name="country" defaultValue="Deutschland">{COUNTRIES.map(c=><option key={c}>{c}</option>)}</select></label>
{pwError&&<p className="account-error">{pwError}</p>}
<label className="consent"><input required type="checkbox" name="accept_terms"/> Ich akzeptiere die <a href="/agb">AGB</a> und <a href="/datenschutz">Datenschutzerklärung</a>.</label>
<label className="consent"><input type="checkbox" name="newsletter"/> Ich möchte Neuigkeiten und Angebote von GLOA erhalten.</label>
<button className="cta account-cta" type="submit">Konto erstellen</button>
</form>
<p className="account-login-hint">Schon ein Konto? <button className="account-link-btn" onClick={()=>setView("login")}>Anmelden</button></p>
</section></main>;

if(view==="b2b-apply")return <main className="account-page"><section className="account-section account-b2b">
<button className="account-back" onClick={()=>{setView("choose");setPwError("")}}>&#8592; Zurück</button>
<p className="eyebrow">B2B ZUGANG ANFRAGEN</p>
<h1>Matcha für<br/><i>dein Business.</i></h1>
<p className="account-b2b-note">Geschäftskonten werden vor der Freischaltung geprüft. Preise und vollständige B2B-Konditionen sind nach Freigabe im Kundenbereich verfügbar.</p>
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
<label>Land *<select required name="country" defaultValue="Deutschland">{COUNTRIES.map(c=><option key={c}>{c}</option>)}</select></label>
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
<label className="consent"><input required type="checkbox" name="confirm_company_auth"/> Ich bestätige, dass ich im Namen des angegebenen Unternehmens handle.</label>
<label className="consent"><input required type="checkbox" name="accept_terms"/> Ich akzeptiere die <a href="/agb">AGB</a> und <a href="/datenschutz">Datenschutzerklärung</a>.</label>
<label className="consent"><input type="checkbox" name="newsletter"/> Ich möchte B2B-Neuigkeiten von GLOA erhalten.</label>
<button className="cta account-cta" type="submit">B2B Zugang anfragen</button>
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
<button ref={closeRef} className="cart-close" onClick={onClose} aria-label="Warenkorb schließen">×</button>
<p className="eyebrow">WARENKORB</p>
{cart.items.length===0?<div className="cart-empty">
<h2>Dein Warenkorb<br/>ist leer.</h2>
<p>Zeit für Matcha?</p>
<a href="/shop" className="cta" onClick={onClose}>Matcha →</a>
</div>:<>
<div className="cart-items">{cart.items.map(item=><div key={`${item.variantId}-${item.purchaseType}`} className="cart-item">
<div className="cart-item-info"><strong>GLOA Matcha</strong><span>{item.grams} g · {purchaseLabel(item.purchaseType)}</span></div>
<div className="cart-item-row">
<div className="cart-qty"><button onClick={()=>cart.updateQuantity(item.productId,item.variantId,item.purchaseType,item.quantity-1)} aria-label="Menge reduzieren">-</button><span>{item.quantity}</span><button onClick={()=>cart.updateQuantity(item.productId,item.variantId,item.purchaseType,item.quantity+1)} aria-label="Menge erhöhen">+</button></div>
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
else if(route==="account")page=<Account/>;
else if(route==="contact")page=<Contact/>;
else if(["impressum","datenschutz","agb","widerruf","versand"].includes(route))page=<Legal route={route}/>;
else page=<main className="not-found"><h1>404</h1><a href="/">Zurück zu GLOA →</a></main>;

return <><Header onCart={openCart} cartCount={cart.totalCount}/>{page}<Footer/><CartDrawer open={cartOpen} onClose={closeCart}/></>
}
