import { kindOf } from "./filetypes.ts";
import type { Context } from "./operations.ts";
import { MAX_TRANSCRIBED_BYTES, OpError, type Results } from "./protocol.ts";
import { loadUpload } from "./uploads.ts";

/** What hears a recording: its bytes and the words to listen for in, what was said out. The Worker's is Workers AI's Whisper. */
export type Listener = (audio: Uint8Array, prompt: string | undefined) => Promise<string>;

export const NO_LISTENER = "Transcription isn't set up here: the server has no Workers AI binding. On this machine, `npm run dev -- --ai` turns it on.";

/**
 * The prompt Whisper is told a workspace's vocabulary in: its words in a sentence, as a transcript
 * that has them spelled the workspace's way, which is what Whisper follows. Undefined for none.
 */
export function promptOf(words: string): string | undefined {
  const each = [...new Set(words.split(/[\n,]/).map((word) => word.trim()).filter(Boolean))];
  return each.length ? `${each.join(", ")}.` : undefined;
}

/** The workspace's vocabulary as it was written, empty until it is. */
export async function readVocabulary(ctx: Context): Promise<string> {
  const row = await ctx.db.prepare("SELECT vocabulary FROM workspaces WHERE id = ?").bind(ctx.workspaceId).first<{ vocabulary: string }>();
  return row?.vocabulary ?? "";
}

/** Replaces the workspace's vocabulary: the last write is what it is. */
export async function writeVocabulary(ctx: Context, words: string): Promise<Results["vocabulary.write"]> {
  await ctx.db.prepare("UPDATE workspaces SET vocabulary = ?1 WHERE id = ?2").bind(words, ctx.workspaceId).run();
  return { words };
}

/**
 * The words said in a recording, heard with the workspace's vocabulary, for someone who can change
 * it: what it answers is for writing beside it, and each minute is paid for. A recording too long to
 * pay for is refused before a byte of it is read.
 */
export async function transcribeUpload(ctx: Context, id: string): Promise<Results["upload.transcribe"]> {
  const row = await loadUpload(ctx, id, "edit", "refused");
  if (kindOf(row.type) !== "audio") throw new OpError("invalid", `${row.name} isn't a recording, so it can't be transcribed`);
  if (row.size > MAX_TRANSCRIBED_BYTES) throw new OpError("invalid", `${row.name} is too long to transcribe: a recording can be at most ${MAX_TRANSCRIBED_BYTES / 1024 / 1024} MB`);
  const { bucket, listen } = ctx.files;
  if (!listen || !bucket) throw new OpError("unavailable", NO_LISTENER);
  const object = await bucket.get(row.id);
  if (!object) throw new OpError("not_found", "No such upload");
  const audio = new Uint8Array(await object.arrayBuffer());
  let text;
  try {
    text = await listen(audio, promptOf(await readVocabulary(ctx)));
  } catch (err) {
    console.error("Whisper failed", err instanceof Error ? err.name : typeof err);
    throw new OpError("unavailable", `${row.name} couldn't be transcribed just now. Try again in a moment.`);
  }
  return { text: text.trim() };
}
