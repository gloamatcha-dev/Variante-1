import Link from "next/link";
import type { Metadata } from "next";

/**
 * THE 404 THAT ACTUALLY ANSWERS 404.
 *
 * The catch-all used to render a "404" heading under an HTTP 200, so
 * every typo and every crawler probe looked like a real page. This is
 * what notFound() renders, and it arrives with a genuine 404 status -
 * which is the half a search engine reads.
 *
 * Deliberately a plain server component with no Header or Footer. Both
 * live in app/Chrome.tsx behind "use client" and take callback props
 * (onCart, onMenuOpenChange); functions cannot cross the server/client
 * boundary, so pulling them in here would mean either making this page
 * a client component or inventing no-op handlers for a page that has no
 * cart to open. It reuses the .not-found rule the stylesheet already
 * carries, and offers the three routes a lost visitor actually wants.
 */
export const metadata: Metadata = {
  title: "Seite nicht gefunden · GLOA",
  description: "Diese Seite gibt es nicht.",
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return (
    <main className="not-found">
      <h1>404</h1>
      <p>Diese Seite gibt es nicht. Vielleicht ein Tippfehler, vielleicht ein alter Link.</p>
      <p>
        <Link href="/">Zur Startseite</Link>{" · "}
        <Link href="/shop">Matcha</Link>{" · "}
        <Link href="/launch">Launch List</Link>
      </p>
    </main>
  );
}
