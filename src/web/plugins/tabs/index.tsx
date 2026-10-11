import { useEffect, useMemo, useSyncExternalStore } from "react";
import { folderTitle, type EditorProps, type Opened, type Plugin } from "../../plugin-api.ts";
import { EditorGroups } from "./EditorGroups.tsx";
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
     * through here. Moving between tabs already open isn't a step Back should retrace, so only an
     * open or a close adds to the browser's history.
     */
    const dispatch = (action: EditorAction) => {
      const next = editorReducer(layout, action);
      if (next !== layout) {
        layout = next;
        host.storage.set("layout", layout);
        for (const listener of [...listeners]) listener();
      }
      // Dragging the edge of a split goes nowhere.
      if (action.type !== "resize") host.app().show(focused(layout), { replace: action.type === "focus" || action.type === "activate" });
    };
    const onTab = (action: (at: { groupId: string; tab: Opened }) => EditorAction) => () => {
      const tab = focused(layout);
      if (tab) dispatch(action({ groupId: layout.focusedGroupId, tab }));
    };

    host.commands.register({ id: "tab.keep", title: "Keep tab open", run: onTab((tab) => ({ type: "pin", ...tab })) });
    for (const { scope, id, title } of CLOSES) host.commands.register({ id, title, run: onTab((tab) => ({ type: "close", scope, ...tab })) });
    host.commands.register({ id: "editor.splitRight", title: "Split editor right", run: onTab((tab) => ({ type: "split", side: "right", ...tab })) });
    host.commands.register({ id: "editor.splitDown", title: "Split editor down", run: onTab((tab) => ({ type: "split", side: "down", ...tab })) });

    function Editor({ app, renderNote, renderFolder, renderPage, empty, controls }: EditorProps) {
      const shown = useSyncExternalStore(subscribe, () => layout);
      const titles = useMemo(() => app.notes && new Map(app.notes.map((n) => [n.id, n.title])), [app.notes]);
      const locked = useMemo(() => new Set((app.notes ?? []).filter((n) => n.private).map((n) => n.id)), [app.notes]);
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
        tab.kind === "page" ? (pages.get(tab.id)?.label ?? "Page") : tab.kind === "folder" ? (app.folders ? (folderTitle(app.folders, tab.id) ?? "Folder") : "") : titles ? titles.get(tab.id) || "Untitled" : "";

      return (
        <EditorGroups
          layout={shown}
          titleOf={titleOf}
          iconOf={(tab) => (tab.kind === "folder" ? "folders" : tab.kind === "page" ? pages.get(tab.id)?.icon : undefined)}
          isPrivate={(tab) => tab.kind === "note" && locked.has(tab.id)}
          dispatch={dispatch}
          render={(group, tab) => (tab.kind === "folder" ? renderFolder(tab.id) : tab.kind === "page" ? renderPage(tab.id, tab.path) : renderNote(tab.id, { onEdit: () => dispatch({ type: "pin", groupId: group.id, tab }) }))}
          empty={empty}
          controls={controls}
        />
      );
    }

    host.views.register("editor", { id: "tabs", component: Editor, open: (tab, { preview, background }) => dispatch({ type: "open", tab, preview, background }) });
  },
};
