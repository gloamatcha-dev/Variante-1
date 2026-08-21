import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const sans = Geist({ variable: "--font-sans", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "gloa.example";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.includes("localhost") ? "http" : "https");
  const base = new URL(`${protocol}://${host}`);
  return {
    metadataBase: base,
    title: "GLOA · Matcha aus Japan",
    description: "Matcha aus Shizuoka, Japan. Für Latte, pur oder wie du willst.",
    icons: { icon: "/favicon.svg" },
    openGraph: { title: "GLOA · Matcha aus Japan", description: "Matcha aus Japan. Bald in Berlin.", images: [{ url: "/og.png", width: 1732, height: 909 }] },
    twitter: { card: "summary_large_image", title: "GLOA · Matcha aus Japan", description: "Matcha aus Japan. Bald in Berlin.", images: ["/og.png"] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const organization = { "@context": "https://schema.org", "@type": "Organization", name: "GLOA", url: "/" };
  return <html lang="de"><body className={`${sans.variable} ${mono.variable}`}><script type="application/ld+json" dangerouslySetInnerHTML={{__html:JSON.stringify(organization)}} />{children}</body></html>;
}
