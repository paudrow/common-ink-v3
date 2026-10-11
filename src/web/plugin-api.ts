/**
 * The plugin API. A plugin is a value with an id, a name, and an `activate` function, which is
 * handed a {@link PluginHost} and uses it to add commands, views, embeds, completions, and editor extensions.
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

export { dismissing, useDismiss } from "./dismiss.ts";
export { Icon, type IconName } from "./icons.tsx";
export { ago, useNow } from "./time.ts";

/** The drag type that carries a note's id, so a note dragged out of one plugin's view can be dropped on another's. */
export const NOTE_DRAG = "application/x-common-ink-note";

export interface Plugin {
  /** What the plugin is known by in storage and in what it contributes. It never changes. */
  id: string;
  /** What a person sees it called. */
  name: string;
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
  /** False for a plugin that is off until the member turns it on. */
  enabledByDefault?: boolean;
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
    /** Every embed from every plugin that is on, as a menu would offer them. */
    list(): EmbedInfo[];
  };
  readonly completions: {
    register(completion: Completion): Dispose;
  };
  readonly editorExtensions: {
    register(extension: EditorExtension): Dispose;
  };
  /**
   * Tells the member that the plugin is on and something it is for didn't work, such as a part of it
   * that couldn't be loaded. It is shown on the Plugins page until the plugin is turned off or on again.
   */
  report(error: unknown): void;
  /** Calls `listener` each time the app arrives at an address, and once for the address it is at when the plugin starts later than the app. */
  onNavigate(listener: () => void): Dispose;
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
  /**
   * The chords that run it unless the member's keybindings say otherwise, such as `mod+shift+p`.
   * `mod` is ⌘ on a Mac and Ctrl elsewhere. `ctrl` is the Control key on both.
   */
  keys?: readonly string[];
  /** Whether its keys run it now. While it answers false, a press of them is left to whatever has focus. The palette runs it either way. */
  when?: () => boolean;
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
  /** A column left of the editor. In writing mode there is no room for it, and one with `popover` is shown in the left popover instead. */
  column: { id: string; component: View; popover?: boolean };
  /** A section of the sidebar, such as the folder tree. A column places them with `app.sections`; in writing mode they are in the left popover. */
  section: { id: string; component: View };
  /** An icon, or a few, in the left rail of writing mode. */
  rail: { id: string; component: View };
  /** What fills the editor area when a note or nothing is open. The last one registered is used; with none, the app shows the open note alone. */
  editor: {
    id: string;
    component: ComponentType<EditorProps>;
    /** Asked to open a note, in place of the app going to it. Call `app.showNote` with the note that ends up in front. */
    open?: (noteId: string, options: { preview: boolean }) => void;
  };
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
   * A page with its own address, shown in place of the editor. `nav` says where its link goes:
   * with the main links of the sidebar, under More, or in the workspace menu. Each page gets a
   * `go.<id>` command.
   */
  page: { id: string; path: `/${string}`; label: string; icon?: IconName; nav?: "primary" | "more" | "menu"; component: View };
  /**
   * A widget in the bar along the bottom of the app, such as a running timer. The bar is one line of
   * small things to glance at. It is there in writing mode too, and keeps its height when a widget
   * has nothing to show, so nothing above it moves when one appears.
   */
  bar: { id: string; component: View };
  /** Something drawn over the app, such as the command palette. One is open at a time; `app.toggleOverlay` opens it. */
  overlay: { id: string; component: ComponentType<ViewProps & { close: () => void }> };
}

export interface EditorProps extends ViewProps {
  /**
   * Draws the editor for a note. `onEdit` is called on each change typed or pasted. `corner` is
   * for the editor at the right edge, which carries the buttons for the inspector and writing mode.
   */
  renderNote: (noteId: string, options?: { onEdit?: () => void; corner?: boolean }) => ReactNode;
}

/**
 * Content drawn inside a note where the note says `::name{config}`, or for a block embed where it
 * says `:::name{config}` on a line, then the embed's body as markdown, then `:::` on a line. It is
 * handed what the note says of it, an element to draw in, and a way to rewrite itself, and nothing
 * else about the note, the workspace, or the member.
 */
export interface Embed {
  /** The name a note writes it by: lowercase letters, digits, and `-`. */
  name: string;
  /** What a person sees it called. */
  title: string;
  /** Whether it is written as a block, with a body. One embed is written one way. */
  block?: boolean;
  /** What a new one is written with when it is picked from the embed menu. With none, an empty config and an empty body. */
  starts?: { config?: string; body?: string };
  /**
   * Draws into `el`, once, all of it before returning, so the embed is never seen half drawn. May
   * return a function that stops whatever it started, or a {@link Drawn}. An embed is registered
   * while its plugin starts, not later, so a note never shows it as written first.
   */
  render(el: HTMLElement, embed: Embedded): void | (() => void) | Drawn;
}

