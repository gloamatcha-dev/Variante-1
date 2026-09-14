import type { Metadata } from "next";
import { GloaSite } from "./GloaSite";

/**
 * THE HOMEPAGE HAD NO CANONICAL.
 *
 * Every other route gets one from app/[...slug]/page.tsx, but the
 * homepage is its own file and exported no metadata at all - so it
 * inherited the layout's title and shipped no <link rel="canonical">.
 * That is the one URL most likely to be reached with tracking
 * parameters appended (?fbclid=, ?utm_source=), and without a canonical
 * each of those is a separate indexable copy of the front page.
 *
 * Title and description state only what the site and the Impressum
 * already say: a matcha brand from Shizuoka, organic, based in Berlin,
 * not yet selling. No superlative, no award, no rating.
 */
export const metadata: Metadata = {
  title: "GLOA · Bio-Matcha aus Japan",
  description:
    "GLOA ist eine Matcha-Marke aus Berlin. Bio-zertifizierter Matcha aus Shizuoka, Japan - für Latte, iced oder pur. Der Shop öffnet zum Launch.",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "GLOA",
    title: "GLOA · Bio-Matcha aus Japan",
    description: "Bio-zertifizierter Matcha aus Shizuoka, Japan. Eine Matcha-Marke aus Berlin.",
    images: ["/gloa-logo-slogan-link.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "GLOA · Bio-Matcha aus Japan",
    description: "Bio-zertifizierter Matcha aus Shizuoka, Japan. Eine Matcha-Marke aus Berlin.",
    images: ["/gloa-logo-slogan-link.png"],
  },
};

export default function Home() {
  return <GloaSite route="home" />;
}
