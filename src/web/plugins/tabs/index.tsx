import { useEffect, useMemo, useSyncExternalStore } from "react";
import { folderTitle, type EditorProps, type Opened, type Plugin } from "../../plugin-api.ts";
import { lifecycle } from "../lib/lifecycle.ts";
import { EditorGroups, showTabMenu } from "./EditorGroups.tsx";
import { editorReducer, focused, keptLayout, same, type CloseScope, type EditorAction } from "./editorLayout.ts";

/** Whether the tab in front is this one and, for a page, at this address. */
const inFront = (tab: Opened | null, opened: Opened) => same(tab, opened) && (tab?.kind !== "page" || opened.kind !== "page" || tab.path === opened.path);

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
  description: "Open notes in tabs, and side by side in splits.",
  icon: "tabs",
  activate(host) {
    let layout = keptLayout(host.storage.get("layout"));
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    };

    /**
     * The app's address names the focused group's active tab, so every change to the layout goes
     * through here. Back retraces every open and close. Moving between tabs already open is one
     * step however many moves it took, and never takes the place of an open.
     */
    /** The group whose tab in front is to take the cursor once it is drawn. */
    let cursorTo: string | null = null;
    const cursorPut = () => {
      if (cursorTo === null) return;
      cursorTo = null;
      for (const listener of [...listeners]) listener();
    };
    const dispatch = (action: EditorAction) => {
      const next = editorReducer(layout, action);
      if ((action.type === "split" || action.type === "send") && next !== layout) {
        // A tab split off or sent to another group leaves focus, which shows one group: the member sees where it went.
        host.app().setFocus(false);
        // It is drawn anew where it went, and what had the cursor in it is gone, so the cursor is put in it there.
        cursorTo = next.focusedGroupId;
      }
      if (next !== layout) {
        layout = next;
        host.storage.set("layout", layout);
        for (const listener of [...listeners]) listener();
      }
      // Dragging the edge of a split goes nowhere.
      if (action.type !== "resize") host.app().show(focused(layout), { move: action.type === "focus" || action.type === "activate" });
    };
    const onTab = (action: (at: { groupId: string; tab: Opened }) => EditorAction) => () => {
      const tab = focused(layout);
      if (tab) dispatch(action({ groupId: layout.focusedGroupId, tab }));
    };

    host.commands.register({ id: "tab.keep", title: "Keep tab open", group: "Navigation", run: onTab((tab) => ({ type: "pin", ...tab })) });
    for (const { scope, id, title } of CLOSES) host.commands.register({ id, title, group: "Navigation", run: onTab((tab) => ({ type: "close", scope, ...tab })) });
    host.commands.register({ id: "editor.splitRight", title: "Split editor right", group: "Navigation", run: onTab((tab) => ({ type: "split", side: "right", ...tab })) });
    host.commands.register({ id: "editor.splitDown", title: "Split editor down", group: "Navigation", run: onTab((tab) => ({ type: "split", side: "down", ...tab })) });
    host.commands.register({ id: "tab.moveToNextGroup", title: "Move tab to next group", group: "Navigation", run: onTab((tab) => ({ type: "send", to: "next", ...tab })) });
    host.commands.register({ id: "tab.moveToPreviousGroup", title: "Move tab to previous group", group: "Navigation", run: onTab((tab) => ({ type: "send", to: "previous", ...tab })) });
    host.commands.register({ id: "tab.menu", title: "Show tab menu", group: "Navigation", run: showTabMenu });

    const { items } = lifecycle(host);

    function Editor({ app, renderNote, renderFolder, renderPage, empty }: EditorProps) {
      const shown = useSyncExternalStore(subscribe, () => layout);
      const cursorGroup = useSyncExternalStore(subscribe, () => cursorTo);
      // A tab stays open on a note that was moved to Trash, so those are known by name too.
      const notes = useMemo(() => app.notes && new Map([...app.notes, ...app.trashed].map((n) => [n.id, n])), [app.notes, app.trashed]);
      const home = app.path === "/";

      useEffect(() => {
        if (app.opened && !inFront(focused(layout), app.opened)) dispatch({ type: "open", tab: app.opened, preview: true });
      }, [app.opened]);
      useEffect(() => {
        const tab = focused(layout);
        if (home && tab) app.show(tab, { replace: true });
      }, [home]);

      const pages = useMemo(() => new Map(app.pages.map((p) => [p.id, p])), [app.pages]);
      const titleOf = (tab: Opened) =>
        tab.kind === "page" ? (pages.get(tab.id)?.label ?? "Page") : tab.kind === "folder" ? (app.folders ? (folderTitle(app.folders, tab.id) ?? "Folder") : "") : notes ? notes.get(tab.id)?.title || "Untitled" : "";

      return (
        <EditorGroups
          layout={shown}
          titleOf={titleOf}
          iconOf={(tab) => (tab.kind === "folder" ? "folders" : tab.kind === "page" ? pages.get(tab.id)?.icon : undefined)}
          isPrivate={(tab) => (tab.kind === "note" && notes?.get(tab.id)?.private) ?? false}
          noteItems={(tab) => (tab.kind === "note" ? items(notes?.get(tab.id)) : [])}
          dispatch={dispatch}
          render={(group, tab) =>
            tab.kind === "folder"
              ? renderFolder(tab.id)
              : tab.kind === "page"
                ? renderPage(tab.id, tab.path)
                : renderNote(tab.id, { onEdit: () => dispatch({ type: "pin", groupId: group.id, tab }), focus: group.id === cursorGroup, onFocused: cursorPut })
          }
          empty={empty}
          cursorTo={cursorGroup}
          onCursorPut={cursorPut}
          focusMode={{
            on: app.focus,
            keys: host.commands.list().find((c) => c.id === "view.toggleFocus")?.shortcut,
            // Asked for on a group, focus turns to that group first, so what fills the window is its tab in front.
            toggle: (groupId) => {
              if (groupId !== layout.focusedGroupId) dispatch({ type: "focus", groupId });
              app.setFocus(!app.focus);
            },
          }}
        />
      );
    }

    host.views.register("editor", {
      id: "tabs",
      component: Editor,
      open: (tab, { preview, background }) => dispatch({ type: "open", tab, preview, background }),
      split: (tab, side) => dispatch({ type: "split", groupId: layout.focusedGroupId, side, tab, keep: true }),
    });
  },
};
