import { useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { Icon, draggableAs, type IconName, type Opened } from "../../plugin-api.ts";
import { ContextMenu, type MenuItem } from "./Menu.tsx";
import { Palette } from "./Palette.tsx";

/** One row of a `ManageTable`, a tag or a folder, and the rows inside it. */
export interface ManageItem {
  key: string;
  /** What a rename starts from and the rows are put in order by: a folder's name, the last part of a tag's. */
  name: string;
  /** What the row shows of it, as `#project` for a tag at the top and `alpha` for one inside it. */
  label: string;
  /** Its whole name, which the search reads and a screen reader is told: `#project/alpha`, `Work / Alpha`. */
  path: string;
  description: string;
  /** How many notes it has, those of the rows inside it too, each counted once. */
  notes: number;
  /** What resting on the count says of it, as how many notes are its own. */
  notesTitle?: string;
  /** What dragging it carries to the editor area, as dragging it in the sidebar does. */
  dragged: Opened;
  /** Comes before the rows beside it, whatever its name, as Unsorted does among folders. */
  first?: boolean;
  /** `delete` is offered only with `ManageActions.delete`, which Tags has. */
  may: { rename: boolean; describe: boolean; add: boolean; move: boolean; delete?: boolean };
  children: readonly ManageItem[];
}

/** Asked before a change goes through, as a rename that rewrites notes is. With no `run` it only says why nothing can be. */
export interface Confirmation {
  message: string;
  action?: string;
  /** Answers the key of the row after it. */
  run?: () => Promise<string>;
}

/** How a change went: done, with the key of the row after it, or asked of the member first. */
export type Done = { key: string } | { confirm: Confirmation };

/** What the plugin does for its table. A refusal is an Error, whose message the row says. */
export interface ManageActions {
  open(item: ManageItem): void;
  rename(item: ManageItem, name: string): Promise<Done>;
  describe(item: ManageItem, description: string): Promise<void>;
  /** Answers the new row's key. */
  add(parent: ManageItem | null, name: string): Promise<string>;
  move(item: ManageItem, to: ManageItem | null): Promise<Done>;
  /** Whether `item` can go inside `to`, or to the top for null. */
  canMove(item: ManageItem, to: ManageItem | null): boolean;
  /** The whole name `item` would have inside `to`, which a drag says before it is dropped. */
  movedPath(item: ManageItem, to: ManageItem | null): string;
  /** Why `name` can't be one inside `parent`, or null. */
  problem(name: string, parent: ManageItem | null): string | null;
  /** Takes the row away, and the rows inside it, for a row whose `may.delete` says so, once the plugin has asked. Answers whether it went. */
  delete?(item: ManageItem): Promise<boolean>;
}

/** What the table is doing. One row at a time is, as one form being filled in. */
type Editing =
  | { kind: "rename"; key: string }
  | { kind: "describe"; key: string }
  | { kind: "add"; parent: string | null }
  | { kind: "confirm"; key: string; confirmation: Confirmation }
  | { kind: "move"; key: string };

/** The key a row being added has until it is named, and of the top in Move to…. */
const ADDING = "\0adding";
const TOP = "\0top";
const ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const sorted = (items: readonly ManageItem[]) => [...items].sort((a, b) => Number(!!b.first) - Number(!!a.first) || ORDER.compare(a.name, b.name) || (a.key < b.key ? -1 : 1));
const notes = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`;

interface Props {
  label: string;
  column: string;
  noun: string;
  /** What resting on the Notes heading says it counts. */
  notesHeading: string;
  /** What the button above the table and a row's menu say to add one: "New tag", "New tag inside". */
  adding: { top: string; inside: string };
  icon: IconName;
  roots: readonly ManageItem[];
  /** Whether the member may add a row at the top. */
  top: boolean;
  /** More rows are still to be read, which the search can't find yet. */
  partial?: boolean;
  /** What the field a description is written in is called, for a screen reader. */
  describing: (item: ManageItem) => string;
  maxDescription: number;
  actions: ManageActions;
  /** A row to bring into view and give the keyboard as the table is first drawn, as a menu elsewhere asked: to rename it or say what it is for. */
  opening?: { key: string; kind: "rename" | "describe" | null } | null;
}

/**
 * A tree of named things and what each is for, as Settings' Tags and Folders are: each row's name,
 * indented under the row it is inside, then its description, then its count of notes. Rows are in
 * order by name at every level. It is edited as a file tree is: double-click a name, F2 or its
 * pencil to rename it; click a description, or Enter on the row, to say it; drag a name onto another
 * row to move it inside that one, or onto the strip under the table to move it to the top. The row's
 * menu has the same, with Move to… for the keyboard, adds a row inside, and deletes a row the plugin
 * lets go, as Delete and Backspace on the row do. A search box above keeps the rows whose name or
 * description has what is typed, with the rows they are inside.
 *
 * The roles are written out because a narrow pane draws the rows as cards, and some browsers drop a
 * table's roles once its parts aren't drawn as one.
 */
export function ManageTable({ label, column, noun, notesHeading, adding, icon, roots, top, partial = false, describing, maxDescription, actions, opening = null }: Props) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<Editing | null>(null);
  const [problem, setProblem] = useState<{ key: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<string | null>(opening?.key ?? null);
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ key: string; over: string | null; x: number; y: number } | null>(null);
  const body = useRef<HTMLTableSectionElement>(null);
  /** The row to give the keyboard once it is drawn, after a change made from the keyboard. */
  const focusing = useRef<string | null>(null);

  const byKey = new Map<string, ManageItem>();
  const index = (items: readonly ManageItem[]) => items.forEach((item) => (byKey.set(item.key, item), index(item.children)));
  index(roots);

  const wanted = query.trim().toLowerCase();
  const matches = (item: ManageItem): boolean => `${item.path}\n${item.description}`.toLowerCase().includes(wanted) || item.children.some(matches);
  const rows: { item: ManageItem | null; depth: number; parent: ManageItem | null }[] = [];
  const walk = (items: readonly ManageItem[], depth: number, parent: ManageItem | null) => {
    for (const item of sorted(items)) {
      if (wanted && !matches(item)) continue;
      rows.push({ item, depth, parent });
      if (wanted || !collapsed.has(item.key)) walk(item.children, depth + 1, item);
    }
    // A row being added sits after the rows it will be among until it is named and put in its place.
    if (editing?.kind === "add" && editing.parent === (parent?.key ?? null)) rows.push({ item: null, depth, parent });
  };
  walk(roots, 0, null);
  const none = !rows.length;

  // Asked for from elsewhere, the row is brought into view, and takes the keyboard once Settings, which take it as they open, have.
  useLayoutEffect(() => {
    if (!opening) return;
    const later = setTimeout(() => {
      const row = body.current?.querySelector<HTMLElement>(`tr[data-key="${CSS.escape(opening.key)}"]`);
      row?.scrollIntoView({ block: "center" });
      setActive(opening.key);
      if (opening.kind) setEditing({ kind: opening.kind, key: opening.key });
      // Marked as the keyboard's, though a click on a menu item brought it here, so it is seen to be the one asked for.
      else row?.focus({ focusVisible: true });
    });
    return () => clearTimeout(later);
  }, []);
  useLayoutEffect(() => {
    const key = focusing.current;
    const row = key && body.current?.querySelector<HTMLElement>(`tr[data-key="${CSS.escape(key)}"]`);
    if (!row) return;
    focusing.current = null;
    setActive(key);
    row.focus();
  });

  /** What the table is doing as last drawn, which a change that comes back later checks it still asked for. */
  const live = useRef<Editing | null>(null);
  live.current = editing;
  /** Applies what a change came to only while the table still does what asked for it: an edit begun since keeps going. */
  const still = (mine: Editing | null, then: () => void) => {
    if (live.current === mine) then();
  };

  /** Ends what the row was doing. Ended from the keyboard, the keyboard goes back to the row; a click elsewhere keeps it where it went. */
  const finish = (mine: Editing | null, key: string | null, fromKeyboard: boolean) =>
    still(mine, () => {
      setEditing(null);
      if (fromKeyboard && key) focusing.current = key;
    });
  /** Runs a change, saying a refusal on the row it was asked of. With `keep`, the field stays with what was typed, to be put right. */
  const working = (mine: Editing | null, key: string, work: () => Promise<void>, keep = false) => {
    setBusy(true);
    setProblem(null);
    work().then(
      () => setBusy(false),
      (err: unknown) => {
        setBusy(false);
        if (!keep) still(mine, () => setEditing(null));
        setProblem({ key, message: err instanceof Error ? err.message : "That didn't go through. Try again." });
      },
    );
  };
  const settle = (mine: Editing | null, key: string, fromKeyboard: boolean) => (done: Done) =>
    "confirm" in done ? still(mine, () => setEditing({ kind: "confirm", key, confirmation: done.confirm })) : finish(mine, done.key, fromKeyboard);

  const start = (next: Editing) => {
    setProblem(null);
    setMenu(null);
    focusing.current = null;
    if (next.kind === "add" && next.parent) expand(next.parent, true);
    setEditing(next);
  };
  const expand = (key: string, open: boolean) => setCollapsed((was) => (open ? new Set([...was].filter((k) => k !== key)) : new Set([...was, key])));

  /** A name that can't be one is said so. From the keyboard, and in a row being added, the field stays to put it right. */
  const refused = (key: string, name: string, parent: ManageItem | null, fromKeyboard: boolean) => {
    const wrong = actions.problem(name, parent);
    if (!wrong) return false;
    setProblem({ key, message: wrong });
    if (!fromKeyboard && key !== ADDING) setEditing(null);
    return true;
  };
  const rename = (item: ManageItem, parent: ManageItem | null, value: string, fromKeyboard: boolean) => {
    const mine = editing;
    const name = value.trim();
    if (!name || name === item.name) return finish(mine, item.key, fromKeyboard);
    if (refused(item.key, name, parent, fromKeyboard)) return;
    working(mine, item.key, () => actions.rename(item, name).then(settle(mine, item.key, fromKeyboard)), fromKeyboard);
  };
  const add = (parent: ManageItem | null, value: string, fromKeyboard: boolean) => {
    const mine = editing;
    const name = value.trim();
    // A row left with no name is dropped.
    if (!name) return finish(mine, parent?.key ?? null, fromKeyboard);
    if (refused(ADDING, name, parent, fromKeyboard)) return;
    working(mine, ADDING, () => actions.add(parent, name).then((key) => finish(mine, key, fromKeyboard)), true);
  };
  const describe = (item: ManageItem, value: string, fromKeyboard: boolean) => {
    const mine = editing;
    const description = value.trim();
    if (description === item.description) return finish(mine, item.key, fromKeyboard);
    working(mine, item.key, () => actions.describe(item, description).then(() => finish(mine, item.key, fromKeyboard)), true);
  };
  const move = (item: ManageItem, to: ManageItem | null, fromKeyboard: boolean) => {
    const mine = editing?.kind === "move" ? null : editing;
    if (editing?.kind === "move") setEditing(null);
    if (to) expand(to.key, true);
    working(mine, item.key, () => actions.move(item, to).then(settle(mine, item.key, fromKeyboard)));
  };

  const deletes = (item: ManageItem) => !!(item.may.delete && actions.delete);
  /** Deletes the row, as the plugin asks: its notice after has Undo. From the keyboard, the keyboard goes on to the row after it, or the one before. */
  const remove = (item: ManageItem, fromKeyboard: boolean) => {
    setMenu(null);
    if (busy) return;
    const all = rows.flatMap((row) => (row.item ? [row.item.key] : []));
    const at = all.indexOf(item.key);
    const inside = new Set<string>();
    const gather = (of: ManageItem) => of.children.forEach((child) => (inside.add(child.key), gather(child)));
    gather(item);
    const next = all.slice(at + 1).find((key) => !inside.has(key)) ?? all[at - 1] ?? null;
    // A refusal is said on the row, and leaves whatever another row is doing as it is.
    working(null, item.key, () =>
      actions.delete!(item).then((gone) => {
        if (gone && fromKeyboard && next) focusing.current = next;
      }),
    );
  };
  const places = (item: ManageItem) => [null, ...byKey.values()].filter((to) => actions.canMove(item, to));
  const menuOf = (item: ManageItem): MenuItem[] => [
    { label: "Open", icon, action: () => actions.open(item) },
    ...(item.may.rename ? [{ label: "Rename", icon: "edit" as const, shortcut: "F2", action: () => start({ kind: "rename", key: item.key }) }] : []),
    ...(item.may.describe ? [{ label: "Edit description", icon: "text" as const, shortcut: "Enter", action: () => start({ kind: "describe", key: item.key }) }] : []),
    ...(item.may.add ? [{ label: adding.inside, icon: "plus" as const, action: () => start({ kind: "add", parent: item.key }) }] : []),
    ...(item.may.move && places(item).length ? [{ label: "Move to…", icon: "folders" as const, action: () => start({ kind: "move", key: item.key }) }] : []),
    ...(deletes(item) ? [{ label: `Delete ${noun}`, icon: "trash" as const, shortcut: "Delete", separated: true, action: () => remove(item, false) }] : []),
  ];

  /** The arrow keys move through the rows and open and shut one, F2 renames, Enter says what it is for, and the menu key opens its menu. */
  const keys = (e: KeyboardEvent<HTMLTableRowElement>, item: ManageItem, parent: ManageItem | null, open: boolean) => {
    if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) return;
    const all = [...body.current!.querySelectorAll<HTMLElement>("tr[data-key]")];
    const at = all.indexOf(e.currentTarget);
    const has = item.children.length > 0;
    if (e.key === "ArrowDown") all[at + 1]?.focus();
    else if (e.key === "ArrowUp") all[at - 1]?.focus();
    else if (e.key === "Home") all[0]?.focus();
    else if (e.key === "End") all.at(-1)?.focus();
    else if (e.key === "ArrowRight") {
      if (has) open ? all[at + 1]?.focus() : expand(item.key, true);
    } else if (e.key === "ArrowLeft") {
      if (has && open) expand(item.key, false);
      else all.find((row) => row.dataset.key === parent?.key)?.focus();
    } else if (e.key === "F2" && item.may.rename) start({ kind: "rename", key: item.key });
    else if (e.key === "Enter" && item.may.describe) start({ kind: "describe", key: item.key });
    else if ((e.key === "Delete" || e.key === "Backspace") && deletes(item)) {
      remove(item, true);
    } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      const box = e.currentTarget.getBoundingClientRect();
      setMenu({ key: item.key, x: box.left + 24, y: box.bottom });
    } else return;
    e.preventDefault();
  };

  const dragged = drag ? byKey.get(drag.key) : undefined;
  /** Over a row it can go inside, or the strip for the top, a drag from this table may drop. Anything else dragged goes on to whatever takes it. */
  const over = (e: DragEvent, to: ManageItem | null) => {
    if (!dragged) return;
    if (!actions.canMove(dragged, to)) return setDrag((was) => (was && was.over !== null ? { ...was, over: null } : was));
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDrag({ key: dragged.key, over: to?.key ?? TOP, x: e.clientX, y: e.clientY });
  };
  const drop = (e: DragEvent, to: ManageItem | null) => {
    if (!dragged || !actions.canMove(dragged, to)) return;
    e.preventDefault();
    e.stopPropagation();
    setDrag(null);
    move(dragged, to, false);
  };
  const target = drag?.over ? (drag.over === TOP ? null : byKey.get(drag.over)) : undefined;

  const indent = (depth: number) => ({ "--depth": depth }) as CSSProperties;
  /** What is said under a row: a question about what it changes, or why it didn't go through. */
  const aside = (key: string, path: string, depth: number): ReactNode => {
    if (editing?.kind === "confirm" && editing.key === key) {
      const { confirmation } = editing;
      const close = () => finish(editing, key, true);
      return (
        <tr key={`${key}-aside`} className="manage-aside" role="row" style={indent(depth)}>
          <td role="gridcell" colSpan={3}>
            <form
              aria-label={`Rename ${path}`}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                e.stopPropagation();
                close();
              }}
              onSubmit={(e) => {
                e.preventDefault();
                const run = confirmation.run;
                if (busy || !run) return;
                const mine = editing;
                working(mine, key, () => run().then((next) => finish(mine, next, true)));
              }}
            >
              <p>{confirmation.message}</p>
              <div className="manage-aside-foot">
                <button type="button" className="button small" autoFocus={!confirmation.run} onClick={close}>
                  {confirmation.run ? "Cancel" : "Close"}
                </button>
                {confirmation.run && (
                  <button type="submit" className="button small primary" autoFocus aria-disabled={busy || undefined}>
                    {confirmation.action}
                  </button>
                )}
              </div>
            </form>
          </td>
        </tr>
      );
    }
    if (problem?.key !== key) return null;
    return (
      <tr key={`${key}-aside`} className="manage-aside" role="row" style={indent(depth)}>
        <td role="gridcell" colSpan={3}>
          <p role="alert" className="error">
            {problem.message}
          </p>
        </td>
      </tr>
    );
  };

  const drawn = rows.flatMap(({ item, depth, parent }) => {
    if (!item)
      return [
        <tr key={ADDING} className="manage-row" role="row" aria-level={depth + 1} style={indent(depth)}>
          <th scope="row" role="rowheader" className="manage-name-cell">
            <div className="manage-name-line">
              <span className="manage-toggle" />
              <NameField label={parent ? `${adding.inside} ${parent.path}` : adding.top} initial="" busy={busy} onCommit={(value, fromKeyboard) => add(parent, value, fromKeyboard)} onCancel={() => finish(editing, parent?.key ?? null, true)} />
            </div>
          </th>
          <td role="gridcell" className="manage-description-cell" />
          <td role="gridcell" className="manage-count" />
        </tr>,
        aside(ADDING, "", depth),
      ];
    const open = !collapsed.has(item.key) || !!wanted;
    const has = item.children.length > 0;
    const renaming = editing?.kind === "rename" && editing.key === item.key;
    const saying = editing?.kind === "describe" && editing.key === item.key;
    return [
      <tr
        key={item.key}
        data-key={item.key}
        className="manage-row"
        style={indent(depth)}
        role="row"
        aria-level={depth + 1}
        aria-expanded={has ? open : undefined}
        aria-keyshortcuts={[item.may.rename && "F2", item.may.describe && "Enter", deletes(item) && "Delete"].filter(Boolean).join(" ") || undefined}
        tabIndex={active === item.key || (!rows.some((row) => row.item?.key === active) && item === rows[0]?.item) ? 0 : -1}
        data-dragging={drag?.key === item.key || undefined}
        data-drop={drag?.over === item.key || undefined}
        onFocus={(e) => e.target === e.currentTarget && setActive(item.key)}
        onKeyDown={(e) => keys(e, item, parent, open)}
        onContextMenu={(e) => {
          if (renaming || saying) return;
          e.preventDefault();
          setActive(item.key);
          setMenu({ key: item.key, x: e.clientX, y: e.clientY });
        }}
        onDragOver={(e) => over(e, item)}
        onDrop={(e) => drop(e, item)}
      >
        <th scope="row" role="rowheader" className="manage-name-cell">
          <div className="manage-name-line">
            {has ? (
              <button type="button" className="manage-toggle" tabIndex={-1} data-open={open || undefined} aria-label={`${open ? "Collapse" : "Expand"} ${item.path}`} onClick={() => expand(item.key, !open)}>
                <Icon name="chevron" />
              </button>
            ) : (
              <span className="manage-toggle" />
            )}
            {renaming ? (
              <NameField label={`Rename ${item.path}`} initial={item.name} busy={busy} onCommit={(value, fromKeyboard) => rename(item, parent, value, fromKeyboard)} onCancel={() => finish(editing, item.key, true)} />
            ) : (
              <span
                className="manage-name"
                title={item.may.move ? "Drag to move" : undefined}
                onDoubleClick={() => item.may.rename && start({ kind: "rename", key: item.key })}
                {...(item.may.move && {
                  ...draggableAs(item.dragged, (e) => {
                    setMenu(null);
                    setDrag({ key: item.key, over: null, x: e.clientX, y: e.clientY });
                  }),
                  onDragEnd: () => setDrag(null),
                })}
              >
                {item.label}
              </span>
            )}
            {item.may.rename && !renaming && (
              <button type="button" className="manage-pencil" tabIndex={-1} aria-label={`Rename ${item.path}`} title="Rename (F2)" onClick={() => start({ kind: "rename", key: item.key })}>
                <Icon name="edit" />
              </button>
            )}
          </div>
        </th>
        <td role="gridcell" className="manage-description-cell">
          {saying ? (
            <DescriptionField label={describing(item)} initial={item.description} max={maxDescription} busy={busy} onCommit={(value, fromKeyboard) => describe(item, value, fromKeyboard)} onCancel={() => finish(editing, item.key, true)} />
          ) : item.may.describe ? (
            <p className="manage-description" data-editable onClick={() => start({ kind: "describe", key: item.key })}>
              {item.description || <span className="manage-placeholder">Add a description</span>}
            </p>
          ) : (
            item.description && <p className="manage-description">{item.description}</p>
          )}
        </td>
        <td role="gridcell" className="manage-count">
          <span title={item.notesTitle} aria-label={notes(item.notes)}>
            {item.notes}
          </span>
        </td>
      </tr>,
      aside(item.key, item.path, depth),
    ];
  });

  const menuItem = menu ? byKey.get(menu.key) : undefined;
  const moving = editing?.kind === "move" ? byKey.get(editing.key) : undefined;
  return (
    <div className="manage">
      <div className="manage-bar">
        <input type="search" className="filter manage-search" aria-label={`Search ${label.toLowerCase()}`} placeholder={`Search ${label.toLowerCase()} by name or description`} value={query} onChange={(e) => setQuery(e.target.value)} />
        {top && (
          <button type="button" className="button small manage-new" onClick={() => start({ kind: "add", parent: null })}>
            <Icon name="plus" />
            {adding.top}
          </button>
        )}
      </div>
      <table
        className="manage-table"
        role="treegrid"
        aria-label={label}
        hidden={none}
        // The keyboard's row is marked while the keyboard is in use: a click on a row the keyboard was on leaves no mark behind.
        onPointerDown={(e) => (e.currentTarget.dataset.pointer = "")}
        onKeyDown={(e) => delete e.currentTarget.dataset.pointer}
      >
        <thead role="rowgroup">
          <tr role="row">
            <th scope="col" role="columnheader">
              {column}
            </th>
            <th scope="col" role="columnheader">
              Description
            </th>
            <th scope="col" role="columnheader" title={notesHeading}>
              Notes
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup" ref={body}>
          {drawn}
        </tbody>
      </table>
      {dragged && actions.canMove(dragged, null) && (
        <div className="manage-drop-top" data-drop={drag?.over === TOP || undefined} onDragOver={(e) => over(e, null)} onDrop={(e) => drop(e, null)}>
          Drop here to move to the top level
        </div>
      )}
      {drag && dragged && target !== undefined && (
        <div className="manage-drag-label" style={{ left: drag.x + 14, top: drag.y + 16 }}>
          {dragged.path} → {actions.movedPath(dragged, target)}
        </div>
      )}
      {/* There before it says anything, so a screen reader says it when it does. */}
      <p className="soon manage-status" role="status">
        {none && wanted && (partial ? `No ${noun} read so far matches. Show more to search the rest.` : `No ${noun} matches.`)}
      </p>
      {menu && menuItem && <ContextMenu label={`${menuItem.path} actions`} x={menu.x} y={menu.y} items={menuOf(menuItem)} onClose={() => setMenu(null)} />}
      {moving && (
        <Palette
          label={`Move ${moving.path} to`}
          placeholder={`Where ${moving.path} goes`}
          empty={`No ${noun} matches.`}
          items={places(moving).map((to) => ({ id: to?.key ?? TOP, label: to === null ? "Top level" : to.path }))}
          onPick={(id) => move(moving, id === TOP ? null : byKey.get(id)!, true)}
          onClose={() => setEditing((was) => (was?.kind === "move" ? null : was))}
        />
      )}
    </div>
  );
}

/** Ends a field once, whether by a key or by leaving it, which follows when a key takes the field away. Ended, it lets Escape go on to Settings. */
function useEnding() {
  const ended = useRef(false);
  const end = (then: () => void) => {
    if (ended.current) return;
    ended.current = true;
    then();
  };
  /** Typing again after a refusal arms it once more. */
  const again = () => void (ended.current = false);
  return { end, ended: () => ended.current, again };
}

/** A name typed in the box it is shown in. Enter and leaving it keep what is typed, and Escape what was there. */
function NameField({ label, initial, busy, onCommit, onCancel }: { label: string; initial: string; busy: boolean; onCommit: (value: string, fromKeyboard: boolean) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const { end, ended, again } = useEnding();
  /** Sent with Enter, which leaving it after must not send again. */
  const sent = useRef(false);
  return (
    <input
      className="manage-name manage-name-input"
      aria-label={label}
      autoFocus
      spellCheck={false}
      readOnly={busy}
      value={value}
      size={Math.max(6, value.length + 1)}
      onChange={(e) => ((sent.current = false), again(), setValue(e.target.value))}
      onFocus={(e) => e.target.select()}
      onBlur={() => sent.current || end(() => onCommit(value, false))}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          if (busy || sent.current) return;
          // Not ended: a name that can't be one keeps the field, to be put right.
          sent.current = true;
          onCommit(value, true);
        } else if (e.key === "Escape" && !ended() && !busy) {
          e.preventDefault();
          e.stopPropagation();
          end(onCancel);
        }
      }}
    />
  );
}

/** A description typed in the box it is shown in, growing with it. Enter and leaving it keep what is typed, Shift+Enter starts a line, and Escape keeps what was there. */
function DescriptionField({ label, initial, max, busy, onCommit, onCancel }: { label: string; initial: string; max: number; busy: boolean; onCommit: (value: string, fromKeyboard: boolean) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const field = useRef<HTMLTextAreaElement>(null);
  const { end, ended, again } = useEnding();
  useLayoutEffect(() => {
    const el = field.current!;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={field}
      className="manage-description manage-description-input"
      aria-label={label}
      rows={1}
      autoFocus
      maxLength={max}
      readOnly={busy}
      value={value}
      onChange={(e) => (again(), setValue(e.target.value))}
      onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
      onBlur={() => end(() => onCommit(value, false))}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          end(() => onCommit(value, true));
        } else if (e.key === "Escape" && !ended() && !busy) {
          e.preventDefault();
          e.stopPropagation();
          end(onCancel);
        }
      }}
    />
  );
}
