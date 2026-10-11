/**
 * The plugin API. A plugin is a value with an id, a name, and an `activate` function, which is
 * handed a {@link PluginHost} and uses it to add commands, views, and embeds.
 *
 * Everything a plugin can do comes through the host it is handed. A plugin imports this module
 * and nothing else from the app. The built-in plugins in `plugins/` follow the same rule, which
 * `test/core/plugin-boundary.test.ts` checks.
 *
 * A plugin declares its options as `settings` and reads them through its host. It cannot change
 * them, or read anyone else's: settings are the member's.
 */
import type { ComponentType, ReactNode } from "react";
import type { Agent, ConnectOptions, ListedFolder, Note, NoteSummary, OpInput, Results, WorkspaceSummary } from "../core/protocol.ts";
import type { IconName } from "./icons.tsx";

/** The workspace operations and what they answer with: the same ones an agent has. */
export type * from "../core/protocol.ts";
export { DEFAULT_EXPIRY_DAYS, MAX_AGENT_NAME, MAX_EXPIRY_DAYS } from "../core/protocol.ts";

export { useDismiss } from "./dismiss.ts";
export { ResizeHandle } from "./resize.tsx";
export { Icon, type IconName } from "./icons.tsx";
export { ago, useNow } from "./time.ts";

/** The drag type that carries a note's id, so a note dragged out of one plugin's view can be dropped on another's. */
export const NOTE_DRAG = "application/x-common-ink-note";

export interface Plugin {
  /** What the plugin is known by in storage and in what it contributes. It never changes. */
  id: string;
  /** What a person sees it called. */
  name: string;
  /** One line on what it is for, said beside its name on the Plugins page. */
  description?: string;
  /** What stands for it on the Plugins page. Without one, the picture every plugin has. */
  icon?: IconName;
  /** Pictures of it at work, shown in its details on the Plugins page. */
  screenshots?: readonly Screenshot[];
  /**
   * The plugin's options, by name. Each is a setting the member can change, kept under the key
   * `<plugin id>.<name>`. They are data, so they are listed whether or not the plugin is on.
   * `enabled` is taken: it is the setting that turns the plugin on and off.
   */
  settings?: Readonly<Record<string, Setting>>;
  /**
   * Called when the plugin is turned on. Everything it registers here is taken back out when it is
   * turned off. A plugin that starts anything else, such as a timer or a listener, returns a
   * function that stops it.
   */
  activate(host: PluginHost): void | Dispose;
}

/** A picture of a plugin at work. `dark` is the same picture taken in the dark theme, shown in its place there. */
export interface Screenshot {
  src: string;
  dark?: string;
  /** What the picture shows, for whoever can't see it. It is also its caption. */
  alt: string;
}

/**
 * One setting: what it holds, what it is when the member hasn't changed it, and what a person is
 * told about it. The words are JSON Schema's, and it is plain data: no functions and no classes.
 */
export type Setting = { title: string; description?: string } & (
  | { type: "boolean"; default: boolean }
  | { type: "string"; default: string; enum?: readonly string[]; maxLength?: number }
  | { type: "number" | "integer"; default: number; minimum?: number; maximum?: number }
  /** Chords such as `mod+shift+p`, which is what a keybinding holds. */
  | { type: "chords"; default: readonly string[] }
);

export type SettingValue = boolean | string | number | readonly string[];

/** The operations a plugin can perform: all but the member's settings. */
export type PluginOp = Exclude<OpInput, { type: `settings.${string}` }>;
/** What a folder's list is called. Null for a folder that isn't there, or that the member can't see. */
export const folderTitle = (folders: Folders, folderId: string): string | null => (folderId === ALL_NOTES ? "All notes" : (folders.byId.get(folderId)?.name ?? null));

/** What stands for a folder where the notes listed are every note the member can see. */
export const ALL_NOTES = "all";

