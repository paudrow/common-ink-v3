import { PART_BYTES } from "../../../src/core/parts.ts";

const ENDING = /\.(pdf|json|csv|txt|xml|md|markdown)$/i;

export interface DownloadedFile {
  name: string;
  title: string;
  url: string;
  bytes: Uint8Array;
}

export function urlLooksLikeDocument(url: string): boolean {
  try {
    return ENDING.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function isDocument(url: string, mime: string, name: string): boolean {
  const type = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("text/html") || type === "application/xhtml+xml") return false;
  if (type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/")) return false;
  if (type === "application/pdf" || type === "application/json" || type === "text/json" || type === "text/csv") return true;
  const named = ENDING.test(name) || urlLooksLikeDocument(url);
  if (!named) return false;
  return type === "" || type === "application/octet-stream" || type === "text/plain" || type === "application/xml" || type === "text/xml" || type === "text/markdown";
}

export async function fetchDocument(url: string, fetchImpl: typeof fetch = fetch): Promise<DownloadedFile | "too-big" | null> {
  let response: Response;
  try {
    response = await fetchImpl(url, { credentials: "include", signal: AbortSignal.timeout(20_000) });
  } catch {
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const mime = response.headers.get("content-type") ?? "";
  const name = fileName(url, response.headers.get("content-disposition"), mime);
  if (!isDocument(url, mime, name)) {
    await response.body?.cancel();
    return null;
  }
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > PART_BYTES) {
    await response.body?.cancel();
    return "too-big";
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength) return null;
  if (bytes.byteLength > PART_BYTES) return "too-big";
  return { name, title: fileTitle(name, bytes), url, bytes };
}

export function fileName(url: string, disposition: string | null, mime: string): string {
  const star = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(disposition ?? "");
  if (star?.[1]) {
    try {
      const decoded = decodeURIComponent(star[1]).replace(/[/\\]/g, "").trim();
      if (decoded) return decoded;
    } catch {
      // The header was not encoded as UTF-8. The plain filename is next.
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition ?? "");
  const named = plain?.[1]?.replace(/[/\\]/g, "").trim();
  if (named) return named;
  try {
    const path = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
    if (path && path.includes(".")) return path;
  } catch {
    // The address is not a URL. The type decides the name.
  }
  if (mime.toLowerCase().includes("pdf")) return "document.pdf";
  if (mime.toLowerCase().includes("json")) return "document.json";
  return "document";
}

export function fileTitle(name: string, bytes: Uint8Array): string {
  if (name.toLowerCase().endsWith(".pdf") && ascii(bytes, 0, "%PDF-")) {
    const titled = pdfTitle(bytes);
    if (titled) return titled;
  }
  const bare = name.replace(/\.[A-Za-z0-9]{1,8}$/, "").replace(/[_-]+/g, " ").trim();
  return bare || name;
}

function pdfTitle(bytes: Uint8Array): string | null {
  const text = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.byteLength, 200_000)));
  const match = /\/Title\s*\(([^)]{1,300})\)/.exec(text);
  if (!match?.[1]) return null;
  const raw = match[1].replace(/\\([()\\nrt])/g, (_, ch: string) => (ch === "n" || ch === "r" || ch === "t" ? " " : ch));
  const cleaned = raw.replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim();
  return cleaned.length >= 2 ? cleaned.slice(0, 200) : null;
}

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
  return text.length <= bytes.length - at && [...text].every((ch, i) => bytes[at + i] === ch.charCodeAt(0));
}
