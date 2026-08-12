import { GloaSite } from "../GloaSite";
import type { Metadata } from "next";

const seo:Record<string,[string,string]>={
 "shop":["Shop Matcha","GLOA Matcha aus Shizuoka — ab 25,49 € mit Abo."],
 "our-matcha":["Unser Matcha","GLOA Matcha aus Shizuoka, Japan. Herkunft, Fakten und Zubereitung."],
 "about":["Über GLOA","Wer hinter GLOA steht, warum wir Matcha machen und wie du den Aufbau begleiten kannst."],
 "for-cafes":["GLOA for Cafés","Matcha aus Shizuoka für deine Karte. Potenzial berechnen oder Sample anfragen."],
 "journal":["GLOA Journal","Rezepte, Matcha, Café-Kultur und GLOA Stories."],
 "contact":["Contact GLOA","Kontakt für Kund:innen, Cafés und Geschäftskunden."],
};
export async function generateMetadata({params}:{params:Promise<{slug:string[]}>}):Promise<Metadata>{const{slug}=await params;const path=slug.join("/");const base=path.startsWith("journal/")?seo.journal:seo[path]||["GLOA","Matcha aus Japan."];return{title:`${base[0]} — GLOA`,description:base[1],alternates:{canonical:`/${path}`},openGraph:{title:`${base[0]} — GLOA`,description:base[1],images:["/og.png"]}}}
export default async function Page({params}:{params:Promise<{slug:string[]}>}){const{slug}=await params;return <GloaSite route={slug.join("/")}/>}
