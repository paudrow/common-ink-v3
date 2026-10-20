import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, showTooltip, ViewPlugin, type Tooltip } from "@codemirror/view";
import { useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ago, useNow, type PluginHost, type Results } from "../../plugin-api.ts";
import { reasonOf } from "../lib/FoundNote.tsx";
import { writable } from "../lib/live.ts";
import { toldOf } from "./drawing.ts";
import { writtenNow } from "./sending.ts";
import { onItsOwnLine } from "./pasting.ts";
import { Thumb } from "./Thumb.tsx";

type Listed = Results["upload.list"]["uploads"][number];

/** As many as the popover lists: the latest, which is what a member looking for one mostly wants. More are found by typing. */
const SHOWN = 30;
/** How long typing rests before the uploads are asked for again. */
const PAUSE_MS = 150;

/** Opens the popover at a place in a note, or closes it with null. */
const asking = StateEffect.define<number | null>();

/**
 * "Insert an upload": a popover at the cursor in a note that finds an upload the member can see, by
 * the same query the Uploads page reads, and writes it there as pasting would have. The upload is
 * placed first (`upload.place`), so whoever reads the note sees it.
 */
export function inserter(host: PluginHost) {
  const editors = new Set<{ view: EditorView; noteId: string }>();

  async function insert(view: EditorView, noteId: string, upload: Listed) {
    if (!writable(view.state)) return void host.app().notify({ message: "You can read this note, and not change it." });
    let placed;
    try {
      placed = upload.access === "edit" ? await host.perform({ type: "upload.place", id: upload.id, noteId }) : upload;
    } catch (err) {
      return void host.app().notify({ message: `${upload.name} wasn't put in the note. ${reasonOf(err)}` });
    }
    host.uploads.learn([{ id: upload.id, upload: toldOf(placed) }]);
    const written = await writtenNow(host, placed);
    const at = view.state.field(open, false);
    if (at == null) return;
    // A file is a chip among the words. A picture, a video and a recording are drawn under a line of their own, as a pasted one is.
    if (placed.kind === "file") {
      view.dispatch({ changes: { from: at, insert: written }, selection: { anchor: at + written.length }, effects: asking.of(null), userEvent: "input.paste", scrollIntoView: true });
    } else {
      const line = view.state.doc.lineAt(at);
      const { from, to, insert, after } = onItsOwnLine(written, { from: line.from, text: line.text, last: line.number === view.state.doc.lines });
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: after }, effects: asking.of(null), userEvent: "input.paste", scrollIntoView: true });
    }
    view.focus();
  }

  const open = StateField.define<number | null>({
    create: () => null,
    update(at, tr) {
      for (const effect of tr.effects) if (effect.is(asking)) return effect.value;
      return at === null ? null : tr.changes.mapPos(at);
    },
  });

  const extension = ({ noteId }: { noteId: string }): Extension => {
    // One `create` for the editor, so the popover is the same element for as long as it is open, wherever the text moves it.
    const create = (view: EditorView) => {
      const dom = document.createElement("div");
      dom.className = "upload-insert";
      const root = createRoot(dom);
      const close = (refocus: boolean) => {
        view.dispatch({ effects: asking.of(null) });
        if (refocus) view.focus();
      };
      // A press elsewhere, in the note too, closes it and leaves the keyboard where it went.
      dom.addEventListener("focusout", (e) => !dom.contains(e.relatedTarget as Node | null) && view.state.field(open) !== null && close(false));
      root.render(<Picker host={host} onPick={(upload) => void insert(view, noteId, upload)} onClose={() => close(true)} />);
      return { dom, destroy: () => queueMicrotask(() => root.unmount()) };
    };
    return [
      open,
      showTooltip.from(open, (at): Tooltip | null => (at === null ? null : { pos: at, above: false, create })),
      ViewPlugin.define((view) => {
        const editor = { view, noteId };
        editors.add(editor);
        return { destroy: () => void editors.delete(editor) };
      }),
    ];
  };

  return {
    extension,
    /** Opens the popover at the cursor of the note whose editor has the keyboard. */
    ask() {
      const editor = [...editors].find((e) => e.view.hasFocus);
      if (editor) editor.view.dispatch({ effects: asking.of(editor.view.state.selection.main.head) });
    },
  };
}

function Picker({ host, onPick, onClose }: { host: PluginHost; onPick: (upload: Listed) => void; onClose: () => void }) {
  const ids = useId();
  const now = useNow();
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [found, setFound] = useState<{ uploads: Listed[] } | { problem: string } | null>(null);
  const [active, setActive] = useState(0);
  const picked = useRef(false);
  const pick = (upload: Listed) => {
    if (picked.current) return;
    picked.current = true;
    onPick(upload);
  };

  useEffect(() => field.current?.focus(), []);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(
      () =>
        void host.perform({ type: "upload.list", query: text.trim(), limit: SHOWN }).then(
          ({ uploads }) => live && (setFound({ uploads }), setActive(0)),
          (err: unknown) => live && setFound({ problem: reasonOf(err) }),
        ),
      text ? PAUSE_MS : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [host, text]);

  const uploads = found && "uploads" in found ? found.uploads : [];
  const at = Math.min(active, uploads.length - 1);
  return (
    <div role="dialog" aria-label="Insert an upload">
      <input
        ref={field}
        type="search"
        role="combobox"
        aria-label="Find an upload"
        aria-expanded={uploads.length > 0}
        aria-controls={`${ids}-list`}
        aria-activedescendant={at >= 0 ? `${ids}-${at}` : undefined}
        placeholder="Find an upload: name, type:image"
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          const count = uploads.length;
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && count) {
            e.preventDefault();
            setActive((at + (e.key === "ArrowDown" ? 1 : count - 1)) % count);
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (at >= 0) pick(uploads[at]!);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      />
      {found && "problem" in found && <p className="upload-insert-none">{found.problem}</p>}
      {found && "uploads" in found && !uploads.length && <p className="upload-insert-none">{text.trim() ? "No uploads match." : "There are no uploads yet."}</p>}
      {uploads.length > 0 && (
        <ul id={`${ids}-list`} role="listbox" aria-label="Uploads">
          {uploads.map((upload, i) => (
            <li
              key={upload.id}
              id={`${ids}-${i}`}
              role="option"
              aria-selected={i === at}
              ref={(el) => void (i === at && el?.scrollIntoView({ block: "nearest" }))}
              // Pressed without taking the keyboard from the field, which would close the popover first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(upload)}
            >
              <Thumb host={host} upload={upload} />
              <span className="upload-name">{upload.name}</span>
              <small>{ago(upload.createdAt, now)}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
