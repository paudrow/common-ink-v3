// Common Ink v2 once registered a service worker on commonink.app (/sw.js, cache "common-ink-app-v1").
// Browsers keep it until they find a new /sw.js there, so this one takes its place and removes
// itself: it deletes that cache and unregisters. v3 registers no service worker of its own.

export const SW_PATH = "/sw.js";

const SOURCE = `// Retires the service worker Common Ink v2 left on this address.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .delete("common-ink-app-v1")
      .then(() => self.registration.unregister())
      .then(() => undefined),
  );
});
`;

/** The retiring worker. Checked on every visit, so it is never kept. */
export const swResponse = () =>
  new Response(SOURCE, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
