// The id Chrome gives the unpacked clipper: the key in extension/manifest.json fixes it, as the
// first 128 bits of the key's SHA-256 written with the letters a to p. The dev server and the tests
// allow this id alone, so a clipper loaded from extension/dist signs in to them.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function unpackedExtensionId(manifest = "extension/manifest.json"): string {
  const { key } = JSON.parse(readFileSync(manifest, "utf8")) as { key: string };
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
}
