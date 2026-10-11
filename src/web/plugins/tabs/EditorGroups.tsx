import { useState, type DragEvent, type ReactNode } from "react";
import type { EditorAction, EditorLayout, Group } from "./editorLayout.ts";
import { Icon, NOTE_DRAG } from "../../plugin-api.ts";
import { ContextMenu } from "../lib/Menu.tsx";

/** Where a dragged note would land: a gap between a group's tabs, or half of its editor, which splits it. */
type Drop = { groupId: string; at: number | "left" | "right" };
type TabMenu = { groupId: string; noteId: string; x: number; y: number };

const carriesNote = (e: DragEvent) => e.dataTransfer.types.includes(NOTE_DRAG);

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
  titleOf: (noteId: string) => string;
  dispatch: (action: EditorAction) => void;
  renderNote: (group: Group, noteId: string) => ReactNode;
}

export function EditorGroups({ layout, titleOf, dispatch, renderNote }: Props) {
  const [drop, setDrop] = useState<Drop | null>(null);
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const menuGroup = menu && layout.groups.find((g) => g.id === menu.groupId);
  const menuAt = menu && menuGroup ? menuGroup.tabs.findIndex((t) => t.noteId === menu.noteId) : -1;
  const menuTab = menu && { groupId: menu.groupId, noteId: menu.noteId };

  /** Over a drop target the note can't fall through to the editor beneath, which would paste its link. */
  const over = (e: DragEvent, next: Drop) => {
    if (!carriesNote(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDrop((d) => (d?.groupId === next.groupId && d.at === next.at ? d : next));
  };
  const dropped = (e: DragEvent, action: (noteId: string) => EditorAction) => {
    if (!carriesNote(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDrop(null);
    const noteId = e.dataTransfer.getData(NOTE_DRAG);
    if (noteId) dispatch(action(noteId));
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
                onDrop={(e) => dropped(e, (noteId) => ({ type: "drop", groupId: group.id, index: gapAt(e.currentTarget, e.clientX), noteId }))}
              >
                {group.tabs.map(({ noteId, preview }, at) => {
                  const title = titleOf(noteId);
                  const activate = () => dispatch({ type: "activate", groupId: group.id, noteId });
                  const close = () => dispatch({ type: "close", scope: "tab", groupId: group.id, noteId });
                  return (
                    <div
                      key={noteId}
                      role="tab"
                      className="tab"
                      aria-label={title}
                      aria-selected={noteId === group.activeNoteId}
                      data-preview={preview || undefined}
                      data-drop={dropAt === at ? "before" : dropAt === at + 1 && at === group.tabs.length - 1 ? "after" : undefined}
                      tabIndex={0}
                      title={title}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(NOTE_DRAG, noteId);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onClick={activate}
                      onDoubleClick={() => dispatch({ type: "pin", groupId: group.id, noteId })}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                        e.preventDefault();
                        activate();
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({ groupId: group.id, noteId, x: e.clientX, y: e.clientY });
                      }}
                      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                      onAuxClick={(e) => e.button === 1 && close()}
                    >
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
              onDropCapture={(e) => dropped(e, (noteId) => ({ type: "split", groupId: group.id, side: sideAt(e.currentTarget, e.clientX), noteId }))}
            >
              {group.activeNoteId ? renderNote(group, group.activeNoteId) : <p className="notice">Pick a note, or start a new one.</p>}
              {typeof dropAt === "string" && <div className="drop-zone" data-side={group.tabs.length ? dropAt : "whole"} />}
            </div>
          </section>
        );
      })}
      {menu && menuTab && menuGroup && menuAt >= 0 && (
        <ContextMenu
          label={`${titleOf(menu.noteId)} tab`}
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
