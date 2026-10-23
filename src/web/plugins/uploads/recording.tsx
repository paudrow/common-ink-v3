import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, showTooltip, ViewPlugin, type Tooltip } from "@codemirror/view";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Dispose, InsertAt, PluginHost } from "../../plugin-api.ts";
import { writable } from "../lib/live.ts";
import { clockOf, MAX_RECORDING_MS, recordedType, recordingName, refusedBecause, type Recorded } from "./recorded.ts";
import type { Sender } from "./sending.ts";
import type { Transcriber } from "./transcribing.ts";

/** Speech is clear at 32 kbps of Opus, so ten minutes is about 2.4 MB: well under what is transcribed. */
const BITS_PER_SECOND = 32_000;

/** Saves `file` on this computer, as a link to download it would. */
function download(file: File) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

/** Where in a note the recorder hangs, which is where the recording is written once it stops, or null while there is none. */
const hanging = StateEffect.define<number | null>();
const recorderAt = StateField.define<number | null>({
  create: () => null,
  update(at, tr) {
    for (const effect of tr.effects) if (effect.is(hanging)) return effect.value;
    return at === null ? null : tr.changes.mapPos(at, 1);
  },
});

/** Where a recording has got to: waiting on the browser for the microphone, recording since a moment, or refused it with words that say why. */
export type Phase = { kind: "asking" } | { kind: "recording"; since: number } | { kind: "refused"; reason: string };

/** The one recording there can be at a time, for there is one microphone: in which editor, how far it has got, and what it has recorded so far. */
interface Session {
  view: EditorView;
  noteId: string;
  phase: Phase;
  begun: Date;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  type?: Recorded;
  chunks: Blob[];
  limit?: ReturnType<typeof setTimeout>;
}

/** What the recorder answers to, from its buttons and from the bar. */
interface Controls {
  stop(transcribe?: boolean): void;
  cancel(): void;
  close(): void;
}

/**
 * Recording in a note: the microphone recorded right where the cursor is, in a small recorder that
 * says how long it has run, and the recording sent and written there as `/audio(id)` once it is
 * stopped, as a file picked there would be, with what was said written under it when asked. The note can be typed in meanwhile. Leaving the note
 * stops the recording and keeps it in the workspace, which is said. A recording runs ten minutes at most.
 */
export function recorder(host: PluginHost, sending: Sender, transcribing: Transcriber) {
  const editors = new Set<{ view: EditorView; noteId: string }>();
  let session: Session | null = null;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  const subscribe = (listener: () => void): Dispose => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const phase = () => session?.phase ?? null;

  const warnBeforeLeaving = (e: BeforeUnloadEvent) => e.preventDefault();

  /** Ends the session: the microphone let go, the recorder taken from the note, and what was recorded handed back. */
  function end(done: Session): Promise<Blob[]> {
    if (session === done) session = null;
    clearTimeout(done.limit);
    removeEventListener("beforeunload", warnBeforeLeaving);
    const recorded = new Promise<Blob[]>((settle) => {
      const recorder = done.recorder;
      if (!recorder || recorder.state === "inactive") return settle(done.chunks);
      recorder.addEventListener("stop", () => settle(done.chunks), { once: true });
      recorder.stop();
    });
    return recorded.finally(() => {
      for (const track of done.stream?.getTracks() ?? []) track.stop();
      const at = done.view.state.field(recorderAt, false);
      if (at != null) done.view.dispatch({ effects: hanging.of(null) });
      changed();
    });
  }

  /**
   * Stops recording and writes the recording where the recorder hung, or keeps it in the workspace,
   * said, once its note has closed. Asked to, it then transcribes it under its line.
   */
  async function stop(done: Session, transcribe = false) {
    const at = done.view.state.field(recorderAt, false);
    const chunks = await end(done);
    if (!done.type) return;
    if (!chunks.length) return void host.app().notify({ message: "Nothing was recorded." });
    const file = new File(chunks, recordingName(done.begun, done.type.ending), { type: done.type.type.split(";")[0] });
    const written = await sending.intoNote(done.view, done.noteId, [file], at ?? done.view.state.doc.length, "input.paste");
    // Not sent, said by the sender: the recording is still here, to keep on this computer.
    if (!written.length && [...editors].some((e) => e.view === done.view)) host.app().notify({ message: `${file.name} is kept on this computer until this notice goes.`, action: { label: "Download it", run: () => download(file) } });
    if (written[0] && transcribe) await transcribing.into(done.view, written[0].id);
  }

  async function begin(view: EditorView, noteId: string) {
    if (!writable(view.state)) return void host.app().notify({ message: "You can read this note, and not change it." });
    if (session) {
      if (session.view === view) return;
      return void host.app().notify({ message: "A recording is already running in another note. Stop it there first." });
    }
    const one: Session = { view, noteId, phase: { kind: "asking" }, begun: new Date(), chunks: [] };
    session = one;
    view.dispatch({ effects: hanging.of(view.state.selection.main.head) });
    changed();
    const refuse = (reason: string) => {
      if (session !== one) return;
      one.phase = { kind: "refused", reason };
      for (const track of one.stream?.getTracks() ?? []) track.stop();
      changed();
    };
    const type = typeof MediaRecorder === "undefined" ? null : recordedType((t) => MediaRecorder.isTypeSupported(t));
    if (!navigator.mediaDevices?.getUserMedia || !type) return refuse("This browser can't record sound.");
    try {
      one.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      return refuse(refusedBecause(err));
    }
    // Cancelled, or its note closed, while the browser asked.
    if (session !== one) return void one.stream.getTracks().forEach((track) => track.stop());
    one.type = type;
    try {
      one.recorder = new MediaRecorder(one.stream, { mimeType: type.type, audioBitsPerSecond: BITS_PER_SECOND });
      one.recorder.addEventListener("dataavailable", (e) => e.data.size && one.chunks.push(e.data));
      one.recorder.start(1000);
    } catch (err) {
      return refuse(refusedBecause(err));
    }
    one.begun = new Date();
    one.phase = { kind: "recording", since: Date.now() };
    one.limit = setTimeout(() => {
      host.app().notify({ message: `A recording stops at ${clockOf(MAX_RECORDING_MS)}, so this one was stopped and put in the note.` });
      void stop(one);
    }, MAX_RECORDING_MS);
    addEventListener("beforeunload", warnBeforeLeaving);
    changed();
  }

  const controlsOf = (view: EditorView): Controls => ({
    stop: (transcribe) => session?.view === view && void stop(session, transcribe),
    cancel: () => {
      if (session?.view !== view) return;
      void end(session);
      view.focus();
    },
    close: () => view.focus(),
  });

  const extension = ({ noteId }: { noteId: string }): Extension => {
    // One `create` for the editor, so the recorder is the same element for as long as it hangs there, wherever the text moves it.
    const create = (view: EditorView) => {
      const dom = document.createElement("div");
      dom.className = "upload-recorder";
      const root = createRoot(dom);
      root.render(<RecorderView phase={phase} subscribe={subscribe} controls={controlsOf(view)} />);
      return { dom, destroy: () => queueMicrotask(() => root.unmount()) };
    };
    return [
      recorderAt,
      showTooltip.from(recorderAt, (at): Tooltip | null => (at === null ? null : { pos: at, above: false, create })),
      ViewPlugin.define((view) => {
        const editor = { view, noteId };
        editors.add(editor);
        return {
          destroy() {
            editors.delete(editor);
            // A plugin is also taken down when the editor is set up again, which the note stays open through. The editor going is the note being left.
            setTimeout(() => {
              if (session?.view === view && !view.dom.isConnected) void stop(session);
            });
          },
        };
      }),
    ];
  };

  /** The note's editor that a command means: the one with the keyboard, or else the last one opened on the note in front. */
  const editorHere = () => {
    const inFront = host.app().noteId;
    const all = [...editors];
    return all.find((e) => e.view.hasFocus) ?? (inFront ? all.findLast((e) => e.noteId === inFront) : undefined);
  };

  return {
    extension,
    phase,
    subscribe,
    /** The insert of the menu item: begins recording where the item was picked, and answers at once with nothing to write, so the trigger goes. */
    ask({ anchor }: InsertAt): Promise<string | null> {
      const editor = [...editors].find((e) => e.view.scrollDOM.contains(anchor));
      if (!editor) return Promise.resolve(null);
      void begin(editor.view, editor.noteId);
      return Promise.resolve("");
    },
    /** The command: begins recording at the cursor of the note in front, or goes to the recorder already running. */
    run() {
      if (session) return void document.querySelector<HTMLElement>(".upload-recorder button:enabled")?.focus();
      const editor = editorHere();
      if (!editor) return void host.app().notify({ message: "Open a note to record into it." });
      void begin(editor.view, editor.noteId);
    },
    /** Stops the recording running, from the bar. */
    stop: () => session && void stop(session),
  };
}