/**
 * What the editor area has in front, and what an address can name there: a note, a folder's list
 * of notes, or a page. A folder's `id` is a folder's id, or {@link ALL_NOTES}.
 * A page's `id` is the id it was registered with, and `path` is the address it is at:
 * `/plugins/tabs` for the page at `/plugins`. Wherever under its path a page is, it is the same page.
 */
export type Opened = { kind: "note"; id: string } | { kind: "folder"; id: string } | { kind: "page"; id: string; path: string };


/** Takes one contribution back out. */
export type Dispose = () => void;

/** What one plugin is handed. Each plugin gets its own, which knows which plugin is asking. */
export interface PluginHost {
  readonly plugin: { readonly id: string; readonly name: string };
  /** The workspace the plugin is running in, and the member's role there. */
  readonly workspace: WorkspaceSummary;
  readonly commands: {
    register(command: Command): Dispose;
    /** Every command from every plugin that is on. */
    list(): CommandInfo[];
    /** False when no command has that id. */
    run(id: string): boolean;
  };
  readonly views: {
    register<S extends keyof Slots>(slot: S, view: Slots[S]): Dispose;
  };
  readonly embeds: {
    register(embed: Embed): Dispose;
  };
  /** The app as it is now. A view is handed this as `app`; a command reads it when it runs. It isn't there yet during `activate`. */
  app(): App;
  /**
   * Performs a workspace operation as the member, with the member's access. Typing in open editors
   * is saved before an operation that moves a note through its history, and the editors take the result.
   * A settings operation is refused.
   */
  perform<T extends PluginOp>(op: T): Promise<Results[T["type"]]>;
  /** This plugin's own options, as the member set them or as they default. There is no way to change one. */
  readonly settings: {
    /** The option declared under `name` in the plugin's `settings`. A value the member got wrong reads as the default. */
    get<T extends SettingValue = SettingValue>(name: string): T;
    /** Calls `listener` when the member's settings change. A view is drawn again without asking. */
    subscribe(listener: () => void): Dispose;
  };
  /** The member's agents. The token in `connect`'s answer is the only time it can be seen. */
  readonly agents: {
    list(): Promise<Agent[]>;
    connect(name: string, options: ConnectOptions): Promise<{ agent: Agent; token: string }>;
    disconnect(id: string): Promise<void>;
  };
  /** JSON this plugin keeps in this browser for this workspace. Other plugins can't see it. */
  readonly storage: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
  };
}

export interface Command {
  /** What a keybinding or another plugin names it by. It doesn't change when the title does. */
  id: string;
  title: string;
  run: () => void;
  /** The chords that run it unless the member's keybindings say otherwise, such as `mod+shift+p`. `mod` is ⌘ or Ctrl. */
  keys?: readonly string[];
  /** A text field has its own answer to this command, so its keys are left to a field that has focus. */
  leaveToFields?: boolean;
}

export interface CommandInfo {
  id: string;
  title: string;
  /** The first chord that runs it now, as a person reads it, such as `⇧⌘P`. */
  shortcut: string | undefined;
}

/** What a view is drawn with. */
export interface ViewProps {
  app: App;
}

export type View = ComponentType<ViewProps>;

