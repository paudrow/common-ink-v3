import { useEffect, useMemo, useSyncExternalStore } from "react";
import { folderTitle, keepPlacesIn, openedAt, type App, type Dragged, type EditorProps, type Opened, type Plugin } from "../../plugin-api.ts";
import { lifecycle } from "../lib/lifecycle.ts";
import { EditorGroups, showTabMenu, type Dropped } from "./EditorGroups.tsx";
import { editorReducer, focused, keptLayout, keyed, keyedLayout, notesIn, same, type CloseScope, type EditorAction } from "./editorLayout.ts";

/** Whether the tab in front is this one and, for a page, at this address. */
const inFront = (tab: Opened | null, opened: Opened) => same(tab, opened) && (tab?.kind !== "page" || opened.kind !== "page" || tab.path === opened.path);

const namesOf = (kept: unknown): Record<string, string> =>
  typeof kept === "object" && kept !== null ? Object.fromEntries(Object.entries(kept).filter((named): named is [string, string] => typeof named[1] === "string")) : {};

const CLOSES: { scope: CloseScope; id: string; title: string }[] = [
  { scope: "tab", id: "tab.close", title: "Close tab" },
  { scope: "others", id: "tab.closeOthers", title: "Close other tabs" },
  { scope: "left", id: "tab.closeLeft", title: "Close tabs to the left" },
  { scope: "right", id: "tab.closeRight", title: "Close tabs to the right" },
  { scope: "all", id: "tab.closeAll", title: "Close all tabs" },
];

/**
 * What a drop on a group opens. A link of the app's own opens what going to its address would. A new
 * note is made first, where it was dragged from asked; a page that only leads somewhere else opens
 * where it leads. Anything else is opened as it was dragged. A refusal is said in a notice, and
 * nothing is opened.
 */
