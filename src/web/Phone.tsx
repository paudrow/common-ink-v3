import type { ChangeSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons.tsx";
import { ALL_NOTES, BOX_PATTERN, SHARED_WITH_ME, folderTitle, type Folders } from "./plugin-api.ts";
import type { Route } from "./router.ts";

/**
 * On a phone the app is a stack of screens, one at a time: the sidebar at the top, then a folder's
 * list, then a note. A page, such as Todos, is a screen under the sidebar too. Up is the screen
 * above the one in front; the sidebar has none.
 */
export type Up = { to: "sidebar" } | { to: "folder"; folderId: string; label: string };

export function upFrom(route: Route, noteFolderId: string | null | undefined, folders: Folders | null): Up {
  const titled = (folderId: string): Up => ({ to: "folder", folderId, label: (folders && folderTitle(folders, folderId)) ?? "Notes" });
  if (route.kind === "note") return titled(noteFolderId === undefined ? ALL_NOTES : (noteFolderId ?? SHARED_WITH_ME));
  if (route.kind === "folder" && route.id !== ALL_NOTES && route.id !== SHARED_WITH_ME) {
    const parentId = folders?.byId.get(route.id)?.parentId;
    if (parentId) return titled(parentId);
  }
  return { to: "sidebar" };
}

/** What up says where it goes to the sidebar, which holds more than folders. */
const SIDEBAR_LABEL = "Workspace";

interface TopBarProps {
  up: Up;
  onUp: () => void;
  /** What is in front, or null for a note, whose own heading says it. */
  title: string | null;
  tools: ReactNode;
  inspector: { open: boolean; toggle: () => void } | null;
  /** Said under the title when saving failed, as the bottom bar says it on a wider screen. */
  failed: string | null;
}

export function TopBar({ up, onUp, title, tools, inspector, failed }: TopBarProps) {
  return (
    <header className="phone-top">
      <button type="button" className="phone-up" onClick={onUp}>
        <Icon name="back" />
        <span>{up.to === "sidebar" ? SIDEBAR_LABEL : up.label}</span>
      </button>
      <div className="phone-title">
        {title !== null && <h1>{title}</h1>}
        {failed && (
          <span className="phone-failed" role="status">
            {failed}
          </span>
        )}
      </div>
      <div className="phone-tools">
        {tools}
        {inspector && (
          <button type="button" className="icon-button" aria-label="Inspector" title="Inspector" aria-expanded={inspector.open} onClick={inspector.toggle}>
            <Icon name="info" />
          </button>
        )}
      </div>
    </header>
  );
}

export function NewNoteButton({ onCreate, refused }: { onCreate: () => void; refused: string | null }) {
  return (
    <button type="button" className="phone-new" aria-label="New note" title={refused ?? "New note"} aria-disabled={!!refused} onClick={() => refused === null && onCreate()}>
      <Icon name="edit" />
    </button>
  );
}

/** The editor that has the cursor, if one does. */
const focusedEditor = () => {
  const el = document.activeElement?.closest(".cm-editor");
  return el instanceof HTMLElement ? EditorView.findFromDOM(el) : null;
};

/** Typed at the cursor as if from the keyboard, so a completion that starts with it opens. */
const typing = (text: string) => (view: EditorView) => view.dispatch({ ...view.state.replaceSelection(text), userEvent: "input.type", scrollIntoView: true });

/**
 * A mark at the start of a line: what it puts there, and what of it is there already. A line's
 * indentation stays in front of it, and a mark of the same kind there already gives way to it, so a
 * bullet becomes a todo and `## ` becomes `# `.
 */
interface Mark {
  text: string;
  /** The mark, as this kind of mark is written, after the indentation. */
  is: RegExp;
  /** Another kind of mark this one replaces. */
  replaces: RegExp;
}

const MARKS = {
  heading: { text: "# ", is: /^# /, replaces: /^#{2,6} / },
  todo: { text: "- [ ] ", is: new RegExp(`^[-*+] ${BOX_PATTERN} `), replaces: /^[-*+] / },
  bullet: { text: "- ", is: new RegExp(`^[-*+] (?!${BOX_PATTERN} )`), replaces: new RegExp(`^[-*+] ${BOX_PATTERN} `) },
} satisfies Record<string, Mark>;

/** Puts the mark on each line the selection covers, or takes it off when every one has it. */
const marking = (mark: Mark) => (view: EditorView) => {
  const { state } = view;
  const numbers = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    // A selection that ends at the very start of a line doesn't cover that line.
    const last = state.doc.lineAt(range.empty || range.to === 0 ? range.to : range.to - 1).number;
    for (let n = first; n <= Math.max(first, last); n++) numbers.add(n);
  }
  const all = [...numbers].map((n) => {
    const line = state.doc.line(n);
    const indent = /^\s*/.exec(line.text)![0].length;
    return { from: line.from + indent, rest: line.text.slice(indent) };
  });
  // The blank lines between the ones chosen are left blank.
  const lines = all.length > 1 ? all.filter((line) => line.rest !== "") : all;
  const off = lines.every((line) => mark.is.test(line.rest));
  const changes: ChangeSpec[] = lines.map(({ from, rest }) => {
    const there = (mark.is.exec(rest) ?? mark.replaces.exec(rest))?.[0] ?? "";
    return { from, to: from + there.length, insert: off ? "" : mark.text };
  });
  view.dispatch({ changes: state.changes(changes), userEvent: "input", scrollIntoView: true });
};

interface Key {
  label: string;
  icon?: IconName;
  text?: string;
  run: () => void;
}

/**
 * Over the on-screen keyboard: what a phone's keyboard has no key for. `covered` is how much of the
 * page that keyboard covers; the row sits on top of it.
 */
export function KeyRow({ covered, run, has }: { covered: number; run: (commandId: string) => void; has: (commandId: string) => boolean }) {
  const inEditor = (act: (view: EditorView) => void) => () => {
    const view = focusedEditor();
    if (view) act(view);
  };
  const command = (id: string, label: string, icon: IconName): Key[] => (has(id) ? [{ label, icon, run: () => run(id) }] : []);
  const keys: Key[] = [
    ...command("history.undo", "Undo", "restore"),
    ...command("bullets.outdent", "Outdent", "outdent"),
    ...command("bullets.indent", "Indent", "indent"),
    { label: "Heading", text: "#", run: inEditor(marking(MARKS.heading)) },
    { label: "Todo", icon: "check", run: inEditor(marking(MARKS.todo)) },
    { label: "Bullet", icon: "list", run: inEditor(marking(MARKS.bullet)) },
    { label: "Link", text: "[[", run: inEditor(typing("[[")) },
    { label: "Mention", icon: "at", run: inEditor(typing("@")) },
    { label: "Tag", icon: "tag", run: inEditor(typing("#")) },
    { label: "Embed", icon: "slash", run: inEditor(typing("/")) },
  ];
  return (
    // A press here keeps the cursor where it is: the keyboard would close if the editor lost it.
    <div className="phone-keys" role="toolbar" aria-label="Keys" style={{ bottom: covered }} onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()}>
      <div className="phone-keys-row">
        {keys.map((key) => (
          <button key={key.label} type="button" aria-label={key.label} title={key.label} onClick={key.run}>
            {key.icon ? <Icon name={key.icon} /> : <span className="phone-key-text">{key.text}</span>}
          </button>
        ))}
      </div>
      <button type="button" className="phone-keys-done" aria-label="Hide keyboard" title="Hide keyboard" onClick={() => (document.activeElement as HTMLElement | null)?.blur()}>
        <Icon name="keyboard" />
      </button>
    </div>
  );
}
