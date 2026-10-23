import { execFileSync } from "node:child_process";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { unpackedExtensionId } from "./scripts/extension-id.ts";

// The Worker imports the site's pages, which are written, not committed.
execFileSync("npm", ["run", "--silent", "site"], { stdio: ["ignore", "ignore", "inherit"] });

// CI runs these in parts (--shard). Vitest parts the files by a hash of each path, which with CI's times left one
// part twice as long as another; dealt out in path order, the access matrix's files sit side by side, so each part
// gets its share.
class Dealt extends BaseSequencer {
  override async shard(files: TestSpecification[]) {
    const { index, count } = this.ctx.config.shard!;
    return [...files].sort((a, b) => (a.moduleId < b.moduleId ? -1 : 1)).filter((_, i) => i % count === index - 1);
  }
}

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Workers AI only runs on Cloudflare: tests hand the core a listener of their own (test/core/transcribe.test.ts).
      remoteBindings: false,
      miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("migrations"), CLIPPER_EXTENSION_IDS: unpackedExtensionId() } },
    }),
  ],
  test: {
    include: ["test/core/**/*.test.ts"],
    setupFiles: ["test/core/setup.ts"],
    sequence: { sequencer: Dealt },
    // A CI runner can stall for seconds at a time, and tests that take one to five seconds there have timed out at
    // vitest's five (agent-access, erase, third-party). A hung test still fails, a few seconds later.
    testTimeout: 15_000,
    // The stylesheet is read as text by a test, which an empty stand-in would pass.
    css: { include: [/style\.css/] },
  },
}));
