import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { arrangement, same, type EditorAction, type EditorLayout, type Group, type Opened, type Pane, type Side, type Split } from "./editorLayout.ts";
import { Icon, type IconName } from "./icons.tsx";
import { ContextMenu } from "./Menu.tsx";
import { carried, carriesTab, carry } from "./dragged.ts";
import { ResizeHandle } from "./resize.tsx";

/** Where on a group's body a dragged tab is: near one of its edges, which splits the group that way, or in the middle, which adds the tab to it. */
export type Zone = Side | "middle";
/** Where a dragged tab would land: a gap between a group's tabs, or a zone of its body. */
type Drop = { groupId: string; at: number | Zone };
type TabMenu = { groupId: string; tab: Opened; x: number; y: number };

/** How much of a group's width or height, from each edge, splits it. The rest is the middle. */
const EDGE = 0.25;
/** The least share of a split a pane can be dragged down to. */
const LEAST = 0.1;

const keyOf = (tab: Opened) => `${tab.kind} ${tab.id}`;

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

/** The group at the top left of the arrangement, whose tab row begins with the sidebar's button. */
const leadOf = (pane: Pane): string => (typeof pane === "string" ? pane : leadOf(pane.panes[0]!));
/** The group at the top right corner of the arrangement, whose tab row carries the rest of the window's buttons. */
const cornerOf = (pane: Pane): string => (typeof pane === "string" ? pane : cornerOf(pane.direction === "row" ? pane.panes.at(-1)! : pane.panes[0]!));

interface Props {
  layout: EditorLayout;
  titleOf: (tab: Opened) => string;
  iconOf: (tab: Opened) => IconName | undefined;
  dispatch: (action: EditorAction) => void;
  render: (group: Group, tab: Opened) => ReactNode;
  /** What a group with nothing open shows. */
  empty: ReactNode;
  /** The window's buttons: `start` goes before the first tab of the top left group's tab row, `end` after the last of the top right's. */
  controls: { start: ReactNode; end: ReactNode };
}

/** Opens the menu of the tab in front, at the tab's foot, as a right click on the tab does: the way to the menu from the keyboard. */
export function showTabMenu() {
  const selected = '[role="tab"][aria-selected="true"]';
  const tab = document.querySelector(`.group[data-focused] ${selected}`) ?? document.querySelector(`.group ${selected}`);
  if (!tab) return;
  const { left, bottom } = tab.getBoundingClientRect();
  tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: left, clientY: bottom }));
}

export function EditorGroups({ layout, titleOf, iconOf, dispatch, render, empty, controls }: Props) {
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
  useEffect(() => {
    const down = (e: KeyboardEvent) => void (tabbing.current = e.key === "Tab");
    const up = () => void (tabbing.current = false);
    // A drag let go of anywhere, or given up with Escape, leaves no mark of where it would have landed.
    const ended = () => setDrop(null);
    addEventListener("keydown", down, true);
    addEventListener("keyup", up, true);
    addEventListener("dragend", ended, true);
    return () => {
      removeEventListener("keydown", down, true);
      removeEventListener("keyup", up, true);
      removeEventListener("dragend", ended, true);
    };
  }, []);
  const root = arrangement(layout);
  const corner = cornerOf(root);
  const lead = leadOf(root);

  /** Over a drop target the note can't fall through to the editor beneath, which would paste its link. */
  const over = (e: DragEvent, next: Drop) => {
    if (!carriesTab(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDrop((d) => (d?.groupId === next.groupId && d.at === next.at ? d : next));
  };
  const dropped = (e: DragEvent, action: (tab: Opened) => EditorAction) => {
    if (!carriesTab(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    setDrop(null);
    const tab = carried(e.dataTransfer);
    if (tab) dispatch(action(tab));
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
        aria-label={`Editor group ${layout.groups.indexOf(group) + 1}`}
        data-focused={(layout.groups.length > 1 && group.id === layout.focusedGroupId) || undefined}
      >
        {(group.tabs.length > 0 || group.id === corner || group.id === lead) && (
          <div className="tab-row">
            {group.id === lead && controls.start}
            {group.tabs.length > 0 && (
              <div
                role="tablist"
                aria-label="Open notes"
                className="tab-bar"
                onDragOver={(e) => over(e, { groupId: group.id, at: gapAt(e.currentTarget, e.clientX) })}
                onDragLeave={left}
                onDrop={(e) => dropped(e, (tab) => ({ type: "drop", groupId: group.id, index: gapAt(e.currentTarget, e.clientX), tab }))}
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
                      draggable
                      onDragStart={(e) => carry(e.dataTransfer, tab)}
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
                      <span className="tab-title">{title}</span>
                      <button
                        type="button"
                        className="tab-close"
                        tabIndex={-1}
                        aria-label={`Close ${title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          close();
                        }}
                      >
                        <Icon name="close" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {group.id === corner && controls.end}
          </div>
        )}
        <div
          className="group-body"
          onPointerDown={focus}
          onFocus={() => tabbing.current && focus()}
          onDragOverCapture={(e) => over(e, { groupId: group.id, at: zone(e) })}
          onDragLeave={left}
          onDropCapture={(e) => {
            const at = zone(e);
            dropped(e, (tab) => (at === "middle" ? { type: "add", groupId: group.id, tab } : { type: "split", groupId: group.id, side: at, tab, keep: true }));
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
    <div className="groups">
      {drawPane(root, [])}
      {menu && menuTab && menuGroup && menuAt >= 0 && (
        <ContextMenu
          label={`${titleOf(menu.tab)} tab`}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Close", action: () => dispatch({ type: "close", scope: "tab", ...menuTab }) },
            { label: "Close others", disabled: menuGroup.tabs.length < 2, action: () => dispatch({ type: "close", scope: "others", ...menuTab }) },
            { label: "Close to the left", disabled: menuAt === 0, action: () => dispatch({ type: "close", scope: "left", ...menuTab }) },
            { label: "Close to the right", disabled: menuAt === menuGroup.tabs.length - 1, action: () => dispatch({ type: "close", scope: "right", ...menuTab }) },
            { label: "Close all", action: () => dispatch({ type: "close", scope: "all", ...menuTab }) },
            ...(menuGroup.tabs[menuAt]!.preview ? [{ label: "Keep open", action: () => dispatch({ type: "pin", ...menuTab }) }] : []),
            { label: "Split right", disabled: menuGroup.tabs.length < 2, action: () => dispatch({ type: "split", side: "right", ...menuTab }) },
            { label: "Split down", disabled: menuGroup.tabs.length < 2, action: () => dispatch({ type: "split", side: "down", ...menuTab }) },
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