async function opening(app: App, dropped: Dropped): Promise<Opened | null> {
  const dragged: Dragged | null = dropped.kind === "link" ? openedAt(dropped.address, app.pages) : dropped;
  if (!dragged) return null;
  const leads = dragged.kind === "page" ? app.pages.find((p) => p.id === dragged.id)?.transient : undefined;
  try {
    if (dragged.kind === "new note") return { kind: "note", id: await app.createNote(dragged.folderId, { open: false }) };
    return typeof leads === "function" ? await leads() : dragged;
  } catch (err) {
    app.notify({ message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export const tabs: Plugin = {
  id: "tabs",
  name: "Tabs and splits",
  description: "Open notes in tabs, and side by side in splits.",
  icon: "tabs",
  needs: "room",
  activate(host) {
    let layout = keptLayout(host.storage.get("layout"));
    /** A note's place in a group is kept while its tab is there: a group made later with the same id starts afresh. */
    const keepPlaces = () => keepPlacesIn(layout.groups.flatMap((g) => g.tabs.flatMap((t) => (t.kind === "note" ? [{ noteId: t.id, pane: g.id }] : []))));
    keepPlaces();
    /** Each page's name as it last was, by its id, so a tab left on a page that has gone since still says what it was. */
    let pageNames = namesOf(host.storage.get("pageNames"));
    const homeId = () => host.app().pages.find((p) => p.home)?.id;
    /** Whether the member closed the home page's tab with nothing else open. It then stays closed until something is opened. */
    let homeClosed = false;
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
    /** For a page with a tab for each of several keys, as each tag's page has, the key of the one at an address. */
    const ownTab = (pageId: string, path: string) => host.app().pages.find((p) => p.id === pageId)?.tabAt?.(path).key;
    const dispatch = (asked: EditorAction) => {
      const action = "tab" in asked ? { ...asked, tab: keyed(asked.tab, ownTab) } : asked;
      const next = editorReducer(layout, action);
      // Gone to the side, it shows in a pane beside the one in front, which focus would hide.
      if (action.type === "aside" && next !== layout) host.app().setFocus(false);
      if ((action.type === "split" || action.type === "send") && next !== layout) {
        // A tab split off or sent to another group leaves focus, which shows one group: the member sees where it went.
        host.app().setFocus(false);
        // It is drawn anew where it went, and what had the cursor in it is gone, so the cursor is put in it there.
        cursorTo = next.focusedGroupId;
      }
      if (focused(next)) homeClosed = false;
      else if (action.type === "close" && focused(layout)?.kind === "page" && focused(layout)?.id === homeId()) homeClosed = true;
      if (next !== layout) {
        const had = notesIn(layout);
        const has = notesIn(next);
        layout = next;
        keepPlaces();
        for (const noteId of had) if (!has.has(noteId)) host.app().left(noteId);
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

    function Editor({ app, renderNote, renderNoteTools, renderFolder, renderPage, empty }: EditorProps) {
      const shown = useSyncExternalStore(subscribe, () => layout);
      const cursorGroup = useSyncExternalStore(subscribe, () => cursorTo);
      // A tab stays open on a note that was moved to Trash, so those are known by name too.
      const notes = useMemo(() => app.notes && new Map([...app.notes, ...app.trashed].map((n) => [n.id, n])), [app.notes, app.trashed]);
      const home = app.path === "/";

      // A layout kept before a page had a tab at each address has them once the page is there.
      useEffect(() => {
        const next = keyedLayout(layout, ownTab);
        if (next === layout) return;
        layout = next;
        host.storage.set("layout", layout);
        for (const listener of [...listeners]) listener();
      }, [app.pages]);
      useEffect(() => {
        if (app.opened && !inFront(focused(layout), keyed(app.opened, ownTab))) dispatch({ type: "open", tab: app.opened, preview: true });
      }, [app.opened]);
      const homePage = app.pages.find((p) => p.home)?.id;
      const nothing = !focused(shown);
      // At `/` the app goes to the tab that was last in front. With none, the home page opens in a tab of its own, at `/`.
      useEffect(() => {
        const tab = focused(layout);
        if (home && tab) app.show(tab, { replace: true });
        else if (home && homePage && !homeClosed) dispatch({ type: "open", tab: { kind: "page", id: homePage, path: "/" }, preview: true });
      }, [home, nothing, homePage]);

      const pages = useMemo(() => new Map(app.pages.map((p) => [p.id, p])), [app.pages]);
      useEffect(() => {
        if (app.pages.every((p) => pageNames[p.id] === p.label)) return;
        pageNames = { ...pageNames, ...Object.fromEntries(app.pages.map((p) => [p.id, p.label])) };
        host.storage.set("pageNames", pageNames);
      }, [app.pages]);
      // A page that has gone is called what it was, or by its address; an address no page was ever at has its path for an id and is "Page".
      const titleOf = (tab: Opened) =>
        tab.kind === "page" ? (pages.get(tab.id)?.tabAt?.(tab.path.split("?")[0]!).title ?? pages.get(tab.id)?.label ?? pageNames[tab.id] ?? (tab.id.startsWith("/") ? "Page" : tab.path)) : tab.kind === "folder" ? (app.folders ? (folderTitle(app.folders, tab.id) ?? "Folder") : "") : notes ? notes.get(tab.id)?.title || "Untitled" : "";

      return (
        <EditorGroups
          layout={shown}
          titleOf={titleOf}
          iconOf={(tab) => (tab.kind === "folder" ? "folders" : tab.kind === "page" ? pages.get(tab.id)?.icon : undefined)}
          isPrivate={(tab) => (tab.kind === "note" && notes?.get(tab.id)?.private) ?? false}
          noteItems={(tab) => (tab.kind === "note" ? items(notes?.get(tab.id)) : [])}
          noteTools={renderNoteTools}
          dispatch={dispatch}
          opening={(dragged) => opening(app, dragged)}
          opens={(address) => openedAt(address, app.pages) !== null}
          render={(group, tab) =>
            tab.kind === "folder"
              ? renderFolder(tab.id)
              : tab.kind === "page"
                ? renderPage(tab.id, tab.path)
                : renderNote(tab.id, {
                    onEdit: () => dispatch({ type: "pin", groupId: group.id, tab }),
                    pane: group.id,
                    focus: group.id === cursorGroup,
                    onFocused: cursorPut,
                    // A note open in two groups takes the cursor in the one in front, or else the first that shows it.
                    behind: group.id !== (shown.groups.find((g) => g.id === shown.focusedGroupId && same(g.active, tab)) ?? shown.groups.find((g) => same(g.active, tab)))?.id,
                  })
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
      open: (tab, { preview, background, here }) => dispatch({ type: "open", tab, preview, background, here }),
      returnsTo: () => focused(layout),
      split: (tab, side) => dispatch({ type: "split", groupId: layout.focusedGroupId, side, tab, keep: true }),
      aside: (tab, { preview, stay }) => dispatch({ type: "aside", tab, preview, stay }),
      tabs: () => layout.groups.flatMap((g, i) => g.tabs.map(({ preview: _, ...opened }) => ({ opened, pane: i + 1 }))),
    });
  },
};
