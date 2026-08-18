import { GloaSite } from "../GloaSite";
import type { Metadata } from "next";

const seo:Record<string,[string,string]>={
 "shop":["Shop Matcha","GLOA Matcha aus Shizuoka. 30 g, 50 g, 100 g. Ab 19,99 Euro."],
 "our-matcha":["Unser Matcha","GLOA Matcha aus Shizuoka, Japan. Herkunft, Fakten und Zubereitung."],
 "about":["Über GLOA","Wer hinter GLOA steht, warum wir Matcha machen und wie du den Aufbau begleiten kannst."],
 "for-cafes":["GLOA for Cafés","Matcha aus Shizuoka für deine Karte. Potenzial berechnen oder Sample anfragen."],
 "rezepte":["Matcha Rezepte","GLOA Signature Drinks. Affogato, Strawberry, Tonic und mehr."],
 "journal":["Matcha Rezepte","GLOA Signature Drinks. Affogato, Strawberry, Tonic und mehr."],
 "contact":["Contact GLOA","Kontakt für Kund:innen, Cafés und Geschäftskunden."],
 "auth/confirm":["Verifizierung","Dein GLOA Konto wird verifiziert."],
 "account/reset-password":["Passwort zurücksetzen","Setze ein neues Passwort für dein GLOA Konto."],
 "account":["Dein Konto","GLOA Account. Bestellungen, Abos und alles rund um deinen Matcha."],
 "account/dashboard":["Dein GLOA","Dein GLOA Dashboard. Bestellungen, Abos und Lieferungen im Überblick."],
 "account/orders":["Bestellungen","Deine GLOA Bestellungen."],
 "account/subscriptions":["Abos","Deine GLOA Abos und regelmäßige Lieferungen."],
 "account/addresses":["Adressen","Deine Lieferadressen bei GLOA."],
 "account/profile":["Kontodaten","Dein GLOA Profil und Kontodaten."],
 "account/business":["B2B bei GLOA","Preise, Konditionen, Belieferung und alles für deine Zusammenarbeit mit GLOA."],
};
export async function generateMetadata({params}:{params:Promise<{slug:string[]}>}):Promise<Metadata>{const{slug}=await params;const path=slug.join("/");const base=path.startsWith("account/orders/")?seo["account/orders"]:path.startsWith("account/subscriptions/")?seo["account/subscriptions"]:path.startsWith("rezepte/")?seo.rezepte:path.startsWith("journal/")?seo.journal:seo[path]||["GLOA","Matcha aus Japan."];const noIndex=path.startsWith("account")||path.startsWith("auth/");return{title:`${base[0]} — GLOA`,description:base[1],...(noIndex?{robots:{index:false,follow:false}}:{}),alternates:{canonical:`/${path}`},openGraph:{title:`${base[0]} — GLOA`,description:base[1],images:["/og.png"]}}}
export default async function Page({params}:{params:Promise<{slug:string[]}>}){const{slug}=await params;return <GloaSite route={slug.join("/")}/>}
