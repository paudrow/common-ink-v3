import { applyD1Migrations, env } from "cloudflare:test";
import { sealLinksWith } from "../../src/core/linkSeal.ts";
import { vault } from "../../src/worker/vault.ts";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// The key share links are sealed under, which the Worker hands the core from SESSION_SECRET on every request.
sealLinksWith(vault("a key for sealing share links in tests, long enough")!);
