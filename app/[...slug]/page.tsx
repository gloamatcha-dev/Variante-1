import { notFound } from "next/navigation";
import { GloaSite } from "../GloaSite";
import { PRICES_VISIBLE } from "../content";
import { isKnownRoute, absoluteUrl, SITE_ORIGIN, INDEXABLE_ROUTES } from "../../lib/publicRoutes";
import { isProductWithheld } from "../../lib/catalogAvailability";
import { lookupProductBySlug, lookupCatalogSeed, toSeedProduct } from "../../lib/catalogProducts";
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
 // The Metal Case is noindex, so this pair never reaches a search
 // result - but it IS the browser tab title, the bookmark and the link
 // preview of anyone who has the URL, and the shop fallback made all
 // three read "Shop Matcha · GLOA / GLOA Matcha aus Shizuoka. 30 g,
 // 50 g, 100 g." on a page that sells no matcha and states no size.
 // The page's own sentence instead, which is what it actually says.
 "shop/metal-case":["GLOA Metal Case","Das GLOA Metal Case ist aktuell nicht verfügbar."],
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
 * The two PAGE-level aliases, the way PRODUCT_SLUG_ALIASES holds the
 * product one.
 *
 * lib/publicRoutes.ts has always said so in prose - "wholesale: alias;
 * /for-cafes is the canonical one", "journal: legacy alias of /rezepte"
 * - and the sitemap already leaves both out. The markup did not agree:
 * each shipped a canonical naming ITSELF, so /wholesale and /for-cafes
 * were two byte-identical indexable pages - same title, same
 * description, same H1 - each telling a search engine it was the
 * original. The same fix canonicalPathFor below already made for the
 * product alias /shop/gloa-matcha, applied to the two page aliases.
 */
const ROUTE_ALIASES:Readonly<Record<string,string>>=Object.freeze({
 "wholesale":"for-cafes",
 "journal":"rezepte",
});

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
 if(path.startsWith("shop/")&&path.length>5)return `shop/${resolveProductSlug(path.slice(5))}`;
 // /journal/<slug> is an alias of /rezepte/<slug>, tail included.
 if(path.startsWith("journal/")&&path.length>8)return `rezepte/${path.slice(8)}`;
 return ROUTE_ALIASES[path]??path;
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
 // NOT IN THE SITEMAP MEANT NOT INDEXABLE - EVERYWHERE EXCEPT HERE.
 //
 // The noindex list used to be written out by hand: account, auth,
 // order, plus the withheld product. Everything ELSE the catch-all
 // serves was offered to a search engine, including two routes
 // lib/publicRoutes.ts deliberately keeps out of INDEXABLE_ROUTES:
 //
 //   /rezepte, /journal   withheld for this launch. The recipes flag
 //                        in app/content.ts is off, so the header, the
 //                        footer and the homepage carousel all drop the
 //                        link - yet the page still answered 200 with a
 //                        self-canonical and no robots directive. An
 //                        orphan copy of a section this launch is
 //                        holding back was free to be indexed, which is
 //                        the exact opposite of the decision taken for
 //                        /shop/metal-case.
 //
 // So the question is asked of the one list that already answers it.
 // INDEXABLE_ROUTES is documented as "the URLs a search engine may
 // list", the sitemap is built from it, and a test already fails if the
 // renderer and that list disagree - so a page cannot now be quietly
 // indexable without also being in the sitemap.
 //
 // It reads the CANONICAL path, so an alias is judged by what it points
 // at: /wholesale and /shop/gloa-matcha resolve to indexable routes and
 // stay indexable behind their canonical, exactly as before, while
 // /journal resolves to /rezepte and is withheld with it.
 //
 // NO CONTENT FLAG IS READ HERE, deliberately: tests/rezepte-page
 // .test.mjs records that the recipes switch hides links and does not
 // disable the feature, and that no server route may gate on it. This
 // route asks the route list instead. Recipes become indexable when
 // "rezepte" joins INDEXABLE_ROUTES, which is the same edit that puts
 // them in the sitemap - one switch, not two.
 const notListed=!INDEXABLE_ROUTES.includes(canonicalPathFor(path));
 const noIndex=withheldProduct||notListed||path.startsWith("account")||path.startsWith("auth/")||path.startsWith("order/");
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
 // THE FIRST HTML CARRIES THE PRODUCT, NOT A SPINNER.
 //
 // The catalog was read exclusively in the browser, so the HTML this
 // route sent for its most important page was <h1>Produkt</h1> and the
 // word "Laden…". The read three lines up already has the product; it
 // was being used to decide 404-or-not and then thrown away.
 //
 // lib/catalogProducts.ts strips every money field on the way out, in
 // prelaunch AND live, so what crosses into the markup is name,
 // description and variant labels and nothing a customer pays. The
 // browser still fetches the catalog itself and still owns every price.
 //
 // "unavailable" deliberately yields no seed: a catalog that could not
 // be asked keeps exactly the client-side loading behaviour it had, and
 // still answers 200 rather than de-listing a real product.
 const productSeed=lookup?.state==="found"?toSeedProduct(lookup.product):null;
 // /shop is the other half: its product band was client-only too, so
 // the HTML had no link to /shop/matcha anywhere on the site.
 const shopSeed=path==="shop"?await lookupCatalogSeed():null;
 const site=<GloaSite route={path} productSeed={productSeed} shopSeed={shopSeed}/>;
 if(productSchema)return <><script type="application/ld+json" dangerouslySetInnerHTML={{__html:JSON.stringify(productSchema)}}/>{site}</>;
 return site}
