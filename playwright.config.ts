import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.BASE_URL ?? "http://localhost:5198";

export default defineConfig({
  testDir: "test/browser",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  // A deployed preview answers each request in 100 to 500 ms, and a test that makes a hundred of them needs more than the usual 30 s there.
  timeout: process.env.CI ? 60_000 : 30_000,
  expect: { timeout: process.env.BASE_URL ? 15_000 : 5_000 },
  reporter: process.env.CI ? [["list"], ["blob"]] : "list",
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  // Firefox and Safari run only the smoke test, which walks the main paths: the whole suite in each would triple CI's time.
  // They run against the Worker on https (`scripts/built-worker.ts --https`), whose certificate is wrangler's own: WebKit keeps
  // the session cookie, which is Secure, only from https, even on localhost.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], ignoreHTTPSErrors: true }, testMatch: "smoke.spec.ts" },
    { name: "webkit", use: { ...devices["Desktop Safari"], ignoreHTTPSErrors: true }, testMatch: "smoke.spec.ts" },
  ],
  webServer: process.env.BASE_URL ? undefined : { command: "npm run dev -- --port 5198 --strictPort", url: baseURL, reuseExistingServer: true },
});
