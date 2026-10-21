import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { arrangement, keyOf, same, type EditorAction, type EditorLayout, type Group, type Pane, type Side, type Split } from "./editorLayout.ts";
import { Icon, ResizeHandle, carried, carriesTab, draggableAs, linkIn, type Dragged, type IconName, type Opened } from "../../plugin-api.ts";
import { ContextMenu, type MenuItem } from "../lib/Menu.tsx";

/** Where on a group's body a dragged tab is: near one of its edges, which splits the group that way, or in the middle, which adds the tab to it. */
export type Zone = Side | "middle";
/** Where a dragged tab would land: a gap between a group's tabs, or a zone of its body. */
type Drop = { groupId: string; at: number | Zone };
type TabMenu = { groupId: string; tab: Opened; x: number; y: number };
/** What is dropped on a group: what a tab can hold, or the address of a link of the app's own, which opens what going there would. */
export type Dropped = Dragged | { kind: "link"; address: string };

/** How much of a group's width or height, from each edge, splits it. The rest is the middle. */
const EDGE = 0.25;
/** The least share of a split a pane can be dragged down to. */
const LEAST = 0.1;

function gapAt(bar: HTMLElement, x: number) {
  const tabs = [...bar.querySelectorAll('[role="tab"]')];
  const gap = tabs.findIndex((tab) => {
    const { left, width } = tab.getBoundingClientRect();
    return x < left + width / 2;
  });
  return gap < 0 ? tabs.length : gap;
}

/**
 * The zone a point is in. The left and right edges are bands the whole height of the body; the top
 * and bottom edges are what is left of its top and bottom between them; the rest is the middle.
 */
export function zoneAt({ left, top, width, height }: { left: number; top: number; width: number; height: number }, x: number, y: number): Zone {
  const across = (x - left) / width;
  const down = (y - top) / height;
  return across < EDGE ? "left" : across > 1 - EDGE ? "right" : down < EDGE ? "up" : down > 1 - EDGE ? "down" : "middle";
}

interface Props {
  layout: EditorLayout;
  titleOf: (tab: Opened) => string;
  iconOf: (tab: Opened) => IconName | undefined;
  isPrivate: (tab: Opened) => boolean;
  /** What a tab's menu offers about its note, after what it offers about the tab. */
  noteItems: (tab: Opened) => MenuItem[];
  /** An open note's own buttons, drawn before Focus while the note is the group's tab in front. */
  noteTools: (noteId: string) => ReactNode;
  dispatch: (action: EditorAction) => void;
  /** What a drop opens: what was dragged, or what it leads to once dropped, as a new note does once made. Null opens nothing. */
  opening: (dropped: Dropped) => Promise<Opened | null>;
  /** Whether going to an address of the app's opens something a tab can hold, so a link to it is taken when dropped. */
  opens: (address: string) => boolean;
  render: (group: Group, tab: Opened) => ReactNode;
  /** What a group with nothing open shows. */
  empty: ReactNode;
  /** The group whose tab in front is to take the cursor. A folder's list or a page has it on its tab. A note's editor takes it for itself once the note is there, and `onCursorPut` is called if the member has gone elsewhere first. */
  cursorTo: string | null;
  onCursorPut: () => void;
  /** Focus: whether the focused group's tab in front fills the window, the keys that toggle it, and the toggle, which a group's own button calls with its id. */
  focusMode: { on: boolean; keys?: string; toggle: (groupId: string) => void };
}

/** Opens the menu of the tab in front, at the tab's foot, as a right click on the tab does: the way to the menu from the keyboard. */
export function showTabMenu() {
  const selected = '[role="tab"][aria-selected="true"]';
  const tab = document.querySelector(`.group[data-focused] ${selected}`) ?? document.querySelector(`.group ${selected}`);
  if (!tab) return;
  const { left, bottom } = tab.getBoundingClientRect();
  tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: left, clientY: bottom }));
}

