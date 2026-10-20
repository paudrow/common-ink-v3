import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["extension/test/**/*.test.ts"],
    environment: "node",
  },
});
