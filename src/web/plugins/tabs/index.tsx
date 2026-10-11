import { useEffect, useMemo, useSyncExternalStore } from "react";
import { folderTitle, type EditorProps, type Opened, type Plugin } from "../../plugin-api.ts";
import { EditorGroups } from "./EditorGroups.tsx";
import { editorReducer, focused, keptLayout, same, type CloseScope, type EditorAction } from "./editorLayout.ts";

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
      const app = host.app();
      // A tab opened behind a page, such as from the Search page's list, leaves the page in front.
      if (action.type === "open" && action.background && !app.opened && app.path !== "/") return;
      app.show(focused(layout), { replace: action.type === "focus" || action.type === "activate" });
    };
    const onTab = (action: (at: { groupId: string; tab: Opened }) => EditorAction) => () => {
      const tab = focused(layout);
      if (tab) dispatch(action({ groupId: layout.focusedGroupId, tab }));
    };

    host.commands.register({ id: "tab.keep", title: "Keep tab open", run: onTab((tab) => ({ type: "pin", ...tab })) });
    for (const { scope, id, title } of CLOSES) host.commands.register({ id, title, run: onTab((tab) => ({ type: "close", scope, ...tab })) });
    host.commands.register({ id: "editor.splitRight", title: "Split editor right", run: onTab((tab) => ({ type: "split", side: "right", ...tab })) });

    function Editor({ app, renderNote, renderFolder }: EditorProps) {
      const shown = useSyncExternalStore(subscribe, () => layout);
      const titles = useMemo(() => app.notes && new Map(app.notes.map((n) => [n.id, n.title])), [app.notes]);
      const home = app.path === "/";

      useEffect(() => {
        if (app.opened && !same(focused(layout), app.opened)) dispatch({ type: "open", tab: app.opened, preview: true });
      }, [app.opened]);
      useEffect(() => {
        const tab = focused(layout);
        if (home && tab) app.show(tab, { replace: true });
      }, [home]);

      // The buttons for the inspector and writing mode are in a note's bar, so they go to the rightmost group that shows one.
      const corner = shown.groups.findLast((g) => g.active?.kind === "note");

      return (
        <EditorGroups
          layout={shown}
          titleOf={(tab) => (tab.kind === "folder" ? (app.folders ? (folderTitle(app.folders, tab.id) ?? "Folder") : "") : titles ? titles.get(tab.id) || "Untitled" : "")}
          dispatch={dispatch}
          render={(group, tab) =>
            tab.kind === "folder" ? renderFolder(tab.id) : renderNote(tab.id, { onEdit: () => dispatch({ type: "pin", groupId: group.id, tab }), corner: group === corner })
          }
        />
      );
    }

    host.views.register("editor", { id: "tabs", component: Editor, open: (tab, { preview, background }) => dispatch({ type: "open", tab, preview, background }) });
  },
};
