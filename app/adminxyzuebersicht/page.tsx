import type { Metadata } from "next";
import { AdminOverview } from "../AdminOverview";

/**
 * The private launch list overview.
 *
 * Its own route rather than the public catch-all, so GloaSite's header,
 * cart and footer are simply absent - an internal screen should not
 * carry a shop navigation.
 *
 * NOINDEX AND NOFOLLOW. An obscure path is not access control - the
 * session cookie is - but there is no reason to help a crawler find it,
 * and a page that lists people on a consent list should never appear in
 * a search result even as a title.
 */
export const metadata: Metadata = {
  title: "Intern · GLOA",
  robots: { index: false, follow: false, nocache: true },
};

export default function Page() {
  return <AdminOverview />;
}
