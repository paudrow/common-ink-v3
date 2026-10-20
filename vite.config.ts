import { existsSync, readFileSync } from "node:fs";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { clipperFiles, clipperVersion, zip } from "./extension/bundle.ts";
import { unpackedExtensionId } from "./scripts/extension-id.ts";

/**
 * wrangler.jsonc names the one secret every deployment needs, and with that list in place the dev
 * server loads nothing else from .dev.vars. On this machine the optional ones are named too when
 * .dev.vars has them, so a Google client put there signs people in and reads their data sources.
 */
const OPTIONAL = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOKEN_KEY", "ALLOWED_EMAILS"];
const inDevVars = () => (existsSync(".dev.vars") ? OPTIONAL.filter((name) => new RegExp(`^${name}=`, "m").test(readFileSync(".dev.vars", "utf8"))) : []);

/** The dev server alone offers the clipper, built fresh from extension/ on each download; a deploy has no such address. */
const clipperDownload: Plugin = {
  name: "clipper-download",
  configureServer(server) {
    server.middlewares.use("/dev/clipper.zip", (_req, res, next) => {
      Promise.all([clipperFiles(), clipperVersion()]).then(([files, version]) => {
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="common-ink-clipper-${version}.zip"`);
        res.setHeader("Cache-Control", "no-store");
        res.end(zip(files));
      }, next);
    });
  },
};

// Builds only the web app; wrangler bundles the Worker, so one wrangler.jsonc serves dev, deploys, and Previews.
export default defineConfig(({ command }) => ({
  plugins: [react(), clipperDownload, command === "serve" && cloudflare({ config: { vars: { DEV_SIGN_IN: "1", DEV_SERVER: "1", CLIPPER_EXTENSION_IDS: unpackedExtensionId() }, secrets: { required: ["SESSION_SECRET", ...inDevVars()] } } })],
  build: { outDir: "dist", emptyOutDir: true },
}));
