import { IMAGE_ENDINGS, kindOf, typeOf } from "../../../src/core/filetypes.ts";
import { PART_BYTES } from "../../../src/core/parts.ts";
import type { ClipImage, ImageMissReason } from "./types.ts";

export type ImagePlan = { action: "upload"; name: string; bytes: Uint8Array } | { action: "miss"; reason: ImageMissReason };

export function placeId(image: ClipImage): string | null {
  if (image.source.kind === "remote") return image.source.url;
  if (image.source.kind === "inline") return image.key;
  return null;
}

export function imageBox(
  uploaded: { width: number | null; height: number | null },
  measured: { width: number | null; height: number | null },
): { width: number; height: number } | null {
  if (uploaded.width && uploaded.height && uploaded.width > 0 && uploaded.height > 0) return { width: uploaded.width, height: uploaded.height };
  if (measured.width && measured.height && measured.width > 0 && measured.height > 0) return { width: measured.width, height: measured.height };
  return null;
}

export function planImage(bytes: Uint8Array | null): ImagePlan {
  if (!bytes?.byteLength) return { action: "miss", reason: "unfetched" };
  if (bytes.byteLength > PART_BYTES) return { action: "miss", reason: "too-big" };
  const head = bytes.subarray(0, 65_536);
  for (const ending of IMAGE_ENDINGS) {
    const type = typeOf(`clip.${ending}`, head);
    if (kindOf(type) === "image") return { action: "upload", name: `clip.${ending}`, bytes };
  }
  return { action: "miss", reason: "not-image" };
}

export function inlineBytes(image: ClipImage): Uint8Array | null {
  if (image.source.kind !== "inline") return null;
  try {
    const binary = atob(image.source.base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * A host on this computer or its network: localhost names, and IPv4 and IPv6 literals that are
 * loopback, private, link-local or unspecified. A page names its images, so it could aim the
 * extension, which has every site's permission, at a router or a dev server and clip what it says.
 */
export function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const v4 = ipv4(host);
  if (v4) return privateV4(v4);
  if (!host.startsWith("[")) return false;
  const v6 = ipv6(host.slice(1, -1));
  if (!v6) return true;
  if (v6.slice(0, 7).every((word) => word === 0) && v6[7]! <= 1) return true;
  if (v6.slice(0, 5).every((word) => word === 0) && v6[5] === 0xffff) return privateV4([v6[6]! >> 8, v6[6]! & 255, v6[7]! >> 8, v6[7]! & 255]);
  return (v6[0]! & 0xfe00) === 0xfc00 || (v6[0]! & 0xffc0) === 0xfe80 || (v6[0]! & 0xffc0) === 0xfec0;
}

function ipv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  return parts.map(Number);
}

function privateV4([a, b]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127) || a! >= 224;
}

/** The eight words of an IPv6 address as the URL parser writes it: lowercase hex, with at most one `::`. */
function ipv6(address: string): number[] | null {
  const [head, tail, more] = address.split("::");
  if (more !== undefined) return null;
  const words = (part: string | undefined) => (part ? part.split(":").map((word) => parseInt(word, 16)) : []);
  const front = words(head);
  const back = words(tail);
  const out = tail === undefined ? front : [...front, ...Array<number>(8 - front.length - back.length).fill(0), ...back];
  return out.length === 8 && out.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? out : null;
}

/** The body, read until it passes `limit` bytes and no further. Null when it is longer. */
async function readUpTo(response: Response, limit: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      void reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

const fetchable = (url: URL) => (url.protocol === "http:" || url.protocol === "https:") && !privateHost(url.hostname);

export async function fetchImage(url: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!fetchable(parsed)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    // A redirect is not followed: it would be asked before its address could be checked, and an
    // extension's fetch hides where a redirect points, so an image behind one stays a link.
    const response = await fetchImpl(parsed.href, { credentials: "omit", redirect: "manual", signal: controller.signal });
    if (!response.ok) {
      void response.body?.cancel();
      return null;
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > PART_BYTES) {
      void response.body?.cancel();
      return null;
    }
    return await readUpTo(response, PART_BYTES);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
