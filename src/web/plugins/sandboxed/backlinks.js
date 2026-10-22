// The inspector's Backlinks tab: the notes that link to the open note, as the core lists them for
// this member. Pressing one opens it, and with ⌘ or Ctrl, or the middle button, it opens in a tab
// of its own behind the note in front, as a note in the note list does.
const style = document.createElement("style");
style.textContent = `
body { padding: 0; }
ul { margin: 0; padding: 0; list-style: none; }
.row { display: flex; flex-direction: column; gap: 2px; padding: 9px 12px 9px 14px; border-bottom: 1px solid var(--line); color: var(--ink); text-decoration: none; }
.row:hover { background: var(--hover); }
.title { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.snippet { display: -webkit-box; overflow: hidden; color: var(--muted); font-size: 12.5px; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.meta { display: flex; justify-content: space-between; gap: 8px; color: var(--faint); font-size: 11.5px; }
.archived .title, .archived .snippet { color: var(--faint); }
.state { flex: none; padding: 0 5px; border: 1px solid var(--line); border-radius: 4px; color: var(--muted); }
p { margin: 14px; color: var(--muted); font-size: 13px; }
.error { color: var(--danger); }
`;
document.head.append(style);

const el = (tag, className, text) => {
  const made = document.createElement(tag);
  if (className) made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
};

// The names along a folder's path, such as `Projects / Roadmap`. A note whose folder a guest can't see is "Shared with me".
function pathName(folders, id) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const names = [];
  for (let at = byId.get(id); at; at = at.parentId ? byId.get(at.parentId) : undefined) names.unshift(at.name);
  return names.length ? names.join(" / ") : "Shared with me";
}

let asked = 0;
async function draw() {
  const noteId = ink.context.noteId;
  if (!noteId) return;
  const mine = ++asked;
  let notes, folders;
  try {
    [notes, { folders }] = await Promise.all([ink.perform({ type: "note.backlinks", id: noteId }), ink.perform({ type: "folder.list" })]);
  } catch (err) {
    if (mine !== asked) return;
    const error = el("p", "error", err && err.message ? err.message : "Common Ink can't be reached");
    error.setAttribute("role", "alert");
    return ink.root.replaceChildren(error);
  }
  if (mine !== asked) return;
  if (!notes.length) return ink.root.replaceChildren(el("p", "", "No notes link here yet. Type [[ in another note to link to this one."));
  const list = el("ul");
  for (const from of notes) {
    const row = el("a", from.state === "archived" ? "row archived" : "row");
    // A link to the note's own address, which the frame's document is at the app's site to give: the frame can go
    // nowhere, so pressing it asks the app to open the note, and dragging it carries the note's address.
    row.href = `/note/${from.id}`;
    row.append(el("span", "title", from.title || "Untitled"));
    if (from.snippet) row.append(el("span", "snippet", from.snippet));
    const meta = el("span", "meta");
    meta.append(el("span", "", pathName(folders, from.folderId)));
    if (from.state === "archived") meta.append(el("span", "state", "Archived"));
    row.append(meta);
    row.addEventListener("click", (event) => {
      event.preventDefault();
      void ink.open(from.id, { background: event.metaKey || event.ctrlKey });
    });
    row.addEventListener("auxclick", (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      void ink.open(from.id, { background: true });
    });
    list.appendChild(el("li")).append(row);
  }
  const nav = el("nav");
  nav.setAttribute("aria-label", "Backlinks");
  nav.append(list);
  ink.root.replaceChildren(nav);
}

// Asked again whenever any note changes, since a link to this one may have been written or taken out.
ink.onItems(draw);
draw();