/** The places a view can go. Views in a slot are drawn in the order of the plugins that added them. */
export interface Slots {
  /** A column left of the editor. In writing mode there is no room for it. */
  column: { id: string; component: View };
  /** A section of the sidebar, such as the folder tree. A column places them with `app.sections`; in writing mode they are in the left popover. */
  section: { id: string; component: View };
  /** An icon, or a few, in the left rail of writing mode. */
  rail: { id: string; component: View };
  /** What fills the editor area when a note, a folder's list, a page, or nothing is open. The last one registered is used; with none, the app shows what the address names alone. */
  editor: {
    id: string;
    component: ComponentType<EditorProps>;
    /**
     * Asked to open a note, a folder's list or a page, in place of the app going to it. Call
     * `app.show` with what ends up in front. With `background` it is opened without being put in front.
     */
    open?: (tab: Opened, options: { preview: boolean; background?: boolean }) => void;
  };
  /**
   * A folder's list of notes, drawn in the editor area where a folder is open. The last one
   * registered is used; with none, the app lists the folder's notes by title.
   */
  folder: { id: string; component: ComponentType<FolderProps> };
  /** A tab of the inspector, about the open note. It is also an icon in the right rail of writing mode. The inspector opens on the last tab. */
  inspector: {
    id: string;
    label: string;
    icon: IconName;
    component: ComponentType<ViewProps & { note: NoteSummary }>;
    /** Something to flag on the tab, read to a screen reader, or null. */
    badge?: (app: App) => string | null;
  };
  /**
   * A page with its own address, shown in the editor area as a note is: in a tab, where the editor
   * area has tabs. A page does nothing for that. It is drawn with an `app` whose `path` and
   * `pageState` are its own, so two pages open side by side each read their own address, and
   * `app.go` to an address under its path moves that page and no other. `nav` says where its link goes:
   * with the main links of the sidebar, under More, or in the workspace menu. Each page gets a
   * `go.<id>` command. A page is also shown at every address under its
   * path, such as `/plugins/tabs` for the page at `/plugins`, unless another page is at exactly that address:
   * it reads the rest from `app.path`. One that is `transient` only leads somewhere else
   * with `app.show`: it is never a tab, and is drawn in place of the editor area for the moment it
   * takes to find where to go.
   */
  page: { id: string; path: `/${string}`; label: string; icon?: IconName; nav?: "primary" | "more" | "menu"; transient?: boolean; component: View };
  /** Something drawn over the app, such as the command palette. One is open at a time; `app.toggleOverlay` opens it. */
  overlay: { id: string; component: ComponentType<ViewProps & { close: () => void }> };
}

export interface FolderProps extends ViewProps {
  /** The folder whose notes to list: a folder's id, or {@link ALL_NOTES}. It may name no folder the member can see. */
  folderId: string;
  /**
   * Draws a note's text to be read and not changed, as its editor draws it: the same embeds and the
   * same marks, at its full height with no scrolling of its own. The text is read when this is drawn.
   */
  readNote: (noteId: string) => ReactNode;
}

export interface EditorProps extends ViewProps {
  /** Draws the editor for a note. `onEdit` is called on each change typed or pasted. */
  renderNote: (noteId: string, options?: { onEdit?: () => void }) => ReactNode;
  /** Draws a folder's list of notes, with whatever is in the `folder` slot. */
  renderFolder: (folderId: string) => ReactNode;
  /** Draws a page at the address it is at, which is {@link Opened}'s `path`. One no plugin has registered any more is drawn as nothing being there. */
  renderPage: (pageId: string, path: string) => ReactNode;
  /** What to show where nothing is open: a line saying to pick a note. */
  empty: ReactNode;
  /**
   * The buttons that act on the window and on no one note: the inspector and writing mode. Put them
   * once, at the top right corner of the editor area, where they stay whatever is open beneath.
   */
  controls: ReactNode;
}

/**
 * Content drawn inside a note where the note says `::name{config}`. It is handed its own config
 * and an element to draw in, and nothing about the note, the workspace, or the member.
 */
export interface Embed {
  /** The name a note writes it by: lowercase letters, digits, and `-`. */
  name: string;
  /** What a person sees it called. */
  title: string;
  /** Draws into `el`. May return a function that stops whatever it started. */
  render(el: HTMLElement, embed: { config: string }): void | (() => void);
}

/** A workspace's folders, indexed for drawing the tree and naming a folder's path. */
export interface Folders {
  unsortedId: string;
  byId: ReadonlyMap<string, ListedFolder>;
  /** Children in display order; at the top level, Unsorted comes first. */
  childrenOf(parentId: string | null): readonly ListedFolder[];
  /** The folder and its ancestors, outermost first. */
  pathOf(id: string): ListedFolder[];
  /** The names along `pathOf`, such as `Projects / Roadmap`. */
  pathName(id: string): string;
}

