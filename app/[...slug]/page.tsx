import { notFound } from "next/navigation";
import { GloaSite } from "../GloaSite";
import { PRICES_VISIBLE } from "../content";
import { isKnownRoute, absoluteUrl, SITE_ORIGIN } from "../../lib/publicRoutes";
import { isProductWithheld } from "../../lib/catalogAvailability";
import { lookupProductBySlug } from "../../lib/catalogProducts";
import { resolveProductSlug } from "../../lib/productSlugs";
import { buildProductSchema } from "../../lib/productStructuredData";
import { getProductImage } from "../../lib/productPresentation";
import type { Metadata } from "next";

/**
 * THE SHOP DESCRIPTION IS THE ONE PIECE OF METADATA THAT CARRIES A PRICE.
 *
 * /shop itself withholds every price while SHOP_STATUS is "prelaunch"
 * (PRICES_VISIBLE, app/content.ts), but the page's own meta description
 * and its OpenGraph twin are rendered server-side from the table below,
 * and were publishing "Ab 19,99 Euro" to search engines and to every
 * link preview while the page beneath them refused to show it. A price a
 * customer cannot see on the page is not one the markup may publish.
 *
 * Gated on the SAME derived flag as every visible price, so the sentence
 * returns with them in one step and cannot be forgotten on launch day.
 * Nothing else about the description changes.
 *
 * The amount stays written out because metadata renders without a
 * catalog read; tests/shop-launch-gate.test.mjs asserts it still matches
 * the cheapest active variant in Supabase, so it cannot drift silently.
 */
const SHOP_DESCRIPTION_BASE = "GLOA Matcha aus Shizuoka. 30 g, 50 g, 100 g.";
const SHOP_DESCRIPTION_PRICE = "Ab 19,99 Euro.";
const SHOP_DESCRIPTION = PRICES_VISIBLE
 ? `${SHOP_DESCRIPTION_BASE} ${SHOP_DESCRIPTION_PRICE}`
 : SHOP_DESCRIPTION_BASE;

const seo:Record<string,[string,string]>={
 "shop":["Shop Matcha",SHOP_DESCRIPTION],
 "our-matcha":["Unser Matcha","GLOA Matcha aus Shizuoka, Japan. Herkunft, Fakten und Zubereitung."],
 "about":["Über GLOA","Wer hinter GLOA steht, warum wir Matcha machen und wie du den Aufbau begleiten kannst."],
 "for-cafes":["GLOA for Cafés","Matcha aus Shizuoka für deine Karte. Potenzial berechnen oder Sample anfragen."],
 // The legacy alias of /for-cafes, the way "journal" is the alias of
 // "rezepte". It routes to the same page, so it gets the same pair
 // instead of falling through to the generic one.
 "wholesale":["GLOA for Cafés","Matcha aus Shizuoka für deine Karte. Potenzial berechnen oder Sample anfragen."],
 "rezepte":["Matcha Rezepte","GLOA Signature Drinks. Affogato, Strawberry, Tonic und mehr."],
 "journal":["Matcha Rezepte","GLOA Signature Drinks. Affogato, Strawberry, Tonic und mehr."],
 "launch":["GLOA Launch List","Trag dich ein und wir sagen dir Bescheid, sobald GLOA offiziell startet."],
 "contact":["Kontakt","Kontakt für Kundschaft, Cafés und Geschäftskunden."],
 "partnerships":["Partnerschaften","Events, Brand Collaborations, Creators und Gifting mit GLOA. Erzähl uns von deinem Projekt."],
 "auth/confirm":["Verifizierung","Dein GLOA Konto wird verifiziert."],
 "order/success":["Bestellung bestätigt","Deine GLOA Bestellung wurde bestätigt."],
 "account/reset-password":["Passwort zurücksetzen","Setze ein neues Passwort für dein GLOA Konto."],
 "account":["Dein Konto","GLOA Account. Bestellungen, Abos und alles rund um deinen Matcha."],
 "account/dashboard":["Dein GLOA","Dein GLOA Dashboard. Bestellungen, Abos und Lieferungen im Überblick."],
 "account/orders":["Bestellungen","Deine GLOA Bestellungen."],
 "account/subscriptions":["Abos","Deine GLOA Abos und regelmäßige Lieferungen."],
 "account/addresses":["Adressen","Deine Lieferadressen bei GLOA."],
 "account/profile":["Kontodaten","Dein GLOA Profil und Kontodaten."],
 "account/business":["B2B bei GLOA","Preise, Konditionen, Belieferung und alles für deine Zusammenarbeit mit GLOA."],
 // The five legal routes had NO entry, so generateMetadata fell through
 // to the generic pair and every one of them rendered the browser title
 // "GLOA · GLOA". Each description below is the page's OWN lead
 // sentence, copied verbatim - no legal wording was written here.
 "impressum":["Impressum","Angaben gemäß § 5 DDG."],
 "datenschutz":["Datenschutz","Informationen zum Umgang mit deinen Daten."],
 "agb":["AGB","Unsere Bedingungen für Bestellungen im GLOA Online-Shop."],
 "widerruf":["Widerruf","Informationen zu deinem gesetzlichen Widerrufsrecht."],
 "versand":["Versandinformationen","Liefergebiete, Versandkosten und Lieferzeiten im Überblick."],
};
/**
 * THE PRODUCT PAGE NEEDS ITS OWN TITLE.
 *
 * Every /shop/<slug> fell back to the /shop pair, so /shop and
 * /shop/matcha shipped the identical title AND description - two
 * indexable pages telling a search engine they are the same page.
 * /shop/matcha is the one product page this launch has, so it gets its
 * own pair; any other slug keeps the shop fallback, which is right for
 * a page whose product the server cannot resolve.
 *
 * The description states only what the Impressum, the catalog and
 * app/content.ts already say: origin Shizuoka, organic, stone-ground,
 * three sizes. No award, rating or superlative.
 */
