// The Chrome Web Store listing for the clipper, kept in extension/store/listing.json beside the
// manifest it describes. Checks it against the store's limits and the manifest, prints it in the
// order the developer dashboard asks for it, to paste field by field, and writes the zip to upload.
//
//   node scripts/store-listing.ts            check
//   node scripts/store-listing.ts --print    check, then print
//   node scripts/store-listing.ts --zip      check, then write extension/store/common-ink-clipper-<version>.zip

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { clipperFiles, clipperVersion, zip } from "../extension/bundle.ts";

interface Listing {
  storeListing: { name: string; summary: string; description: string[]; category: string; language: string; homepageUrl: string; supportUrl: string };
  privacyPractices: {
    singlePurpose: string;
    permissions: Record<string, string>;
    remoteCode: string;
    dataUsage: Record<string, string | false>;
    certifications: string[];
    privacyPolicyUrl: string;
  };
  assets: { icon: string; screenshots: string[]; smallPromoTile: string; marqueePromoTile: string };
}

/** The store's limits on each field, in characters. */
const LIMITS = { name: 75, summary: 132, description: 16_000, singlePurpose: 1_000, justification: 1_000 } as const;

/** The data the dashboard asks about, each to be answered: what is collected, or false. */
const DATA_KINDS = [
  "Personally identifiable information",
  "Health information",
  "Financial and payment information",
  "Authentication information",
  "Personal communications",
  "Location",
  "Web history",
  "User activity",
  "Website content",
];

const HOST = "hostPermissions";

export function problems(listing: Listing, manifest: { name: string; description: string; permissions?: string[]; host_permissions?: string[] }): string[] {
  const found: string[] = [];
  const over = (what: string, text: string, limit: number) => text.length > limit && found.push(`${what} is ${text.length} characters, over the store's ${limit}.`);
  const { storeListing: store, privacyPractices: privacy } = listing;
  over("The name", store.name, LIMITS.name);
  over("The summary", store.summary, LIMITS.summary);
  over("The description", store.description.join("\n"), LIMITS.description);
  over("The single purpose", privacy.singlePurpose, LIMITS.singlePurpose);
  if (store.name !== manifest.name) found.push(`The name "${store.name}" isn't the manifest's "${manifest.name}", which the store shows.`);
  if (store.summary !== manifest.description) found.push(`The summary isn't the manifest's description, which the store shows as the summary.`);
  const asked = [...(manifest.permissions ?? []), ...(manifest.host_permissions?.length ? [HOST] : [])];
  for (const permission of asked) if (!privacy.permissions[permission]?.trim()) found.push(`The manifest asks for ${permission} and the listing gives no reason for it.`);
  for (const [permission, reason] of Object.entries(privacy.permissions)) {
    if (!asked.includes(permission)) found.push(`The listing gives a reason for ${permission}, which the manifest doesn't ask for.`);
    over(`The reason for ${permission}`, reason, LIMITS.justification);
  }
  for (const kind of DATA_KINDS) if (!(kind in privacy.dataUsage)) found.push(`The data usage doesn't answer "${kind}".`);
  for (const kind of Object.keys(privacy.dataUsage)) if (!DATA_KINDS.includes(kind)) found.push(`"${kind}" isn't one of the store's kinds of data.`);
  return found;
}

function printed(listing: Listing): string {
  const { storeListing: store, privacyPractices: privacy, assets } = listing;
  const field = (name: string, value: string) => `## ${name}\n\n${value}\n`;
  return [
    "# Store listing\n",
    field("Item name (from the manifest)", store.name),
    field("Summary (from the manifest)", store.summary),
    field("Description", store.description.join("\n")),
    field("Category", store.category),
    field("Language", store.language),
    field("Homepage URL", store.homepageUrl),
    field("Support URL", store.supportUrl),
    field("Store icon", assets.icon),
    field("Screenshots", assets.screenshots.join("\n")),
    field("Small promo tile", assets.smallPromoTile),
    field("Marquee promo tile", assets.marqueePromoTile),
    "# Privacy practices\n",
    field("Single purpose description", privacy.singlePurpose),
    ...Object.entries(privacy.permissions).map(([permission, reason]) => field(`${permission === HOST ? "Host permission" : permission} justification`, reason)),
    field("Are you using remote code?", privacy.remoteCode),
    field(
      "Data usage",
      Object.entries(privacy.dataUsage)
        .map(([kind, what]) => (what ? `[x] ${kind}: ${what}` : `[ ] ${kind}`))
        .join("\n"),
    ),
    field("Certifications (tick all three)", privacy.certifications.map((c) => `[x] ${c}`).join("\n")),
    field("Privacy policy URL", privacy.privacyPolicyUrl),
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { print: { type: "boolean", default: false }, zip: { type: "boolean", default: false } } });
  const listing = JSON.parse(readFileSync("extension/store/listing.json", "utf8")) as Listing;
  const found = problems(listing, JSON.parse(readFileSync("extension/manifest.json", "utf8")));
  const missing = [listing.assets.icon.startsWith("extension/dist/") ? null : listing.assets.icon, ...listing.assets.screenshots, listing.assets.smallPromoTile, listing.assets.marqueePromoTile].filter(
    (path): path is string => path !== null && !existsSync(path),
  );
  for (const path of missing) found.push(`${path} isn't there. Run npm run store:assets.`);
  if (found.length) {
    console.error(found.join("\n"));
    process.exit(1);
  }
  if (values.print) console.log(printed(listing));
  if (values.zip) {
    const files = await clipperFiles();
    // The key fixes an unpacked build's id at the store's. The store gives the item its id and refuses a manifest with a key.
    const { key: _, ...manifest } = JSON.parse(new TextDecoder().decode(files.get("manifest.json")));
    files.set("manifest.json", new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
    const out = `extension/store/common-ink-clipper-${await clipperVersion()}.zip`;
    writeFileSync(out, zip(files));
    console.log(`Wrote ${out}.`);
  }
}