export type Recorder = ReturnType<typeof recorder>;

/** The time since `since`, kept up to date each half second. */
function useClock(since: number): string {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  return clockOf(now - since);
}

function Elapsed({ since }: { since: number }) {
  return <span className="upload-recorder-clock">{useClock(since)}</span>;
}

function RecorderView({ phase, subscribe, controls }: { phase: () => Phase | null; subscribe: (listener: () => void) => Dispose; controls: Controls }) {
  const now = useSyncExternalStore(subscribe, phase);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), [now?.kind]);
  if (!now) return null;
  const keys = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (now.kind === "refused") controls.cancel();
    else controls.close();
  };
  return (
    <div role="dialog" aria-label="Recorder" onKeyDown={keys}>
      {now.kind === "refused" ? (
        <>
          <p className="upload-recorder-words" role="alert">
            {now.reason}
          </p>
          <div className="upload-recorder-buttons">
            <button ref={first} type="button" className="button small" onClick={controls.cancel}>
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="upload-recorder-words" role="status">
            <span className={`upload-recorder-dot${now.kind === "recording" ? " live" : ""}`} aria-hidden="true" />
            {now.kind === "asking" ? "Asking for your microphone…" : <>Recording <Elapsed since={now.since} /></>}
          </p>
          <div className="upload-recorder-buttons">
            <button ref={first} type="button" className="button small primary" disabled={now.kind !== "recording"} onClick={() => controls.stop()}>
              Stop
            </button>
            <button type="button" className="button small" disabled={now.kind !== "recording"} onClick={() => controls.stop(true)}>
              Stop and transcribe
            </button>
            <button type="button" className="button small" onClick={controls.cancel}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** The recording running, in the bottom bar, wherever the note has scrolled: how long it has run, and a press goes to the recorder. */
export function RecordingStatus({ recorder }: { recorder: Recorder }) {
  const now = useSyncExternalStore(recorder.subscribe, recorder.phase);
  if (now?.kind !== "recording") return null;
  return (
    <button type="button" className="bar-item upload-recording-status" aria-label="Recording: go to the recorder" onClick={() => document.querySelector<HTMLElement>(".upload-recorder button")?.focus()}>
      <span className="upload-recorder-dot live" aria-hidden="true" />
      Recording <Elapsed since={now.since} />
    </button>
  );
}
