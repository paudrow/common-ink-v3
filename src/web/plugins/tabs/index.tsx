import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { EditorProps, Plugin } from "../../plugin-api.ts";
import { EditorGroups } from "./EditorGroups.tsx";
import { EMPTY_LAYOUT, editorReducer, focusedNoteId, isEditorLayout, type CloseScope, type EditorAction } from "./editorLayout.ts";

const CLOSES: { scope: CloseScope; id: string; title: string }[] = [
  { scope: "tab", id: "tab.close", title: "Close tab" },
  { scope: "others", id: "tab.closeOthers", title: "Close other tabs" },
  { scope: "left", id: "tab.closeLeft", title: "Close tabs to the left" },
  { scope: "right", id: "tab.closeRight", title: "Close tabs to the right" },
  { scope: "all", id: "tab.closeAll", title: "Close all tabs" },
];

export const tabs: Plugin = {
  id: "tabs",
  name: "Tabs and splits",
  activate(host) {
    const kept = host.storage.get("layout");
    let layout = isEditorLayout(kept) ? kept : EMPTY_LAYOUT;
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    };

    /**
     * The app's address names the focused group's active note, so every change to the layout goes
     * through here. Moving between notes already open isn't a step Back should retrace, so only an
     * open or a close adds to the browser's history.
     */
    const dispatch = (action: EditorAction) => {
      const next = editorReducer(layout, action);
      if (next !== layout) {
        layout = next;
        host.storage.set("layout", layout);
        for (const listener of [...listeners]) listener();
      }
      host.app().showNote(focusedNoteId(layout), { replace: action.type === "focus" || action.type === "activate" });
    };
    const onTab = (action: (tab: { groupId: string; noteId: string }) => EditorAction) => () => {
      const noteId = focusedNoteId(layout);
      if (noteId) dispatch(action({ groupId: layout.focusedGroupId, noteId }));
    };

    host.commands.register({ id: "tab.keep", title: "Keep tab open", run: onTab((tab) => ({ type: "pin", ...tab })) });
    for (const { scope, id, title } of CLOSES) host.commands.register({ id, title, run: onTab((tab) => ({ type: "close", scope, ...tab })) });
    host.commands.register({ id: "editor.splitRight", title: "Split editor right", run: onTab((tab) => ({ type: "split", side: "right", ...tab })) });

    function Editor({ app, renderNote }: EditorProps) {
      const shown = useSyncExternalStore(subscribe, () => layout);
      const titles = useMemo(() => app.notes && new Map(app.notes.map((n) => [n.id, n.title])), [app.notes]);
      const locked = useMemo(() => new Set((app.notes ?? []).filter((n) => n.private).map((n) => n.id)), [app.notes]);
      const home = app.path === "/";

      useEffect(() => {
        if (app.noteId && focusedNoteId(layout) !== app.noteId) dispatch({ type: "open", noteId: app.noteId, preview: true });
      }, [app.noteId]);
      useEffect(() => {
        const id = focusedNoteId(layout);
        if (home && id) app.showNote(id, { replace: true });
      }, [home]);

      return (
        <EditorGroups
          layout={shown}
          titleOf={(noteId) => (titles ? titles.get(noteId) || "Untitled" : "")}
          isPrivate={(noteId) => locked.has(noteId)}
          dispatch={dispatch}
          renderNote={(group, noteId) => renderNote(noteId, { onEdit: () => dispatch({ type: "pin", groupId: group.id, noteId }), corner: group === shown.groups.at(-1) })}
        />
      );
    }

    host.views.register("editor", { id: "tabs", component: Editor, open: (noteId, { preview }) => dispatch({ type: "open", noteId, preview }) });
  },
};
