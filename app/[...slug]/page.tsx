import { GloaSite } from "../GloaSite";
import type { Metadata } from "next";

const seo:Record<string,[string,string]>={
 "shop":["Shop Matcha","GLOA Matcha aus Shizuoka. 20 g, 50 g, 100 g, 150 g. Ab 19,99 Euro."],
 "our-matcha":["Unser Matcha","GLOA Matcha aus Shizuoka, Japan. Herkunft, Fakten und Zubereitung."],
 "about":["Über GLOA","Wer hinter GLOA steht, warum wir Matcha machen und wie du den Aufbau begleiten kannst."],
 "for-cafes":["GLOA for Cafés","Matcha aus Shizuoka für deine Karte. Potenzial berechnen oder Sample anfragen."],
 "rezepte":["Matcha Rezepte","GLOA Signature Drinks. Affogato, Strawberry, Tonic und mehr."],
 "journal":["Matcha Rezepte","GLOA Signature Drinks. Affogato, Strawberry, Tonic und mehr."],
 "contact":["Contact GLOA","Kontakt fuer Kund:innen, Cafes und Geschaeftskunden."],
 "account":["Dein Konto","GLOA Account. Bestellungen, Abos und alles rund um deinen Matcha."],
};
export async function generateMetadata({params}:{params:Promise<{slug:string[]}>}):Promise<Metadata>{const{slug}=await params;const path=slug.join("/");const base=path.startsWith("rezepte/")?seo.rezepte:path.startsWith("journal/")?seo.journal:seo[path]||["GLOA","Matcha aus Japan."];return{title:`${base[0]} — GLOA`,description:base[1],alternates:{canonical:`/${path}`},openGraph:{title:`${base[0]} — GLOA`,description:base[1],images:["/og.png"]}}}
export default async function Page({params}:{params:Promise<{slug:string[]}>}){const{slug}=await params;return <GloaSite route={slug.join("/")}/>}
