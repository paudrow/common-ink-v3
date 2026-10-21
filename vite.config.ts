import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
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

const EXCALIDRAW = "node_modules/@excalidraw/excalidraw";
const EXCALIDRAW_FONTS = join(EXCALIDRAW, "dist/prod/fonts");
const excalidrawVersion = () => (JSON.parse(readFileSync(join(EXCALIDRAW, "package.json"), "utf8")) as { version: string }).version;

/** Where Excalidraw adds a CDN after the app's own address as a place to load each font from. */
const FONT_FALLBACK = /\w+\.push\(new URL\(\w+,\s*\w+\.ASSETS_FALLBACK_URL\)\)/;

/**
 * Takes the CDN out of the places Excalidraw loads a font from, in a build and in the dev server's
 * bundle of it alike, so each font comes from the app's own address and nowhere else. A version of
 * Excalidraw that adds the CDN some other way fails the build here.
 */
const noFontCdn = {
  name: "excalidraw-no-font-cdn",
  transform(code: string, id: string) {
    if (!id.includes("@excalidraw/excalidraw") || !code.includes("ASSETS_FALLBACK_URL")) return null;
    if (!FONT_FALLBACK.test(code)) throw new Error(`Excalidraw adds a font CDN in a way vite.config.ts doesn't know, in ${id}`);
    return { code: code.replace(FONT_FALLBACK, "void 0"), map: null };
  },
};

/**
 * Excalidraw's fonts, served from the app's own address at a path named for its version, which the
 * drawing editor tells Excalidraw as `import.meta.env.EXCALIDRAW_ASSETS`: a build writes them among
 * its assets, and the dev server answers them from node_modules.
 */
const excalidrawFonts = (): Plugin => {
  const base = `/assets/excalidraw-${excalidrawVersion()}/`;
  const fonts = (readdirSync(EXCALIDRAW_FONTS, { recursive: true }) as string[]).filter((path) => extname(path) === ".woff2");
  return {
    name: "excalidraw-fonts",
    config: () => ({ define: { "import.meta.env.EXCALIDRAW_ASSETS": JSON.stringify(base) }, optimizeDeps: { rolldownOptions: { plugins: [noFontCdn] } } }),
    transform: noFontCdn.transform,
    configureServer(server) {
      server.middlewares.use(`${base}fonts/`, (req, res, next) => {
        const path = (req.url ?? "").split("?")[0]!.replace(/^\//, "");
        if (!fonts.includes(path)) return next();
        res.setHeader("Content-Type", "font/woff2");
        res.end(readFileSync(join(EXCALIDRAW_FONTS, path)));
      });
    },
    generateBundle() {
      for (const path of fonts) this.emitFile({ type: "asset", fileName: `${base.slice(1)}fonts/${path}`, source: readFileSync(join(EXCALIDRAW_FONTS, path)) });
    },
  };
};

// Builds only the web app; wrangler bundles the Worker, so one wrangler.jsonc serves dev, deploys, and Previews.
export default defineConfig(({ command }) => ({
  plugins: [react(), clipperDownload, excalidrawFonts(), command === "serve" && cloudflare({ persistState: { path: process.env.INK_STATE ?? ".wrangler/state" }, config: { vars: { DEV_SIGN_IN: "1", DEV_SERVER: "1", CLIPPER_EXTENSION_IDS: unpackedExtensionId() }, secrets: { required: ["SESSION_SECRET", ...inDevVars()] } } })],
  build: { outDir: "dist", emptyOutDir: true },
}));
