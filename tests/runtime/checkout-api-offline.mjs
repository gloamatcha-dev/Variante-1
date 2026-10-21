/** Re-run all 19 existing checkout assertions against synthetic catalogue reads.
 * The preload is inherited by the spawned built server. No .env data is fetched. */
import { spawn } from 'node:child_process';
const env = { ...process.env,
  NODE_OPTIONS: '--import ./tests/helpers/checkoutOfflineFetch.mjs',
  VITE_SUPABASE_URL: 'http://127.0.0.1:1', VITE_SUPABASE_PUBLISHABLE_KEY: 'offline-publishable-fixture',
  STRIPE_SECRET_KEY: '', SUPABASE_SECRET_KEY: '', RESEND_API_KEY: '',
};
const child = spawn(process.execPath, ['--test', 'tests/checkout-api.test.mjs'], { env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
