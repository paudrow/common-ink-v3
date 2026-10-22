/** The longest a recording made in a note runs before it stops of itself: long enough for a thought, short enough to transcribe. */
export const MAX_RECORDING_MS = 10 * 60_000;

/**
 * The types a browser may record in, best first, each with the ending its file is named by. The
 * ending is what the server reads a file's kind from with its first bytes, so a WebM of sound alone
 * is `.weba`, which is a recording, where `.webm` would be a video.
 */
const RECORDED = [
  { type: "audio/webm;codecs=opus", ending: "weba" },
  { type: "audio/webm", ending: "weba" },
  { type: "audio/ogg;codecs=opus", ending: "ogg" },
  { type: "audio/mp4", ending: "m4a" },
] as const;

export type Recorded = (typeof RECORDED)[number];

/** The first type this browser records sound in, or null for one that records none of them. */
export const recordedType = (supports: (type: string) => boolean): Recorded | null => RECORDED.find((r) => supports(r.type)) ?? null;

/** How long a recording has run, as a clock reads: `0:07`, `1:30`, `10:00`. */
export function clockOf(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** What a recording is called in the workspace, from when it was begun: `Recording 2026-10-22 at 09.41.weba`. */
export function recordingName(begun: Date, ending: string): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `Recording ${begun.getFullYear()}-${two(begun.getMonth() + 1)}-${two(begun.getDate())} at ${two(begun.getHours())}.${two(begun.getMinutes())}.${ending}`;
}

/** Why the microphone couldn't be had, in words for the member, from what the browser threw. */
export function refusedBecause(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Common Ink isn't allowed to use your microphone. Allow it in your browser's settings for this site, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found. Connect one, then try again.";
  if (name === "NotReadableError" || name === "AbortError") return "Your microphone is busy in another app. Close it there, then try again.";
  return "Your microphone couldn't be started.";
}
