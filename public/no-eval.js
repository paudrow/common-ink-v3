// zod tries `new Function` once, when it builds its first object schema, to see whether it may compile
// its parsers, and the page's policy reports that try as a refused eval. It parses the same without it.
// A plain script runs before any module, so no order the bundler gives the app's chunks can build a
// schema before zod reads this (zod keeps a `__zod_globalConfig` it finds).
globalThis.__zod_globalConfig = { jitless: true };
