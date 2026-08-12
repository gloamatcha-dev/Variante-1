import { GloaSite } from "../GloaSite";
import type { Metadata } from "next";

const seo:Record<string,[string,string]>={
 "shop":["Shop Matcha","Entdecke GLOA Matcha aus Shizuoka — für Latte und pure Zubereitung."],
 "our-matcha":["Our Matcha","Herkunft, Zubereitung und verifizierte Produktinformationen zu GLOA Matcha."],
 "about":["About GLOA","GLOA macht Matcha zu einem modernen täglichen Ritual."],
 "for-cafes":["GLOA for Cafés","Matcha aus Shizuoka für moderne Menüs. Potenzial berechnen oder Sample anfragen."],
 "journal":["GLOA Journal","Recipes, Matcha, culture and café stories from GLOA."],
 "contact":["Contact GLOA","Kontakt für Kund:innen, Cafés und Geschäftskunden."],
};
export async function generateMetadata({params}:{params:Promise<{slug:string[]}>}):Promise<Metadata>{const{slug}=await params;const path=slug.join("/");const base=path.startsWith("journal/")?seo.journal:seo[path]||["GLOA","Matcha, made for now."];return{title:`${base[0]} — GLOA`,description:base[1],alternates:{canonical:`/${path}`},openGraph:{title:`${base[0]} — GLOA`,description:base[1],images:["/og.png"]}}}
export default async function Page({params}:{params:Promise<{slug:string[]}>}){const{slug}=await params;return <GloaSite route={slug.join("/")}/>}
