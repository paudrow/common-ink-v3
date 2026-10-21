import { createContext, useContext, useState, type ReactNode } from "react";

/** Whether the search above keeps a row out of sight. A row is hidden rather than taken out, so one being written in keeps what was typed. */
const Hidden = createContext(false);

/**
 * A table of named things and what each is for, as Settings' Tags and Folders are: each row's name,
 * then its description, then its count and what can be done to it. A search box above keeps the rows
 * whose name or description has what is typed, in the order they are given. `column` names the first
 * column and `noun` one row, as "Tag" and "tag". `actions` says whether there is a column of buttons,
 * which a member given nothing to change has none of. `partial` says more rows are still to be read,
 * which the search can't find yet. Each row is drawn by whoever lists them, as a `ManageRow`.
 *
 * The roles are written out because a narrow pane draws the rows as cards, and some browsers drop a
 * table's roles once its parts aren't drawn as one.
 */
export function ManageTable<T>({ label, column, noun, rows, keyOf, text, actions, partial = false, row }: { label: string; column: string; noun: string; rows: readonly T[]; keyOf: (item: T) => string; text: (item: T) => string; actions: boolean; partial?: boolean; row: (item: T) => ReactNode }) {
  const [query, setQuery] = useState("");
  const wanted = query.trim().toLowerCase();
  const kept = (item: T) => !wanted || text(item).toLowerCase().includes(wanted);
  const none = !rows.some(kept);
  return (
    <>
      <input type="search" className="filter manage-search" aria-label={`Search ${label.toLowerCase()}`} placeholder={`Search ${label.toLowerCase()} by name or description`} value={query} onChange={(e) => setQuery(e.target.value)} />
      <table className="manage-table" role="table" aria-label={label} hidden={none}>
        <thead role="rowgroup">
          <tr role="row">
            <th scope="col" role="columnheader">
              {column}
            </th>
            <th scope="col" role="columnheader">
              Description
            </th>
            <th scope="col" role="columnheader">
              Notes
            </th>
            {actions && <th scope="col" role="columnheader" aria-label="Change" />}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((item) => (
            <Hidden.Provider key={keyOf(item)} value={!kept(item)}>
              {row(item)}
            </Hidden.Provider>
          ))}
        </tbody>
      </table>
      {/* There before it says anything, so a screen reader says it when it does. */}
      <p className="soon manage-status" role="status">
        {none && (partial ? `No ${noun} read so far matches. Show more to search the rest.` : `No ${noun} matches.`)}
      </p>
    </>
  );
}

/**
 * One row of a `ManageTable`. While the name itself is being changed, `description` is null and the
 * name's cell takes the description's room too. `actions` is left out where the table has no column of them.
 */
export function ManageRow({ name, description, count, actions }: { name: ReactNode; description: ReactNode | null; count: ReactNode; actions?: ReactNode }) {
  const hidden = useContext(Hidden);
  return (
    <tr className="manage-row" role="row" hidden={hidden}>
      <th scope="row" role="rowheader" className="manage-name-cell" colSpan={description === null ? 2 : undefined}>
        {name}
      </th>
      {description !== null && (
        <td role="cell" className="manage-description-cell">
          {description}
        </td>
      )}
      <td role="cell" className="manage-count">
        {count}
      </td>
      {actions !== undefined && (
        <td role="cell" className="manage-actions">
          {actions}
        </td>
      )}
    </tr>
  );
}
