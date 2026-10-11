import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { Dispose, PluginHost, Upload } from "../../plugin-api.ts";
import { reasonOf } from "../lib/FoundNote.tsx";
import { writable } from "../lib/live.ts";
import { toldOf } from "./drawing.ts";
import { uploadPath, writtenFor } from "./finding.ts";
import { droppedFiles, onItsOwnLine, pastedFiles, refusal } from "./pasting.ts";

type Size = { width: number; height: number };

/** How long a browser is given to say how large a picture or a video is before the file is sent without. */
const MEASURE_MS = 4000;

const whenever = <T>(promise: Promise<T>, otherwise: T) => Promise.race([promise.catch(() => otherwise), new Promise<T>((done) => setTimeout(() => done(otherwise), MEASURE_MS))]);

/**
 * How large a picture or a video is, read in this browser before the file is sent, so its embed is
 * written with its room and nothing moves when it loads. Null for any other file, and for one the browser can't read.
 */
export function measured(file: File): Promise<Size | null> {
  const [picture, video] = [file.type.startsWith("image/"), file.type.startsWith("video/")];
  if (!picture && !video) return Promise.resolve(null);
  const address = URL.createObjectURL(file);
  const reading = new Promise<Size | null>((done) => {
    if (picture) {
      const img = new Image();
      img.onload = () => done(img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null);
      img.onerror = () => done(null);
      img.src = address;
    } else {
      const player = document.createElement("video");
      player.preload = "metadata";
      player.muted = true;
      player.onloadedmetadata = () => done(player.videoWidth > 0 && player.videoHeight > 0 ? { width: player.videoWidth, height: player.videoHeight } : null);
      player.onerror = () => done(null);
      player.src = address;
    }
  });
  return whenever(reading, null).finally(() => URL.revokeObjectURL(address));
}

/** One file on its way. */
export interface Sending {
  id: number;
  name: string;
  size: number;
  sent: number;
}

/** Where in a note the files being sent are to be written, kept through whatever is typed meanwhile. */
const placing = StateEffect.define<{ key: number; pos: number | null }>();
const places = StateField.define<ReadonlyMap<number, number>>({
  create: () => new Map(),
  update(value, tr) {
    const moved = tr.effects.some((e) => e.is(placing));
    if (!tr.docChanged && !moved) return value;
    const next = new Map([...value].map(([key, pos]) => [key, tr.changes.mapPos(pos, 1)]));
    for (const effect of tr.effects) {
      if (!effect.is(placing)) continue;
      if (effect.value.pos === null) next.delete(effect.value.key);
      else next.set(effect.value.key, effect.value.pos);
    }
    return next;
  },
});

/**
 * Sends files to the workspace, one after another, and says how far each has got. A file that is
 * too large is refused here, before any of it is sent, and the server's own refusal is said as it
 * gave it. Into a note, each file is written as its embed on a line of its own once the server has
 * it, as an edit by the member, so nothing in the note moves while it is on its way.
 */
