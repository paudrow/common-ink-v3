import { useState, type MouseEvent } from "react";
import { MAX_FOLDER_DESCRIPTION, type App, type ListedFolder, type PluginHost } from "../plugin-api.ts";
import { canMove, canRename, placesFor } from "./lib/folderMoves.ts";
import { hoverCards, type HoverCards } from "./lib/hoverCard.tsx";
import { ManageTable, type ManageActions, type ManageItem } from "./lib/ManageTable.tsx";

/** Where every folder is described: the Folders section of Settings, which the Folders plugin adds. */
export const SETTINGS_ID = "folders";
export const MANAGE_PATH = `/settings/${SETTINGS_ID}`;

/** Who may say what a folder is for: a member who may change things, and not a guest, whom the server refuses. */
export const describes = (app: App) => app.workspace.role === "admin" || app.workspace.role === "editor";

/** What a folder's menu or card asked of Settings' Folders when it brought the member there: the folder's row, open to describe it when `describe`. */
export interface FolderRequest {
  id: string;
  describe: boolean;
}

/** Holds a request until Settings' Folders takes it, once. */
export function asking() {
  let request: FolderRequest | null = null;
  return {
    ask(asked: FolderRequest) {
      request = asked;
    },
    take() {
      const asked = request;
      request = null;
      return asked;
    },
  };
}
export type Asking = ReturnType<typeof asking>;

/** A link that goes where the app goes, and lets a modified click open a new tab. */
const going = (href: string, go: () => void) => ({
  href,
  onClick(e: MouseEvent) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    go();
  },
});
const notes = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`;

/**
 * Settings' Folders: every folder as a tree, Unsorted first as in the sidebar and then in name order
 * at every level, with what it is for and how many notes are in it and the folders inside it, said
 * for the agents that choose where to file a note and the people resting on a folder. Whoever may edit a folder says it here, renames the
 * folder, moves it inside another and makes one inside it; anyone else reads it.
 */
export function ManageFolders({ host, app, ask }: { host: PluginHost; app: App; ask: Asking }) {
  const tree = app.folders;
  const may = describes(app);
  const [asked] = useState(() => ask.take());
  if (!tree) return null;
  const top = app.workspace.role !== "guest";
  const itemOf = (folder: ListedFolder): ManageItem => {
    const children = tree.childrenOf(folder.id).map(itemOf);
    const all = folder.noteCount + children.reduce((sum, child) => sum + child.notes, 0);
    return {
      key: folder.id,
      name: folder.name,
      label: folder.name,
      path: tree.pathName(folder.id),
      description: folder.description ?? "",
      notes: all,
      notesTitle: children.length ? `${notes(folder.noteCount)} in ${folder.name} itself, ${all} counting the folders inside it` : undefined,
      dragged: { kind: "folder", id: folder.id },
      first: folder.id === tree.unsortedId,
      may: { rename: canRename(tree, folder.id, top), describe: may && folder.access === "edit", add: app.workspace.role !== "viewer" && folder.access === "edit", move: placesFor(tree, folder.id, top).length > 0 },
      children,
    };
  };
  const roots = tree.childrenOf(null).map(itemOf);
  const changed = async <T,>(work: Promise<T>) => {
    const done = await work;
    await app.refresh();
    return done;
  };
  const actions: ManageActions = {
    open: (item) => app.go(app.folderPath(item.key)),
    rename: async (item, name) => (await changed(host.perform({ type: "folder.rename", id: item.key, name })), { key: item.key }),
    describe: async (item, description) => void (await changed(host.perform({ type: "folder.describe", id: item.key, description }))),
    async add(parent, name) {
      const made = await changed(host.perform({ type: "folder.create", name, ...(parent ? { parentId: parent.key } : {}), ifExists: "error" }));
      return made.id;
    },
    async move(item, to) {
      const from = tree.byId.get(item.key)!.parentId;
      await changed(host.perform({ type: "folder.move", id: item.key, parentId: to?.key ?? null }));
      app.notify({
        message: `Moved "${item.name}" ${to ? `into "${to.name}"` : "to the top"}`,
        icon: "folders",
        action: { label: "Undo", run: () => changed(host.perform({ type: "folder.move", id: item.key, parentId: from })).then(() => ({ message: `"${item.name}" is back` })) },
      });
      return { key: item.key };
    },
    canMove: (item, to) => canMove(tree, item.key, to?.key ?? null, top),
    movedPath: (item, to) => (to ? `${to.path} / ${item.name}` : item.name),
    problem: () => null,
  };
  return (
    <>
      <p className="soon">
        {may ? "Say what goes in each folder. Agents choose where to file a note by it, and it shows when you rest on a folder." : "What each folder is for. Agents choose where to file a note by it. Admins and editors write it."}
      </p>
      {!roots.length && <p className="soon">No folders yet.</p>}
      <ManageTable
        label="Folders"
        column="Folder"
        noun="folder"
        notesHeading="Notes in this folder or any folder inside it"
        adding={{ top: "New folder", inside: "New folder inside" }}
        icon="folders"
        roots={roots}
        top={top && app.workspace.role !== "viewer"}
        describing={(item) => `What goes in ${item.path}`}
        maxDescription={MAX_FOLDER_DESCRIPTION}
        actions={actions}
        opening={asked && tree.byId.has(asked.id) ? { key: asked.id, kind: asked.describe && may ? "describe" : null } : null}
      />
    </>
  );
}

/**
 * The card a folder shows while it is pointed at or has the keyboard: anything marked `data-folder`
 * with the folder's id, as the sidebar's rows and the breadcrumbs above a note are. It says how many
 * notes are in the folder and what it is for. With nothing said, it asks whoever may say it to, with
 * a link to its row in Settings, and shows anyone else the name and count alone.
 */
export const folderCards = (host: PluginHost, ask: Asking): HoverCards =>
  hoverCards("folder", (id, close) => (host.app().folders?.byId.has(id) ? <FolderCard app={host.app()} ask={ask} id={id} onClose={close} /> : null));

function FolderCard({ app, ask, id, onClose }: { app: App; ask: Asking; id: string; onClose: () => void }) {
  const folder = app.folders!.byId.get(id)!;
  const name = app.folders!.pathName(id);
  const leave = (href: string, go: () => void) => going(href, () => (go(), onClose()));
  return (
    <>
      <div className="hover-card-head">
        <a className="hover-card-name" {...leave(app.folderPath(id), () => app.openFolder(id))}>
          {name}
        </a>
        <span className="hover-card-count">{notes(folder.noteCount)}</span>
      </div>
      {folder.description ? (
        <p className="hover-card-description">{folder.description}</p>
      ) : (
        describes(app) && <p className="hover-card-none">No description yet. Add one to help AI file notes in {folder.name}.</p>
      )}
      {describes(app) && (
        <a
          className="hover-card-manage"
          {...leave(MANAGE_PATH, () => {
            ask.ask({ id, describe: !folder.description });
            app.go(MANAGE_PATH);
          })}
        >
          Manage folders
        </a>
      )}
    </>
  );
}
