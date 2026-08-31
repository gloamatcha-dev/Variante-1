import type { Metadata } from "next";
import { headers } from "next/headers";
import { Inter, Cormorant_Garamond } from "next/font/google";
import "./globals.css";

// TWO FAMILIES, AND ONLY TWO. Inter carries navigation, body, labels,
// prices and the countdown; Cormorant Garamond carries the editorial
// italic display lines ("Aber richtig.", "Und das ist Absicht."). The
// third family this site used to load - a monospace, for uppercase
// metadata - is gone: that job is Inter plus letter-spacing, and
// --font-mono is now an alias in globals.css so no call site had to
// change.
//
// next/font self-hosts both at build time, so there is no runtime
// request to Google and no @import in the stylesheet. Only the weights
// actually used are fetched, and the italic is a REAL italic face rather
// than a synthetic slant.
const sans = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
  display: "swap",
});
const display = Cormorant_Garamond({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "600"],
  style: ["normal", "italic"],
  display: "swap",
});

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
  return <html lang="de"><body className={`${sans.variable} ${display.variable}`}><script type="application/ld+json" dangerouslySetInnerHTML={{__html:JSON.stringify(organization)}} />{children}</body></html>;
}
