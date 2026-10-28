import { defineConfig } from "vite";
import vinext from "vinext";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
import { sites } from "./build/sites-vite-plugin";

export default defineConfig({
  plugins: [
    tailwindcss(),
    vinext(),
    sites(),
    nitro({
      vercel: {
        functionRules: {
          "/api/cron/finance-reconciliation": { maxDuration: 60 },
          "/api/cron/finance-reconciliation-verify": { maxDuration: 60 },
          "/api/admin/stripe-sync": { maxDuration: 60 },
        },
      },
    }),
  ],
});
