import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds only the web app; wrangler bundles the Worker, so one wrangler.jsonc serves dev, deploys, and Previews.
export default defineConfig(({ command }) => ({
  plugins: [react(), command === "serve" && cloudflare({ config: { vars: { DEV_SIGN_IN: "1" } } })],
  build: { outDir: "dist", emptyOutDir: true },
}));
