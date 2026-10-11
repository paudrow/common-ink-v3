import { existsSync, readFileSync } from "node:fs";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * wrangler.jsonc names the one secret every deployment needs, and with that list in place the dev
 * server loads nothing else from .dev.vars. On this machine the optional ones are named too when
 * .dev.vars has them, so a Google client put there signs people in and reads their data sources.
 */
const OPTIONAL = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOKEN_KEY", "ALLOWED_EMAILS"];
const inDevVars = () => (existsSync(".dev.vars") ? OPTIONAL.filter((name) => new RegExp(`^${name}=`, "m").test(readFileSync(".dev.vars", "utf8"))) : []);

// Builds only the web app; wrangler bundles the Worker, so one wrangler.jsonc serves dev, deploys, and Previews.
export default defineConfig(({ command }) => ({
  plugins: [react(), command === "serve" && cloudflare({ config: { vars: { DEV_SIGN_IN: "1" }, secrets: { required: ["SESSION_SECRET", ...inDevVars()] } } })],
  build: { outDir: "dist", emptyOutDir: true },
}));
