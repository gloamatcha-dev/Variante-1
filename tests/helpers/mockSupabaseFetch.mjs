/**
 * A LOCAL STAND-IN FOR SUPABASE, INSIDE A SPAWNED APPLICATION SERVER.
 *
 * ── WHY THIS HAS TO EXIST ────────────────────────────────────
 *
 * The Supabase URL is INLINED AT BUILD TIME. `lib/supabaseAdmin.ts`
 * reads `import.meta.env.VITE_SUPABASE_URL`, and the compiled server
 * carries the production host as a string literal:
 *
 *   e(`https://<ref>.supabase.co`, process.env.SUPABASE_SECRET_KEY, …)
 *
 * Only the KEY is read at runtime. So a test cannot point the server at
 * a mock by setting an environment variable, the way RESEND_BASE_URL
 * lets it point Resend at one - the host is already baked in.
 *
 * That leaves two bad options and one good one. Running with no service
 * key means every database-backed path degrades and cannot be tested at
 * all. Running with a FAKE key means the server dials the real
 * production host and is refused there - a test suite that makes
 * unauthenticated requests to production, which is not acceptable no
 * matter how harmless the individual request looks.
 *
 * ── SO THE BOUNDARY IS MOVED ONE STEP IN ─────────────────────
 *
 * This module is preloaded into the CHILD process with `--import`. It
 * replaces `globalThis.fetch` with a wrapper that answers requests to
 * the Supabase host from a local rule and NEVER LETS ONE LEAVE THE
 * MACHINE - an unmatched Supabase request is an explicit failure rather
 * than a pass-through, so a route that starts talking to a table cannot
 * quietly succeed against production.
 *
 * Everything that is not the Supabase host is passed through untouched,
 * which is what lets the Resend mock keep working normally.
 *
 * ── HOW A TEST CONTROLS IT ───────────────────────────────────
 *
 * Through the environment, because that is all a parent process can
 * reach in a child that has already been spawned:
 *
 *   MOCK_SUPABASE_RPC   JSON that every rpc/ call returns, e.g.
 *                       '[{"allowed":true}]'
 *   MOCK_SUPABASE_STATUS optional HTTP status for those calls
 *
 * A test that needs a different verdict spawns a server with a
 * different value. That is coarse, and deliberately so: this is a
 * stand-in for one function, not a database.
 */

const SUPABASE_HOST_RE = /\.supabase\.co$/i;

const realFetch = globalThis.fetch;

globalThis.fetch = async function mockedFetch(input, init) {
  let url;
  try {
    url = new URL(typeof input === "string" ? input : (input?.url ?? String(input)));
  } catch {
    return realFetch(input, init);
  }

  if (!SUPABASE_HOST_RE.test(url.hostname)) {
    return realFetch(input, init);
  }

  // From here on the request is for Supabase and must not reach it.
  if (url.pathname.includes("/rest/v1/rpc/")) {
    const status = Number(process.env.MOCK_SUPABASE_STATUS || "200");
    const body = process.env.MOCK_SUPABASE_RPC ?? "[]";
    return new Response(body, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Anything else - a table read, a write, an auth call - is NOT mocked.
  // Answering it would let a route appear to work while doing something
  // this suite never meant to allow, so it fails loudly instead.
  return new Response(
    JSON.stringify({ message: `mockSupabaseFetch: unmocked Supabase request ${url.pathname}` }),
    { status: 599, headers: { "Content-Type": "application/json" } }
  );
};