export function EditorGroups({ layout, titleOf, iconOf, isPrivate, noteItems, noteTools, dispatch, opening, opens: opensAt, render, empty, cursorTo, onCursorPut, focusMode }: Props) {
  const [drop, setDrop] = useState<Drop | null>(null);
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const menuGroup = menu && layout.groups.find((g) => g.id === menu.groupId);
  const menuAt = menu && menuGroup ? menuGroup.tabs.findIndex((t) => same(t, menu.tab)) : -1;
  const menuTab = menu && { groupId: menu.groupId, tab: menu.tab };
  /**
   * Whether the member is moving the cursor with the Tab key just now. A group is turned to by a
   * press in it or by tabbing into it. What takes the cursor as it is drawn, as the Search page's
   * box does, isn't the member turning to its group, in whichever half of a split it is drawn.
   */
  const tabbing = useRef(false);
  /**
   * The address of the app's own a link being dragged from inside the window goes to, while one is.
   * One dragged in from elsewhere, or to another site, is left to whatever is under it, as it always was.
   */
  const link = useRef<string | null>(null);
  const opens = useRef(opensAt);
  opens.current = opensAt;
  useEffect(() => {
    const down = (e: KeyboardEvent) => void (tabbing.current = e.key === "Tab");
    const up = () => void (tabbing.current = false);
    // A link dragged from inside the window is known as it starts: over a group only what a drag holds can be told, not what it says.
    // Text that only reads as an address is no link, so it is taken only from a link or what the browser says is one.
    const started = (e: globalThis.DragEvent) => {
      const data = e.dataTransfer;
      const fromLink = data?.types.includes("text/uri-list") || (e.target instanceof Element && e.target.closest("a[href]") !== null);
      const address = data && fromLink ? linkIn(data) : null;
      link.current = address !== null && opens.current(address) ? address : null;
    };
    // A drag let go of anywhere, or given up with Escape, leaves no mark of where it would have landed. A drag whose
    // element went from the page ends with no dragend, and the pointer moving again says it is over.
    const ended = () => {
      link.current = null;
      setDrop(null);
    };
    const forgotten = () => void (link.current = null);
    const moved = (e: PointerEvent) => void (e.buttons === 0 && forgotten());
    addEventListener("keydown", down, true);
    addEventListener("keyup", up, true);
    addEventListener("dragstart", started, true);
    addEventListener("dragend", ended, true);
    addEventListener("drop", forgotten);
    addEventListener("pointermove", moved, true);
    return () => {
      removeEventListener("keydown", down, true);
      removeEventListener("keyup", up, true);
      removeEventListener("dragstart", started, true);
      removeEventListener("dragend", ended, true);
      removeEventListener("drop", forgotten);
      removeEventListener("pointermove", moved, true);
    };
  }, []);
  const groups = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const group = layout.groups.find((g) => g.id === cursorTo);
    if (!group) return;
    if (group.active?.kind !== "note") {
      groups.current?.querySelector<HTMLElement>(`[data-group="${group.id}"] [role="tab"][aria-selected="true"]`)?.focus();
      return onCursorPut();
    }
    // A note's editor takes the cursor once the note is there, unless the member has put it somewhere else by then.
    addEventListener("focusin", onCursorPut, true);
    return () => removeEventListener("focusin", onCursorPut, true);
  }, [cursorTo]);
  const root = arrangement(layout);

  /** Over a drop target the note can't fall through to the editor beneath, which would paste its link. */
  const over = (e: DragEvent, next: Drop) => {
    const tab = carriesTab(e.dataTransfer);
    if (!tab && link.current === null) return;
    e.preventDefault();
    e.stopPropagation();
    // A link keeps the effect its drag allows.
    if (tab) e.dataTransfer.dropEffect = "move";
    setDrop((d) => (d?.groupId === next.groupId && d.at === next.at ? d : next));
  };
  /** The group a tab is being dragged out of, while one is: a note dragged from a tab leaves that group, and its tabs in other groups stay. */
  const draggedFrom = useRef<string | null>(null);
  const dropped = (e: DragEvent, action: (tab: Opened, from: { from?: string }) => EditorAction) => {
    const address = link.current;
    if (!carriesTab(e.dataTransfer) && address === null) return;
    e.preventDefault();
    e.stopPropagation();
    setDrop(null);
    link.current = null;
    const dragged: Dropped | null = carriesTab(e.dataTransfer) ? carried(e.dataTransfer) : { kind: "link", address: address! };
    const from = draggedFrom.current;
    draggedFrom.current = null;
    if (dragged) void opening(dragged).then((tab) => tab && dispatch(action(tab, from === null ? {} : { from })));
  };
  const left = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
  };

  const drawGroup = (group: Group) => {
    const dropAt = drop?.groupId === group.id ? drop.at : null;
    const focus = () => dispatch({ type: "focus", groupId: group.id });
    const zone = (e: DragEvent) => (group.tabs.length ? zoneAt(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY) : "middle");
    return (
      <section
        key={group.id}
        className="group"
        data-region
        data-group={group.id}
        aria-label={`Editor group ${layout.groups.indexOf(group) + 1}`}
        data-focused={(layout.groups.length > 1 && group.id === layout.focusedGroupId) || undefined}
        data-front={group.id === layout.focusedGroupId || undefined}
      >
        <div className="tab-row">
            {group.tabs.length > 0 && (
              <div
                role="tablist"
                aria-label="Open notes"
                className="tab-bar"
                onDragOver={(e) => over(e, { groupId: group.id, at: gapAt(e.currentTarget, e.clientX) })}
                onDragLeave={left}
                onDrop={(e) => {
                  const index = gapAt(e.currentTarget, e.clientX);
                  dropped(e, (tab, from) => ({ type: "drop", groupId: group.id, index, tab, ...from }));
                }}
              >
                {group.tabs.map(({ preview, ...tab }, at) => {
                  const title = titleOf(tab);
                  const icon = iconOf(tab);
                  const activate = () => dispatch({ type: "activate", groupId: group.id, tab });
                  const close = () => dispatch({ type: "close", scope: "tab", groupId: group.id, tab });
                  return (
                    <div
                      key={keyOf(tab)}
                      role="tab"
                      className="tab"
                      aria-label={title}
                      aria-selected={same(tab, group.active)}
                      data-kind={tab.kind}
                      data-preview={preview || undefined}
                      data-drop={dropAt === at ? "before" : dropAt === at + 1 && at === group.tabs.length - 1 ? "after" : undefined}
                      tabIndex={0}
                      title={title}
                      {...draggableAs(tab, () => (draggedFrom.current = group.id))}
                      onDragEnd={() => (draggedFrom.current = null)}
                      onClick={activate}
                      onDoubleClick={() => dispatch({ type: "pin", groupId: group.id, tab })}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                        e.preventDefault();
                        activate();
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({ groupId: group.id, tab, x: e.clientX, y: e.clientY });
                      }}
                      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                      onAuxClick={(e) => e.button === 1 && close()}
                    >
                      {icon && (
                        <span className="tab-kind">
                          <Icon name={icon} />
                        </span>
                      )}
                      {isPrivate(tab) && (
                        <span className="private-mark" title="Private">
                          <Icon name="lock" />
                        </span>
                      )}
                      <span className="tab-title">{title}</span>
                      {/* A control inside a tab is one a screen reader can't reach as its own, so the cross is for the mouse alone: the keyboard closes a tab from its menu or the Close tab command. */}
                      <span
                        className="tab-close"
                        aria-hidden="true"
                        title={`Close ${title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          close();
                        }}
                      >
                        <Icon name="close" />
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          {group.active?.kind === "note" && noteTools(group.active.id)}
          <button
            type="button"
            className="icon-button focus-button"
            aria-label="Focus"
            title={`${focusMode.on ? "Leave focus" : "Focus"}${focusMode.keys ? ` (${focusMode.keys})` : ""}`}
            aria-pressed={focusMode.on}
            onClick={() => focusMode.toggle(group.id)}
          >
            <Icon name="focus" />
          </button>
        </div>
        <div
          className="group-body"
          onPointerDown={focus}
          onFocus={() => tabbing.current && focus()}
          onDragOverCapture={(e) => over(e, { groupId: group.id, at: zone(e) })}
          onDragLeave={left}
          onDropCapture={(e) => {
            const at = zone(e);
            dropped(e, (tab, from) => (at === "middle" ? { type: "add", groupId: group.id, tab, ...from } : { type: "split", groupId: group.id, side: at, tab, keep: true, ...from }));
          }}
        >
          {group.active ? render(group, group.active) : empty}
          {typeof dropAt === "string" && <div className="drop-zone" data-zone={dropAt} />}
        </div>
      </section>
    );
  };

  const drawPane = (pane: Pane, path: number[]): ReactNode => (typeof pane === "string" ? drawGroup(layout.groups.find((g) => g.id === pane)!) : <SplitPanes key={path.join(".")} split={pane} path={path} dispatch={dispatch} draw={drawPane} />);

  return (
    <div ref={groups} className="groups" data-focus-mode={focusMode.on || undefined}>
      {drawPane(root, [])}
      {menu && menuTab && menuGroup && menuAt >= 0 && (
        <ContextMenu
          label={`${titleOf(menu.tab)} tab`}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Close", icon: "close" as const, action: () => dispatch({ type: "close", scope: "tab", ...menuTab }) },
            { label: "Close others", disabled: menuGroup.tabs.length < 2, action: () => dispatch({ type: "close", scope: "others", ...menuTab }) },
            { label: "Close to the left", disabled: menuAt === 0, action: () => dispatch({ type: "close", scope: "left", ...menuTab }) },
            { label: "Close to the right", disabled: menuAt === menuGroup.tabs.length - 1, action: () => dispatch({ type: "close", scope: "right", ...menuTab }) },
            { label: "Close all", action: () => dispatch({ type: "close", scope: "all", ...menuTab }) },
            ...(menuGroup.tabs[menuAt]!.preview ? [{ label: "Keep open", icon: "pin" as const, action: () => dispatch({ type: "pin", ...menuTab }) }] : []),
            // A note is copied into the new group, so even a group's only tab splits; anything else moves, and leaves no group empty.
            { label: "Split right", icon: "split" as const, disabled: menuGroup.tabs.length < 2 && menu.tab.kind !== "note", action: () => dispatch({ type: "split", side: "right", ...menuTab }) },
            { label: "Split down", icon: "splitDown" as const, disabled: menuGroup.tabs.length < 2 && menu.tab.kind !== "note", action: () => dispatch({ type: "split", side: "down", ...menuTab }) },
            ...noteItems(menu.tab),
          ]}
        />
      )}
    </div>
  );
}

interface SplitProps {
  split: Split;
  /** The way to this split from the outermost one. */
  path: number[];
  dispatch: (action: EditorAction) => void;
  draw: (pane: Pane, path: number[]) => ReactNode;
}

/** Panes along one direction, each with its share of the room, and between each two an edge to drag. */
function SplitPanes({ split, path, dispatch, draw }: SplitProps) {
  const ref = useRef<HTMLDivElement>(null);
  const row = split.direction === "row";
  return (
    <div ref={ref} className="split" data-direction={split.direction}>
      {split.panes.map((pane, i) => {
        const pair = split.sizes[i]! + (split.sizes[i + 1] ?? 0);
        /** The edge after pane `i` moves room between it and the next pane, and no other. */
        const share = (first: number) => dispatch({ type: "resize", path, sizes: split.sizes.map((s, j) => (j === i ? first * pair : j === i + 1 ? (1 - first) * pair : s)) });
        return [
          <div key={typeof pane === "string" ? pane : `split ${i}`} className="pane" style={{ flexGrow: split.sizes[i] }}>
            {draw(pane, [...path, i])}
          </div>,
          i < split.panes.length - 1 && (
            <ResizeHandle
              key={`edge ${i}`}
              label={row ? "Resize split left and right" : "Resize split up and down"}
              orientation={row ? "vertical" : "horizontal"}
              value={(split.sizes[i]! / pair) * 100}
              min={LEAST * 100}
              max={(1 - LEAST) * 100}
              step={5}
              valueText={`${Math.round((split.sizes[i]! / pair) * 100)}%`}
              perPixel={() => {
                const panes = [...(ref.current?.children ?? [])].filter((el) => el.classList.contains("pane"));
                const length = (el: Element | undefined) => (el ? (row ? el.getBoundingClientRect().width : el.getBoundingClientRect().height) : 0);
                return 100 / (length(panes[i]) + length(panes[i + 1]) || 1);
              }}
              onChange={(percent) => share(percent / 100)}
              onReset={() => share(0.5)}
            />
          ),
        ];
      })}
    </div>
  );
}
