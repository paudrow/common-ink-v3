import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { unpackedExtensionId } from "./scripts/extension-id.ts";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("migrations"), CLIPPER_EXTENSION_IDS: unpackedExtensionId() } },
    }),
  ],
  test: {
    include: ["test/core/**/*.test.ts"],
    setupFiles: ["test/core/setup.ts"],
    // The stylesheet is read as text by a test, which an empty stand-in would pass.
    css: { include: [/style\.css/] },
  },
}));
