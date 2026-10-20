import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { problems } from "../../scripts/store-listing.ts";

const listing = () => JSON.parse(readFileSync("extension/store/listing.json", "utf8"));
const manifest = () => JSON.parse(readFileSync("extension/manifest.json", "utf8"));

test("the listing fits the store's limits and gives a reason for every permission the manifest asks for", () => {
  assert.deepEqual(problems(listing(), manifest()), []);
});

test("a permission added to the manifest without a reason, or a reason for one it no longer asks for, is named", () => {
  const asks = manifest();
  asks.permissions = [...asks.permissions.filter((p: string) => p !== "storage"), "tabs"];
  assert.deepEqual(problems(listing(), asks), ["The manifest asks for tabs and the listing gives no reason for it.", "The listing gives a reason for storage, which the manifest doesn't ask for."]);
});

test("a summary longer than the store takes, or one that differs from the manifest's description, is named", () => {
  const long = listing();
  long.storeListing.summary = "x".repeat(133);
  assert.deepEqual(problems(long, { ...manifest(), description: "x".repeat(133) }), ["The summary is 133 characters, over the store's 132."]);
  assert.deepEqual(problems(listing(), { ...manifest(), description: "Something else." }), ["The summary isn't the manifest's description, which the store shows as the summary."]);
});
