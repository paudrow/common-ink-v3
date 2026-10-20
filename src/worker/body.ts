/**
 * A request's body as bytes, or null when it is longer than `max`. It is read as it arrives and given
 * up on past `max`, so a body sent in chunks with no Content-Length is never held whole.
 */
export async function cappedBody(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get("Content-Length") ?? 0) > max) return null;
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** The most an operation or an MCP message is. A note at its longest, MAX_NOTE_LENGTH characters, is 1.5 MB of UTF-8 when each is three bytes, and more again once JSON escapes it. */
export const MAX_OP_BYTES = 4_000_000;
/** The most any other body sent to the Worker is: it carries a few names, ids and options. */
export const MAX_FORM_BYTES = 16_384;

/** A body that was longer than the most its route reads. */
export class TooLarge extends Error {}

/** A request's body read as JSON, at most `max` bytes. Throws TooLarge past that, and SyntaxError for a body that isn't JSON. */
export async function cappedJson(req: Request, max: number): Promise<unknown> {
  const bytes = await cappedBody(req, max);
  if (!bytes) throw new TooLarge(`A body here is at most ${max} bytes`);
  return JSON.parse(new TextDecoder().decode(bytes));
}
