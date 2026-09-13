import { GloaSite } from "../GloaSite";
import { PRICES_VISIBLE } from "../content";
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
export async function generateMetadata({params}:{params:Promise<{slug:string[]}>}):Promise<Metadata>{const{slug}=await params;const path=slug.join("/");const base=path.startsWith("account/orders/")?seo["account/orders"]:path.startsWith("account/subscriptions/")?seo["account/subscriptions"]:path.startsWith("rezepte/")?seo.rezepte:path.startsWith("journal/")?seo.journal:path.startsWith("shop/")?seo.shop:seo[path]||["GLOA","Matcha aus Japan."];const noIndex=path.startsWith("account")||path.startsWith("auth/")||path.startsWith("order/");return{title:`${base[0]} · GLOA`,description:base[1],...(noIndex?{robots:{index:false,follow:false}}:{}),alternates:{canonical:`/${path}`},openGraph:{title:`${base[0]} · GLOA`,description:base[1],images:["/gloa-logo-slogan-link.png"]}}}
export default async function Page({params}:{params:Promise<{slug:string[]}>}){const{slug}=await params;return <GloaSite route={slug.join("/")}/>}
