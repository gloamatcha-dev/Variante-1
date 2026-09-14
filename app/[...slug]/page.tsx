import { notFound } from "next/navigation";
import { GloaSite } from "../GloaSite";
import { PRICES_VISIBLE } from "../content";
import { isKnownRoute } from "../../lib/publicRoutes";
import { isProductWithheld } from "../../lib/catalogAvailability";
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

export async function generateMetadata({params}:{params:Promise<{slug:string[]}>}):Promise<Metadata>{const{slug}=await params;const path=slug.join("/");
 // An unknown URL gets no metadata worth computing - app/not-found.tsx
 // supplies the 404's own title.
 if(!isKnownRoute(path))return{title:"Seite nicht gefunden · GLOA",description:"Diese Seite gibt es nicht.",robots:{index:false,follow:true}};
 const base=PRODUCT_SEO[path]||(path.startsWith("account/orders/")?seo["account/orders"]:path.startsWith("account/subscriptions/")?seo["account/subscriptions"]:path.startsWith("rezepte/")?seo.rezepte:path.startsWith("journal/")?seo.journal:path.startsWith("shop/")?seo.shop:seo[path]||["GLOA","Matcha aus Japan."]);
 const title=withBrand(base[0]);
 // A product the shop withholds must not be indexed either. The page
 // still resolves and still says "nicht verfügbar" - it is simply not
 // offered to a search engine as a result, which would otherwise send
 // people to a product they cannot buy. Handled here rather than by a
 // robots.txt Disallow, because noindex removes an already-indexed URL
 // while Disallow only stops the recrawl that would have removed it.
 const withheldProduct=path.startsWith("shop/")&&isProductWithheld(path.slice(5));
 const noIndex=withheldProduct||path.startsWith("account")||path.startsWith("auth/")||path.startsWith("order/");
 return{title,description:base[1],...(noIndex?{robots:{index:false,follow:false}}:{}),alternates:{canonical:`/${path}`},openGraph:{type:"website",url:`/${path}`,siteName:"GLOA",title,description:base[1],images:["/gloa-logo-slogan-link.png"]},twitter:{card:"summary_large_image",title,description:base[1],images:["/gloa-logo-slogan-link.png"]}}}

export default async function Page({params}:{params:Promise<{slug:string[]}>}){const{slug}=await params;const path=slug.join("/");
 // THE SOFT-404 ENDS HERE. Every unknown URL used to render the site's
 // own "404" heading under an HTTP 200, which tells a crawler the page
 // is real. notFound() sends a genuine 404 and renders app/not-found.tsx.
 if(!isKnownRoute(path))notFound();
 return <GloaSite route={path}/>}
