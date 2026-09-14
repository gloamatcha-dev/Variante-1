import type { Metadata } from "next";
import { SITE_ORIGIN } from "../lib/publicRoutes";
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
//
// ── NOTHING MAY BE COMMENTED *INSIDE* THESE OPTION LITERALS ───
//
// This is not a style rule, it is what decides whether the font is
// self-hosted at all. vinext's Google-fonts plugin reads the options
// object statically (parseStaticObjectLiteral in
// vinext/dist/plugins/fonts.js); anything it cannot parse makes
// injectSelfHostedCss() return early and the build falls through -
// SILENTLY, with no warning - to a runtime <link> at
// fonts.googleapis.com.
//
// Inter shipped exactly that regression: a comment block sat between
// `weight:` and `style:` below, so every production page loaded Inter
// from Google's CDN and handed every visitor's IP to Google, while
// Cormorant (no inner comment) was self-hosted correctly. Both of the
// comments that used to live inside the literals are therefore out
// here, where they document the same decisions and cost nothing.
//
// The check that this still holds: after a build, .vinext/fonts must
// contain BOTH an inter-* and a cormorant-garamond-* directory, and
// the served HTML must contain no fonts.googleapis.com link at all.
// tests/font-self-hosting.test.mjs asserts the first half.
//
// ── REAL ITALIC FACES, added deliberately ────────────────────
//
// The typography audit found Inter was loaded without them, so any
// italic in a sans context could only ever have been a browser-
// synthesised slant. The hero's second headline line is Inter 800
// ITALIC, which needs the actual face.
const sans = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
  style: ["normal", "italic"],
  display: "swap",
});
const display = Cormorant_Garamond({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "600"],
  style: ["normal", "italic"],
  display: "swap",
});

/**
 * metadataBase IS PINNED, NOT DERIVED FROM THE REQUEST.
 *
 * It used to be built from x-forwarded-host / host. Those headers are
 * caller-controlled - lib/siteUrl.ts refuses to trust them for exactly
 * this reason when building Stripe redirects - and metadataBase is what
 * every relative canonical and every Open Graph image URL is resolved
 * against. A request carrying a different Host would have produced
 * canonicals pointing somewhere else entirely, and a preview deployment
 * produced canonicals naming the preview domain.
 *
 * A canonical URL only has one correct value, on every host that ever
 * serves this bundle: the production origin. So it is a constant.
 */
export async function generateMetadata(): Promise<Metadata> {
  return {
    metadataBase: new URL(SITE_ORIGIN),
    title: "GLOA · Bio-Matcha aus Japan",
    description: "Bio-zertifizierter Matcha aus Shizuoka, Japan. Eine Matcha-Marke aus Berlin.",
    icons: { icon: "/favicon.svg" },
    openGraph: { type: "website", url: SITE_ORIGIN, siteName: "GLOA", locale: "de_DE", title: "GLOA · Bio-Matcha aus Japan", description: "Bio-zertifizierter Matcha aus Shizuoka, Japan. Eine Matcha-Marke aus Berlin.", images: [{ url: "/gloa-logo-slogan-link.png", width: 1731, height: 909 }] },
    twitter: { card: "summary_large_image", title: "GLOA · Bio-Matcha aus Japan", description: "Bio-zertifizierter Matcha aus Shizuoka, Japan. Eine Matcha-Marke aus Berlin.", images: ["/gloa-logo-slogan-link.png"] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // THE LOGO HERE IS THE LOGO, NOT THE SOCIAL PREVIEW.
  //
  // This used to point at /gloa-logo-slogan-link.png, which is the Open
  // Graph card: the wordmark plus the slogan, baked onto a Warm Cream
  // rectangle at 1731x909. As a link preview that is exactly right. As
  // schema.org/logo it is wrong twice over - a consumer of this markup
  // (a search result, a knowledge panel, a merchant listing) crops it to
  // a square or a small box, which cuts the slogan off and shrinks the
  // wordmark inside its own margins, and it hands over an image with a
  // background where a logo is expected to have none.
  //
  // /gloa-logo-blue-600.png is the approved wordmark itself: GLOA Blue,
  // transparent, no slogan, no padding. The Open Graph and Twitter cards
  // above keep the lockup, because that is what they are for.
  // ── WHY THESE URLS ARE ABSOLUTE NOW ──────────────────────────
  //
  // This block shipped `url: "/"` and `logo: "/gloa-logo-blue-600.png"`.
  // JSON-LD is not resolved against the page the way an <img src> is -
  // a consumer reading it out of a crawl index has no base to resolve
  // "/" against, so the two most identifying fields of the whole entity
  // were unusable. Every URL below is absolute and points at the one
  // production origin.
  //
  // ── ONLY PUBLISHED FACTS ─────────────────────────────────────
  //
  // legalName, the address and the email are exactly what /impressum
  // already states publicly. sameAs carries the two profiles the footer
  // already links and nothing else - no LinkedIn, no Facebook, no
  // Pinterest, because no such profile is established anywhere in this
  // project. There is no foundingDate, no employee count, no rating and
  // no award: none of those are verified here, and a knowledge panel
  // built on a guess is worse than one built on less.
  //
  // No organic certification body or certificate number appears either.
  // app/content.ts records that the plain "bio" claim is released while
  // the document itself is still pending, so the claim lives in the
  // description as prose and no machine-readable certification field is
  // fabricated around it.
  const organization = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${SITE_ORIGIN}/#organization`,
    name: "GLOA",
    legalName: "Cara 2 GmbH",
    url: `${SITE_ORIGIN}/`,
    logo: `${SITE_ORIGIN}/gloa-logo-blue-600.png`,
    image: `${SITE_ORIGIN}/gloa-logo-slogan-link.png`,
    description:
      "GLOA ist eine Matcha-Marke aus Berlin. Bio-zertifizierter Matcha aus Shizuoka, Japan.",
    email: "hello@gloamatcha.com",
    address: {
      "@type": "PostalAddress",
      streetAddress: "Hardenbergstr. 4",
      postalCode: "10623",
      addressLocality: "Berlin",
      addressCountry: "DE",
    },
    sameAs: [
      "https://instagram.com/gloa.matcha",
      "https://www.tiktok.com/@gloa.matcha",
    ],
  };

  // The brand as its own node, referenced by @id from the organization
  // rather than repeated. One entity, two roles - a consumer that
  // understands Brand gets it, one that only reads Organization is not
  // handed a second, competing description of the same company.
  const brand = {
    "@context": "https://schema.org",
    "@type": "Brand",
    "@id": `${SITE_ORIGIN}/#brand`,
    name: "GLOA",
    url: `${SITE_ORIGIN}/`,
    logo: `${SITE_ORIGIN}/gloa-logo-blue-600.png`,
    description: "Bio-zertifizierter Matcha aus Shizuoka, Japan.",
  };

  // NO SearchAction. The site has no site-search, and declaring a
  // potentialAction that resolves to nothing is a claim about a feature
  // that does not exist.
  const website = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${SITE_ORIGIN}/#website`,
    name: "GLOA",
    url: `${SITE_ORIGIN}/`,
    inLanguage: "de-DE",
    publisher: { "@id": `${SITE_ORIGIN}/#organization` },
  };

  return <html lang="de"><body className={`${sans.variable} ${display.variable}`}><script type="application/ld+json" dangerouslySetInnerHTML={{__html:JSON.stringify([organization,brand,website])}} />{children}</body></html>;
}
