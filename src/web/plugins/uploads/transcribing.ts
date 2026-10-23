import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { callsIn, uploadIn, type PluginHost } from "../../plugin-api.ts";
import { reasonOf } from "../lib/FoundNote.tsx";
import { writable } from "../lib/live.ts";

/**
 * Where the words said in recording `uploadId` go in `text`: the end of the line that plays it, for
 * a line of their own under it, the line nearest `near` when the note plays it more than once. Null when no line does.
 */
export function underRecording(text: string, uploadId: string, near = 0): number | null {
  let best: { at: number; end: number } | null = null;
  for (const found of callsIn(text)) {
    if (found.name !== "audio" || uploadIn(found.config) !== uploadId) continue;
    const end = text.indexOf("\n", found.from);
    if (!best || Math.abs(found.from - near) < Math.abs(best.at - near)) best = { at: found.from, end: end === -1 ? text.length : end };
  }
  return best?.end ?? null;
}

/**
 * Transcribing a recording in a note: Whisper hears it on the server with the workspace's vocabulary,
 * and what was said is written on a line of its own under the line that plays it, as an edit by the
 * member that undo takes back. A note closed meanwhile is told, with the words to copy.
 */
export function transcriber(host: PluginHost) {
  const editors = new Set<EditorView>();

  function write(view: EditorView, uploadId: string, words: string, near?: number) {
    const at = editors.has(view) && writable(view.state) ? underRecording(view.state.doc.toString(), uploadId, near) : null;
    if (at === null) {
      return void host.app().notify({ message: "The recording was transcribed, and its note has closed or no longer plays it.", action: { label: "Copy the words", run: () => void navigator.clipboard.writeText(words) } });
    }
    view.dispatch({ changes: { from: at, insert: `\n${words}` }, userEvent: "input.transcribe" });
  }

  /** Transcribes recording `uploadId` and writes what was said under it in `view`, near `near`. False when nothing was written. */
  async function into(view: EditorView, uploadId: string, near?: () => number | undefined): Promise<boolean> {
    let text: string;
    try {
      ({ text } = await host.perform({ type: "upload.transcribe", id: uploadId }));
    } catch (err) {
      host.app().notify({ message: `The recording wasn't transcribed. ${reasonOf(err)}` });
      return false;
    }
    if (!text) {
      host.app().notify({ message: "No words were heard in the recording." });
      return false;
    }
    write(view, uploadId, text, near?.());
    return true;
  }

  /** What the Transcribe button on a recording does: transcribes it into the note it is drawn in, under its own line. */
  function fromEmbed(uploadId: string, drawn: HTMLElement): Promise<boolean> {
    const view = [...editors].find((v) => v.dom.contains(drawn));
    if (!view) {
      host.app().notify({ message: "Open the note to transcribe its recording into it." });
      return Promise.resolve(false);
    }
    return into(view, uploadId, () => (drawn.isConnected ? view.posAtDOM(drawn) : undefined));
  }

  const extension = (): Extension =>
    ViewPlugin.define((view) => {
      editors.add(view);
      return { destroy: () => void editors.delete(view) };
    });

  return { extension, into, fromEmbed };
}

export type Transcriber = ReturnType<typeof transcriber>;