export function sender(host: PluginHost) {
  let ids = 0;
  let sending: readonly Sending[] = [];
  const listeners = new Set<() => void>();
  const set = (next: readonly Sending[]) => {
    sending = next;
    for (const listener of [...listeners]) listener();
  };
  const editors = new Set<{ view: EditorView; noteId: string }>();

  /** Sends one file. Null when it was refused, which the member has been told. */
  async function send(file: File, to: { folderId?: string; private?: boolean }): Promise<{ upload: Upload; size: Size | null } | null> {
    const no = refusal(file);
    if (no) {
      host.app().notify({ message: no });
      return null;
    }
    const one: Sending = { id: ++ids, name: file.name, size: file.size, sent: 0 };
    set([...sending, one]);
    try {
      const size = await measured(file);
      const upload = await host.uploads.send(file, { name: file.name, ...to }, (sent) => set(sending.map((s) => (s.id === one.id ? { ...s, sent } : s))));
      host.uploads.learn([{ id: upload.id, upload: toldOf(upload) }]);
      return { upload, size };
    } catch (err) {
      host.app().notify({ message: `${file.name} wasn't uploaded. ${reasonOf(err)}` });
      return null;
    } finally {
      set(sending.filter((s) => s.id !== one.id));
    }
  }

  /** Sends files for the Uploads page, to a folder. The ones the server took. */
  async function sendAll(files: readonly File[], to: { folderId?: string }): Promise<Upload[]> {
    const taken: Upload[] = [];
    for (const file of files) {
      const sent = await send(file, to);
      if (sent) taken.push(sent.upload);
    }
    return taken;
  }

  /**
   * Sends files for a note and writes each where they were pasted, dropped or picked: to the note's
   * own folder, and private when the note is, so a picture isn't shown to people the note is hidden from.
   */
  async function intoNote(view: EditorView, noteId: string, files: readonly File[], at: number, userEvent: string) {
    if (!files.length) return;
    if (!writable(view.state)) return void host.app().notify({ message: "You can read this note, and not change it." });
    const note = host.app().notes?.find((n) => n.id === noteId);
    const key = ++ids;
    view.dispatch({ effects: placing.of({ key, pos: at }) });
    const there = () => [...editors].some((e) => e.view === view);
    for (const file of files) {
      const sent = await send(file, { folderId: note?.folderId ?? undefined, private: note?.private || undefined });
      if (!sent) continue;
      const pos = there() ? view.state.field(places, false)?.get(key) : undefined;
      if (pos === undefined || !writable(view.state)) {
        const { upload } = sent;
        host.app().notify({ message: `${upload.name} was uploaded, and its note has closed.`, action: { label: "Show it", run: () => host.app().go(uploadPath(upload.id)) } });
        continue;
      }
      const line = view.state.doc.lineAt(pos);
      const { from, to, insert, end, after } = onItsOwnLine(writtenFor(sent.upload, sent.size), { from: line.from, text: line.text, last: line.number === view.state.doc.lines });
      const { head } = view.state.selection.main;
      // A cursor still where the file was put goes to the line under it, to go on writing.
      const follow = view.state.selection.main.empty && head >= line.from && head <= line.to;
      view.dispatch({ changes: { from, to, insert }, effects: placing.of({ key, pos: end }), ...(follow && { selection: { anchor: after } }), userEvent, scrollIntoView: follow });
    }
    if (there()) view.dispatch({ effects: placing.of({ key, pos: null }) });
  }

  /** Asks the member for files, as a click on a file field does. */
  function pick(taken: (files: File[]) => void) {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    input.addEventListener("change", () => {
      taken([...(input.files ?? [])]);
      input.remove();
    });
    input.addEventListener("cancel", () => input.remove());
    document.body.append(input);
    input.click();
  }

  const extension = ({ noteId }: { noteId: string }): Extension => [
    places,
    ViewPlugin.define((view) => {
      const editor = { view, noteId };
      editors.add(editor);
      return { destroy: () => void editors.delete(editor) };
    }),
    EditorView.domEventHandlers({
      paste(event, view) {
        const files = event.clipboardData ? pastedFiles<File>(event.clipboardData) : [];
        if (!files.length) return false;
        event.preventDefault();
        void intoNote(view, noteId, files, view.state.selection.main.head, "input.paste");
        return true;
      },
      dragover(event) {
        // Said to be a place to drop a file, or the browser opens the file in place of the app.
        if (!event.dataTransfer?.types.includes("Files")) return false;
        event.preventDefault();
        return true;
      },
      drop(event, view) {
        const files = event.dataTransfer ? droppedFiles<File>(event.dataTransfer) : [];
        if (!files.length) return false;
        event.preventDefault();
        void intoNote(view, noteId, files, view.posAtCoords({ x: event.clientX, y: event.clientY }, false), "input.drop");
        return true;
      },
    }),
  ];

  return {
    extension,
    sendAll,
    pick,
    /** Asks for files and writes them into the note whose editor has the keyboard, at its cursor. */
    pickIntoNote() {
      const editor = [...editors].find((e) => e.view.hasFocus);
      if (!editor) return;
      pick((files) => {
        if (editors.has(editor)) void intoNote(editor.view, editor.noteId, files, editor.view.state.selection.main.head, "input.paste");
      });
    },
    sending: () => sending,
    subscribe(listener: () => void): Dispose {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export type Sender = ReturnType<typeof sender>;