const PRODUCT_SEO:Record<string,[string,string]>={
 "shop/matcha":["GLOA Matcha","GLOA Matcha aus Shizuoka, Japan. Bio-zertifiziert und steinvermahlen, in 30 g, 50 g und 100 g."],
};

/**
 * TITLES CARRY THE BRAND ONCE.
 *
 * "Über GLOA · GLOA", "GLOA Launch List · GLOA" and "GLOA for Cafés ·
 * GLOA" all shipped the word twice, because the suffix was appended
 * unconditionally. A title that already names the brand keeps it as it
 * is; everything else still gets the suffix.
 */
function withBrand(title:string):string{
 return /\bGLOA\b/.test(title) ? title : `${title} · GLOA`;
}

/**
 * THE METADATA A ROUTE THAT DOES NOT EXIST GETS.
 *
 * One object, two callers: the route list said no (isKnownRoute), or
 * the catalog said no (an invented product slug). Both are the same
 * answer to a visitor and to a crawler, so both send the same thing.
 */
const NOT_FOUND_METADATA:Metadata={title:"Seite nicht gefunden · GLOA",description:"Diese Seite gibt es nicht.",robots:{index:false,follow:true}};

/**
 * THE URL THIS PAGE WANTS TO BE INDEXED AS.
 *
 * /shop/gloa-matcha has always rendered the matcha product page - an
 * alias app/GloaSite.tsx carries - and it shipped a canonical naming
 * ITSELF, which is two indexable URLs for one product. The canonical of
 * an aliased product page is the product's own URL; every other route
 * is its own canonical, unchanged.
 */
function canonicalPathFor(path:string):string{
 return path.startsWith("shop/")&&path.length>5 ? `shop/${resolveProductSlug(path.slice(5))}` : path;
}

/**
 * THE SERVER-SIDE ANSWER TO "IS THIS A REAL PRODUCT".
 *
 * Returns null for every route that is not a product page, so the
 * caller can treat "not a product" and "a product that exists" the same
 * way. The read itself is deduplicated by lib/catalogProducts.ts, so
 * generateMetadata and the page below share one catalog round-trip.
 */
function productLookupFor(path:string){
 return path.startsWith("shop/")&&path.length>5 ? lookupProductBySlug(path.slice(5)) : null;
}

