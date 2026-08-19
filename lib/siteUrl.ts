/**
 * Derives the site's absolute origin from request headers, matching the
 * approach already used for metadataBase in app/layout.tsx. Avoids
 * hardcoding a production URL or introducing a redundant env var.
 */
export function getSiteOrigin(request: Request): string {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "gloa.example";
  const protocol = request.headers.get("x-forwarded-proto") || (host.includes("localhost") ? "http" : "https");
  return `${protocol}://${host}`;
}