export type PageInfo = Pick<Slots["page"], "id" | "path" | "label" | "icon" | "nav">;

/** The app at one moment: what is open, and what can be done about it. */
export interface App {
  me: { id: string; name: string; email: string };
  workspace: WorkspaceSummary;
  /** Every workspace the member is in. */
  workspaces: readonly WorkspaceSummary[];
  /** Whether the member's role lets them change notes and folders. */
  canEdit: boolean;
  /** The address the app is at, such as `/history`. */
  path: string;
  /** What `go` was handed for this address, if anything. It is handed over once: Back or a reload finds nothing. */
  pageState: unknown;
  /** What the address names in the editor area: the note, the folder's list or the page in front. Null when nothing is open, and at an address nothing is at. */
  opened: Opened | null;
  /** The note the address names. Null on a page, on a folder's list, and when nothing is open. */
  noteId: string | null;
  /** That note, once the workspace's notes have loaded and if the member can see it. */
  note: NoteSummary | null;
  /** Whether the open note has changes by someone else that the member hasn't been shown. */
  unseen: boolean;
  /** Every note in the workspace the member can see. Null while they load. */
  notes: readonly NoteSummary[] | null;
  /** Null while they load. */
  folders: Folders | null;
  /**
   * The folder in front: the one whose list the address names, {@link ALL_NOTES} among them, or the
   * folder of the note it names. Null on a page, and when nothing is open. The folder tree marks it.
   */
  folderId: string | null;
  writing: boolean;
  pages: readonly PageInfo[];
  /** What plugins put in the `section` slot, for the column that shows them. */
  sections: ReactNode;
  /** Draws a note's text to be read and not changed, as {@link FolderProps.readNote} does, for a page that lists notes. */
  readNote: (noteId: string) => ReactNode;
  /** The overlay that is open. */
  overlay: string | null;

  /** Goes to an address. `state` is for the page there, which reads it as `pageState`. `replace` keeps Back from retracing the step. */
  go(path: string, options?: { state?: unknown; replace?: boolean }): void;
  /** Where a note lives, such as `/note/plan-3k2j5h8d9f0a`. */
  notePath(noteId: string): string;
  /**
   * Opens a note. A preview gives way to the next thing previewed, and takes the place of the one there, unless that is the folder's list in front: a list a note is previewed from is kept. `focus` puts the cursor in its
   * editor. `background` opens it in a tab of its own, which is kept, without leaving what is in
   * front. Where the editor area has no tabs the note is opened as it otherwise would be.
   */
  openNote(noteId: string, options?: { preview?: boolean; focus?: boolean; background?: boolean }): void;
  /** Opens a folder's list of notes: a folder's id, or {@link ALL_NOTES}. A preview, which it is unless said, takes the place of the preview there, a note's or a folder's. */
  openFolder(folderId: string, options?: { preview?: boolean }): void;
  /** Where a folder's list lives, such as `/folder/all`. */
  folderPath(folderId: string): string;
  /** For the editor area: puts a note, a folder's list or a page at the app's address, or nothing. `replace` keeps Back from retracing the step. */
  show(tab: Opened | null, options?: { replace?: boolean }): void;
  /**
   * Creates a note and opens it. It goes in `folderId` when that is a folder; otherwise in the
   * folder in front, which is the open note's folder when a note is in front; otherwise in Unsorted.
   */
  createNote(folderId?: string): void;
  moveNote(noteId: string, folderId: string): Promise<void>;
  /** Tells the app a note changed, with the note as it is now. */
  noteChanged(note: Note): void;
  /** Reads the folders and notes again, after a change the app wasn't told about. */
  refresh(): void;
  /** Records that the member was shown a note's changes up to a revision. */
  markSeen(noteId: string, revision: number): void;
  toggleOverlay(id: string): void;
  switchWorkspace(workspaceId: string): void;
  signOut(): void;
}