export async function generateMetadata({params}:{params:Promise<{slug:string[]}>}):Promise<Metadata>{const{slug}=await params;const path=slug.join("/");
 // An unknown URL gets no metadata worth computing - app/not-found.tsx
 // supplies the 404's own title.
 if(!isKnownRoute(path))return NOT_FOUND_METADATA;
 // AND NEITHER DOES A PRODUCT THE CATALOG HAS NEVER HEARD OF. The page
 // below answers 404 for it; this is the title and the robots directive
 // that 404 carries, so the two halves of the same answer agree.
 if((await productLookupFor(path))?.state==="missing")return NOT_FOUND_METADATA;
 // The alias /shop/gloa-matcha gets the product's own title and
 // description, not the generic shop pair - it renders the product page
 // and its canonical already names it.
 const base=PRODUCT_SEO[canonicalPathFor(path)]||(path.startsWith("account/orders/")?seo["account/orders"]:path.startsWith("account/subscriptions/")?seo["account/subscriptions"]:path.startsWith("rezepte/")?seo.rezepte:path.startsWith("journal/")?seo.journal:path.startsWith("shop/")?seo.shop:seo[path]||["GLOA","Matcha aus Japan."]);
 const title=withBrand(base[0]);
 // A product the shop withholds must not be indexed either. The page
 // still resolves and still says "nicht verfügbar" - it is simply not
 // offered to a search engine as a result, which would otherwise send
 // people to a product they cannot buy. Handled here rather than by a
 // robots.txt Disallow, because noindex removes an already-indexed URL
 // while Disallow only stops the recrawl that would have removed it.
 const withheldProduct=path.startsWith("shop/")&&isProductWithheld(resolveProductSlug(path.slice(5)));
 const noIndex=withheldProduct||path.startsWith("account")||path.startsWith("auth/")||path.startsWith("order/");
 const canonical=`/${canonicalPathFor(path)}`;
 return{title,description:base[1],...(noIndex?{robots:{index:false,follow:false}}:{}),alternates:{canonical},openGraph:{type:"website",url:canonical,siteName:"GLOA",title,description:base[1],images:["/gloa-logo-slogan-link.png"]},twitter:{card:"summary_large_image",title,description:base[1],images:["/gloa-logo-slogan-link.png"]}}}

export default async function Page({params}:{params:Promise<{slug:string[]}>}){const{slug}=await params;const path=slug.join("/");
 // THE SOFT-404 ENDS HERE. Every unknown URL used to render the site's
 // own "404" heading under an HTTP 200, which tells a crawler the page
 // is real. notFound() sends a genuine 404 and renders app/not-found.tsx.
 if(!isKnownRoute(path))notFound();
 // AND SO DOES THE PRODUCT SOFT-404. /shop/<slug> is the one route
 // whose tail is DATA, so the route list above cannot answer for it -
 // /shop/does-not-exist and /shop/xyz123 were both 200 with a page that
 // said "Produkt vorübergehend nicht verfügbar." The catalog answers it
 // now, server-side, from Supabase and from no second product list.
 //
 // Only "missing" - the catalog answered and has no such product - is a
 // 404. A catalog that could not be reached returns "unavailable" and
 // falls through to the page exactly as before, because a blip must
 // never de-list a real product. "withheld" is /shop/metal-case, which
 // is a deliberate page and stays 200 + noindex.
 const lookup=await productLookupFor(path);
 if(lookup?.state==="missing")notFound();

 // PRODUCT STRUCTURED DATA, FROM THE SAME READ. Null while the shop is
 // closed - lib/productStructuredData.ts gates the whole node on
 // PRICES_VISIBLE, so no Offer, price, priceCurrency or availability is
 // published before launch and the entire block turns on with
 // SHOP_STATUS.
 const productSchema=lookup?.state==="found"
  ?buildProductSchema(lookup.product,{origin:SITE_ORIGIN,url:absoluteUrl(canonicalPathFor(path)),offersVisible:PRICES_VISIBLE,imagePath:getProductImage(lookup.product),fallbackDescription:PRODUCT_SEO[canonicalPathFor(path)]?.[1]??null})
  :null;
 if(productSchema)return <><script type="application/ld+json" dangerouslySetInnerHTML={{__html:JSON.stringify(productSchema)}}/><GloaSite route={path}/></>;
 return <GloaSite route={path}/>}
