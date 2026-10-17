import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("migrations") } },
    }),
  ],
  test: {
    include: ["test/core/**/*.test.ts"],
    setupFiles: ["test/core/setup.ts"],
    // The stylesheet is read as text by a test, which an empty stand-in would pass.
    css: { include: [/style\.css/] },
  },
}));
