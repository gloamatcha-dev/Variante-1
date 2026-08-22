import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writeBlockedServerEnv } from "./testSupabase.mjs";

/**
 * Shared harness for server-rendering the CURRENT application build.
 *
 * One harness on purpose: before Task 27C the suite had two, and the
 * older one rendered dist/server/index.js - an artifact `npm run build`
 * no longer produces. It kept passing while asserting copy the site had
 * long since replaced, which is worse than no coverage at all. Every
 * render test now goes through here and therefore through
 * .output/server, which is what `npm run build` actually emits.
 *
 * Always safe for the default suite: writeBlockedServerEnv strips
 * SUPABASE_SECRET_KEY, so every write path in the spawned app degrades to
 * its "admin client not configured" branch and no row can be written to
 * any database.
 */
export async function startRenderServer(port, extraEnv = {}) {
  const base = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("../..", import.meta.url),
    env: writeBlockedServerEnv({ PORT: String(port), ...extraEnv }),
    stdio: "ignore",
  });

  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const res = await fetch(`${base}/`);
      if (res.ok) {
        return {
          base,
          /** Fetches a route as a browser would and returns status + html. */
          async getHtml(path) {
            const response = await fetch(`${base}${path}`, { headers: { accept: "text/html" } });
            return { status: response.status, html: await response.text() };
          },
          stop() {
            child.kill();
          },
        };
      }
    } catch {
      // not up yet
    }
    await delay(200);
  }

  child.kill();
  throw new Error(`render server at ${base} did not become ready in time`);
}
