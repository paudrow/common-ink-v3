import { env } from "cloudflare:test";
import { perform, type Actor } from "../../src/core/operations.ts";
import type { Upload } from "../../src/core/protocol.ts";
import type { Files } from "../../src/core/uploads.ts";

/** The smallest PNG there is: one transparent pixel. */
export const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

export const bytesOf = (text: string) => new TextEncoder().encode(text);

/** `bytes` as the body of a request carries them. */
export const carrying = (bytes: Uint8Array): Files => ({ bucket: env.FILES, body: new Response(bytes).body });
export const FILES: Files = { bucket: env.FILES };

/** Uploads `bytes` as `actor`, as the request for it does. */
export const upload = (actor: Actor, name: string, bytes: Uint8Array = PNG, more: { folderId?: string; private?: boolean } = {}, now = Date.now()): Promise<Upload> =>
  perform(env.DB, actor, { type: "upload.create", name, size: bytes.byteLength, ...more }, now, undefined, carrying(bytes));

/** The bytes an actor is given for an upload. */
export async function bytesFor(actor: Parameters<typeof perform>[1], id: string, asked?: Headers): Promise<Uint8Array> {
  const opened = await perform(env.DB, actor, actor.kind === "visitor" ? { type: "shared.upload", id } : { type: "upload.open", id }, Date.now(), undefined, { bucket: env.FILES, asked });
  return new Uint8Array(await new Response(opened.body).arrayBuffer());
}