/** What an embed can give back from `render`. */
export interface Drawn {
  /**
   * Changes what was drawn to fit what the note says of the embed now, in the elements already
   * there. Without it the embed's element is emptied and `render` is called on it again, and focus
   * goes to the element whose `data-focus` is that of the one that had it.
   */
  update?(embed: Embedded): void;
  /** Stops whatever the embed started. */
  stop?(): void;
}

/** What an embed is handed about one place a note writes it. */
export interface Embedded {
  config: string;
  /** A block embed's body: the note's lines between its opening and closing lines, each with its line break. Empty for an inline embed. */
  body: string;
  /** Whether the member can't change the note. `update` then does nothing, so an embed draws what it shows without the controls that would call it. */
  readOnly: boolean;
  /**
   * Rewrites this embed in the note as an edit by the member, which is saved, recorded, and undone
   * as typing is. What isn't given stays as it is. It does nothing once the note says something else
   * of the embed than what this was drawn from, or once the embed is no longer drawn, and throws for a config holding `{`, `}`, or a line
   * break, and for a body holding a line that is only `:::`. Called while the embed is being drawn, it is carried out
   * right after, since the note can't be changed in the middle of drawing it.
   */
  update(next: { config?: string; body?: string }): void;
  /**
   * Puts the cursor in the embed as the note writes it, to be changed there. An inline embed is
   * shown as written while the cursor is on it. A block stays drawn, with its lines shown under the
   * drawing until the cursor leaves them, and this is the only way into them.
   */
  edit(): void;
}

export type EmbedInfo = Pick<Embed, "name" | "title" | "block" | "starts">;

/**
 * A list offered at the cursor while the member types after a trigger, such as the embed menu on
 * `/`. It opens where the trigger starts a line or follows a space, and not inside code, so a `/`
 * in a path or a date opens nothing. Completions whose triggers both fit share one list, each
 * one's items in the order of their plugins.
 */
export interface Completion {
  id: string;
  /** What is typed to open it, such as `/`, `@`, or `[[`. */
  trigger: string;
  /** Whether what is typed after the trigger may hold spaces, as a note's title does. Without it a space closes the list. */
  spaces?: boolean;
  /** What to offer for what has been typed after the trigger, best first. Nothing closes the list. */
  items(typed: string): readonly CompletionItem[] | Promise<readonly CompletionItem[]>;
}

export interface CompletionItem {
  label: string;
  /** Said after the label, more quietly. */
  detail?: string;
  /** What takes the place of the trigger and what was typed after it. */
  insert: string;
  /** The part of `insert` left selected, as offsets into it, such as a value to type over. Without it the cursor goes after. */
  select?: readonly [from: number, to: number];
  /** Whether `insert` goes on lines of its own, as a block embed must. The cursor goes to the line after. */
  block?: boolean;
}

/**
 * Something added to the editor of every note: keys, decorations, a panel. `extension` is a
 * CodeMirror 6 `Extension`, built from the plugin's own imports of `@codemirror/*`, or a function
 * that makes one for each editor from what it is told about that editor. This module doesn't name
 * CodeMirror's type, so one that isn't an extension is left out, a value when it is added and what a
 * function makes in the editor it was made for, and its plugin is told so. So is a function that
 * throws. Extensions come before the editor's own, in the order of their plugins.
 */
export interface EditorExtension {
  id: string;
  extension: object | ((editor: EditorContext) => object);
}

/** What an editor extension given as a function is told about the editor it is being made for. */
export interface EditorContext {
  /** The note the editor holds. An editor holds one note for as long as it lasts. */
  noteId: string;
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
  /** The note the address names. Null on a page, and when nothing is open. */
  noteId: string | null;
  /** That note, once the workspace's notes have loaded and if the member can see it. */
  note: NoteSummary | null;
  /** Whether the open note has changes by someone else that the member hasn't been shown. */
  unseen: boolean;
  /** Every note in the workspace the member can see. Null while they load. */
  notes: readonly NoteSummary[] | null;
  /** Null while they load. */
  folders: Folders | null;
  /** The folder the note list is showing, or null for every note. */
  folderId: string | null;
  writing: boolean;
  pages: readonly PageInfo[];
  /** What plugins put in the `section` slot, for the column that shows them. */
  sections: ReactNode;
  /** The overlay that is open. */
  overlay: string | null;

  /** Goes to an address. `state` is for the page there, which reads it as `pageState`. */
  go(path: string, options?: { state?: unknown }): void;
  /** Where a note lives, such as `/note/plan-3k2j5h8d9f0a`. */
  notePath(noteId: string): string;
  /** Opens a note. A preview gives way to the next note previewed. `reveal` turns the note list to the note's folder. `focus` puts the cursor in its editor. */
  openNote(noteId: string, options?: { preview?: boolean; reveal?: boolean; focus?: boolean }): void;
  /** For the editor area: puts a note at the app's address, or nothing. `replace` keeps Back from retracing the step. */
  showNote(noteId: string | null, options?: { replace?: boolean }): void;
  /** Creates a note in the folder the note list is showing, and opens it. */
  createNote(): void;
  selectFolder(folderId: string): void;
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
