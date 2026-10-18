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

export async function fetchImage(url: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetchImpl(url, { credentials: "omit", redirect: "follow", signal: controller.signal });
    if (!response.ok) return null;
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > PART_BYTES) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > PART_BYTES ? null : bytes;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
