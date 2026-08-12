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
    nitro(),
  ],
});
