import { useState, type DragEvent, type ReactNode } from "react";
import { same, type EditorAction, type EditorLayout, type Group } from "./editorLayout.ts";
import { Icon, NOTE_DRAG, type Opened } from "../../plugin-api.ts";
import { ContextMenu } from "../lib/Menu.tsx";

/** Where a dragged tab would land: a gap between a group's tabs, or half of its editor, which splits it. */
type Drop = { groupId: string; at: number | "left" | "right" };
type TabMenu = { groupId: string; tab: Opened; x: number; y: number };

/** The drag type that carries a tab that isn't a note's. A note's tab is dragged as its note, so it also drops wherever a note does. */
const FOLDER_TAB_DRAG = "application/x-common-ink-folder-tab";

const carriesTab = (e: DragEvent) => e.dataTransfer.types.includes(NOTE_DRAG) || e.dataTransfer.types.includes(FOLDER_TAB_DRAG);
const carried = (e: DragEvent): Opened | null => {
  const folderId = e.dataTransfer.getData(FOLDER_TAB_DRAG);
  const noteId = e.dataTransfer.getData(NOTE_DRAG);
  return folderId ? { kind: "folder", id: folderId } : noteId ? { kind: "note", id: noteId } : null;
};
const keyOf = (tab: Opened) => `${tab.kind} ${tab.id}`;

function gapAt(bar: HTMLElement, x: number) {
  const tabs = [...bar.querySelectorAll('[role="tab"]')];
  const gap = tabs.findIndex((tab) => {
    const { left, width } = tab.getBoundingClientRect();
    return x < left + width / 2;
  });
  return gap < 0 ? tabs.length : gap;
}

function sideAt(body: HTMLElement, x: number) {
  const { left, width } = body.getBoundingClientRect();
  return x < left + width / 2 ? "left" : "right";
}

interface Props {
  layout: EditorLayout;
  titleOf: (tab: Opened) => string;
  dispatch: (action: EditorAction) => void;
  render: (group: Group, tab: Opened) => ReactNode;
}

export function EditorGroups({ layout, titleOf, dispatch, render }: Props) {
  const [drop, setDrop] = useState<Drop | null>(null);
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const menuGroup = menu && layout.groups.find((g) => g.id === menu.groupId);
  const menuAt = menu && menuGroup ? menuGroup.tabs.findIndex((t) => same(t, menu.tab)) : -1;
  const menuTab = menu && { groupId: menu.groupId, tab: menu.tab };

  /** Over a drop target the note can't fall through to the editor beneath, which would paste its link. */
  const over = (e: DragEvent, next: Drop) => {
    if (!carriesTab(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDrop((d) => (d?.groupId === next.groupId && d.at === next.at ? d : next));
  };
  const dropped = (e: DragEvent, action: (tab: Opened) => EditorAction) => {
    if (!carriesTab(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDrop(null);
    const tab = carried(e);
    if (tab) dispatch(action(tab));
  };
  const left = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
  };

  return (
    <div className="groups">
      {layout.groups.map((group, i) => {
        const dropAt = drop?.groupId === group.id ? drop.at : null;
        const focus = () => dispatch({ type: "focus", groupId: group.id });
        return (
          <section
            key={group.id}
            className="group"
            aria-label={`Editor group ${i + 1}`}
            data-focused={(layout.groups.length > 1 && group.id === layout.focusedGroupId) || undefined}
          >
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
                      onDragStart={(e) => {
                        e.dataTransfer.setData(tab.kind === "folder" ? FOLDER_TAB_DRAG : NOTE_DRAG, tab.id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
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
                      {tab.kind === "folder" && (
                        <span className="tab-kind">
                          <Icon name="folders" />
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
            <div
              className="group-body"
              onPointerDown={focus}
              onFocus={focus}
              onDragOverCapture={(e) => over(e, { groupId: group.id, at: sideAt(e.currentTarget, e.clientX) })}
              onDragLeave={left}
              onDropCapture={(e) => dropped(e, (tab) => ({ type: "split", groupId: group.id, side: sideAt(e.currentTarget, e.clientX), tab }))}
            >
              {group.active ? render(group, group.active) : <p className="notice">Pick a note, or start a new one.</p>}
              {typeof dropAt === "string" && <div className="drop-zone" data-side={group.tabs.length ? dropAt : "whole"} />}
            </div>
          </section>
        );
      })}
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
          ]}
        />
      )}
    </div>
  );
}
