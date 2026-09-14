import type { NextConfig } from "next";

/**
 * SECURITY HEADERS.
 *
 * Production shipped exactly one: Strict-Transport-Security, which
 * Vercel adds by itself. Everything below was absent.
 *
 * ── WHY THERE IS NO Content-Security-Policy HERE ──────────────
 *
 * A CSP is the one header on this list that breaks a working shop when
 * it is guessed at. This site inlines JSON-LD, ships Next.js's own
 * inline bootstrap, self-hosts fonts through next/font, talks to
 * Supabase over XHR from the browser, and redirects to Stripe's hosted
 * checkout. A policy written without measuring each of those either
 * needs 'unsafe-inline' to work - which is most of the protection given
 * away - or silently breaks the catalog, the cart or the payment
 * redirect, and in PRELAUNCH nobody would notice until launch day.
 *
 * So CSP is deliberately NOT set in this pass and is named in the
 * report as the one remaining header, together with what it has to
 * allow. It wants a measured Report-Only rollout, not a guess.
 *
 * The four below are safe to state without measurement: none of them
 * can block a resource the site loads.
 */
const securityHeaders = [
  // Stops a browser from second-guessing a declared Content-Type. The
  // classic use is an upload served as text/plain being sniffed as
  // HTML and executed; this site serves user-supplied bytes nowhere,
  // and the header costs nothing.
  { key: "X-Content-Type-Options", value: "nosniff" },

  // Send the full URL only within this origin; to anywhere else send
  // the origin alone. Order pages carry a session_id in the query
  // string, so a full-URL referrer leaving the site would hand that
  // identifier to whatever was linked.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },

  // Features this site never uses. Denying them means an injected
  // script cannot reach for them either. Payment is included on
  // purpose: Stripe checkout runs on Stripe's own origin after a
  // redirect, not in an embedded Payment Request frame here.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },

  // Clickjacking. frame-ancestors is the modern form and lives in CSP,
  // which is not set yet - X-Frame-Options is the part that works
  // today, and nothing on this site is meant to be framed.
  { key: "X-Frame-Options", value: "DENY" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
