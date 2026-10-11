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
import type { Agent, ConnectOptions, Grant, GrantAccess, Invite, LinkKind, ListedFolder, Member, Note, NoteSummary, OpInput, Results, Role, Sharing, WorkspaceSummary } from "../core/protocol.ts";
import type { IconName } from "./icons.tsx";

/** The workspace operations and what they answer with: the same ones an agent has. */
export type * from "../core/protocol.ts";
export { DEFAULT_EXPIRY_DAYS, MAX_AGENT_NAME, MAX_EXPIRY_DAYS, MAX_SEARCH_LENGTH } from "../core/protocol.ts";

/** How a note writes a link to another note, which is the same for a plugin as for an agent. */
export { isNoteId, linksIn, linksOn, writtenLink, type WrittenLink } from "../core/links.ts";

/** How a note writes a todo and its options, read and rewritten by the functions the core indexes todos with. */
export { changeTodo, completeTodo, isDay, isProjectName, locateTodo, nameKey, parseTodo, rewriteTodo, tagsIn, tagsOn, todosIn, type Completed, type Importance, type LastDone, type NoteTodo, type Todo, type TodoChange } from "../core/todos.ts";

/** The lines of a note that aren't in a fenced code block, which is where the core reads todos and tags. */
export { linesOutsideCode } from "../core/lines.ts";

/** How a todo's `every:` token writes when it comes around again, read, written and said by the functions the core rolls a todo forward with. */
export { WEEKDAYS, describeRule, nextDue, parseRule, writeRule, type Rule, type Unit, type Weekday } from "../core/recurrence.ts";

/** The settings a daily note is made by, which the daily plugin declares under exactly these keys and the server reads. */
export { DAILY_SETTINGS } from "../core/daily.ts";

/** One time a recurring todo was checked off, as `todo.history` answers it. The protocol calls it `Completion`, which here is a list offered at the cursor. */
export type TodoCompletion = Results["todo.history"]["completions"][number];

export { dismissing, useDismiss } from "./dismiss.ts";
export { sandboxed } from "./htmlFrame.ts";
/** Whether an editor state is that of a reading of a note, where nothing is shown as written whatever is selected. */
export { isReading } from "./readOnly.ts";
export { TITLE_MARK } from "./titleMark.ts";
export { Icon, type IconName } from "./icons.tsx";
export { ago, dayOf, today, useNow } from "./time.ts";

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

/**
 * The operations `host.perform` won't take: the member's settings, every change to who is in the
 * workspace, which goes through `host.members`, who a note or folder is shared with, which goes
 * through `host.sharing`, and what a link's holder asks, which nobody signed in does.
 */
export type KeptFromPerform =
  | `settings.${string}`
  | `invite.${string}`
  | "member.invite"
  | "member.setRole"
  | "member.remove"
  | "member.leave"
  | `grant.${string}`
  | "note.setPrivate"
  | `shared.${string}`;

/** What a grant is on: one note or one folder. */
export type SharedItem = { noteId: string } | { folderId: string };

/** What a folder's list is called. Null for a folder that isn't there, or that the member can't see. */
export const folderTitle = (folders: Folders, folderId: string): string | null =>
  folderId === ALL_NOTES ? "All notes" : folderId === SHARED_WITH_ME ? "Shared with me" : (folders.byId.get(folderId)?.name ?? null);

/** What stands for a folder where the notes listed are the ones shared with a guest whose folders they can't see. */
export const SHARED_WITH_ME = "shared-with-me";

/** What stands for a folder where the notes listed are every note the member can see. */
export const ALL_NOTES = "all";

/**
 * What the editor area has in front, and what an address can name there: a note, or a folder's list
 * of notes. A folder's `id` is a folder's id, {@link ALL_NOTES} or {@link SHARED_WITH_ME}.
 */
export type Opened = { kind: "note"; id: string } | { kind: "folder"; id: string };

/** The operations a plugin can perform. */
export type PluginOp = Exclude<OpInput, { type: KeptFromPerform }>;

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
    /** Every embed from every plugin that is on, as a menu would offer them, so without those that say `menu: false`. */
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
  /** Calls `listener` each time the notes the member can see change: one made, renamed, moved, or changed by anyone. `app().notes` then holds them as they are. */
  onNotes(listener: () => void): Dispose;
  /** The app as it is now. A view is handed this as `app`; a command reads it when it runs. It isn't there yet during `activate`. */
  app(): App;
  /**
   * Performs a workspace operation as the member, with the member's access. Typing in open editors
   * is saved before an operation that moves a note through its history, and the editors take the result.
   * A settings operation is refused, and so is one that changes who is in the workspace or reads its invites,
   * and one that reads or changes who a note or folder is shared with.
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
  /**
   * Who is in the workspace, changed as the member. The server lets only an admin invite, set a role,
   * remove, and see or revoke invites, and lets anyone leave. Listing members is `perform`'s `member.list`.
   */
  readonly members: {
    invite(email: string, as: Role): Promise<Results["member.invite"]>;
    setRole(memberId: string, as: Role): Promise<Member>;
    remove(memberId: string): Promise<void>;
    /** Takes the member themself out of the workspace. */
    leave(): Promise<void>;
    invites(): Promise<Invite[]>;
    revoke(inviteId: string): Promise<void>;
  };
  /**
   * Who a note or a folder is shared with, read and changed as the member. The server lets a member
   * who can change the item share it, lets only a note's maker make it private, and lets only an
   * admin list every grant. A guest can ask `of` and nothing else.
   */
  readonly sharing: {
    /** How one note or folder is shared: its grants, those on the folders above it, and for a note whether it is private. */
    of(on: SharedItem): Promise<Sharing>;
    /** Gives whoever signs in with `email` view or edit, or changes what they have. */
    grant(on: SharedItem, email: string, access: GrantAccess): Promise<Grant>;
    /** Sets who the item's link opens for, or takes the link away with null. The address is `/s/<token>`. */
    link(on: SharedItem, kind: LinkKind | null): Promise<Grant | null>;
    revoke(grantId: string): Promise<void>;
    /** `removed` is how many grants and links other people had put on the note, which go as it becomes private. */
    setPrivate(noteId: string, isPrivate: boolean): Promise<{ removed: number }>;
    /** Every grant in the workspace, for an admin. */
    all(): Promise<Grant[]>;
  };
  /** JSON this plugin keeps in this browser for this workspace and this member. Other plugins can't see it. */
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
  /** A column left of the editor. In writing mode there is no room for it. */
  column: { id: string; component: View };
  /** A section of the sidebar, such as the folder tree. A column places them with `app.sections`; in writing mode they are in the left popover. */
  section: { id: string; component: View };
  /** An icon, or a few, in the left rail of writing mode. */
  rail: { id: string; component: View };
  /** What fills the editor area when a note, a folder's list, or nothing is open. The last one registered is used; with none, the app shows what the address names alone. */
  editor: {
    id: string;
    component: ComponentType<EditorProps>;
    /**
     * Asked to open a note or a folder's list, in place of the app going to it. Call `app.show` with
     * what ends up in front. With `background` it is opened without being put in front.
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
   * A page with its own address, shown in place of the editor. `nav` says where its link goes:
   * with the main links of the sidebar, under More, or in the workspace menu. Each page gets a
   * `go.<id>` command. `order` places its link among the others: lower first, and those with none
   * after them, in the order of their plugins. A page is also shown at every address under its
   * path, such as `/tags/work` for the page at `/tags`, unless another page is at exactly that address:
   * it reads the rest from `app.path`.
   */
  page: { id: string; path: `/${string}`; label: string; icon?: IconName; nav?: "primary" | "more" | "menu"; order?: number; component: View };
  /**
   * A widget in the bar along the bottom of the app, such as a running timer. The bar is one line of
   * small things to glance at. It is there in writing mode too, and keeps its height when a widget
   * has nothing to show, so nothing above it moves when one appears.
   */
  bar: { id: string; component: View };
  /**
   * A word or two about a note in the bar above its text, after its folder, in every editor showing
   * it: that it is archived, say, with a button that undoes it. The bar keeps its height, so the
   * note's text doesn't move when a mark comes or goes. One with nothing to say of a note draws nothing.
   */
  mark: { id: string; component: ComponentType<ViewProps & { note: NoteSummary }> };
  /**
   * A banner between a note's bar and its text, in every editor showing it, for what changes what
   * the member can do with the note: that it is in Trash. One with nothing to say of a note draws
   * nothing. When one appears the text moves down by the banner's height and no further.
   */
  notice: { id: string; component: ComponentType<ViewProps & { note: NoteSummary }> };
  /** Something drawn over the app, such as the command palette. One is open at a time; `app.toggleOverlay` opens it, and what it hands over is `state`. */
  overlay: { id: string; component: ComponentType<ViewProps & { close: () => void; state: unknown }> };
}

export interface FolderProps extends ViewProps {
  /** The folder whose notes to list: a folder's id, {@link ALL_NOTES} or {@link SHARED_WITH_ME}. It may name no folder the member can see. */
  folderId: string;
  /**
   * Draws a note's text to be read and not changed, as its editor draws it: the same embeds and the
   * same marks, at its full height with no scrolling of its own. The text is read when this is drawn.
   */
  readNote: (noteId: string) => ReactNode;
}

export interface EditorProps extends ViewProps {
  /**
   * Draws the editor for a note. `onEdit` is called on each change typed or pasted. `corner` is
   * for the editor at the right edge, which carries the buttons for the inspector and writing mode.
   */
  renderNote: (noteId: string, options?: { onEdit?: () => void; corner?: boolean }) => ReactNode;
  /** Draws a folder's list of notes, with whatever is in the `folder` slot. */
  renderFolder: (folderId: string) => ReactNode;
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
  /** False for one no menu writes: what it holds is picked somewhere else, as a reference to an event is copied from the Calendar page, or it is a way of writing that notes are no longer started with and is still drawn where a note has it. `host.embeds.list()` leaves it out. */
  menu?: boolean;
  /**
   * Draws into `el`, once, all of it before returning, so the embed is never seen half drawn. May
   * return a function that stops whatever it started, or a {@link Drawn}. An embed is registered
   * while its plugin starts, not later, so a note never shows it as written first.
   */
  render(el: HTMLElement, embed: Embedded): void | (() => void) | Drawn;
  /** What it keeps below the line that writes it, such as a video. */
  below?: Below;
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

/**
 * Something an embed keeps below its line: a video, a frame, a picture. It is there whether or not
 * the cursor is on the line, in room kept for it from the first moment, so nothing in the note moves
 * when it loads or when the cursor comes and goes. It is drawn once, the first time its room is on
 * screen, in an element that then stays the same element, never made again and never moved in the
 * page, for as long as the note says the same of the embed: through typing anywhere else, lines
 * added and removed, another member's changes, and scrolling it far out of sight. So a video keeps
 * playing while the note is written. Only a change to the embed's own config or body draws it again,
 * in the same element once that has been emptied.
 *
 * A frame drawn here can't take the keyboard from the member. Unless their pointer is on it, a frame
 * that focuses itself is stopped, and the member is told and can show it again.
 */
export interface Below {
  /**
   * The room to keep, from what the note says of the embed alone: as wide as the note's column up to
   * a limit and `ratio` times as wide as tall, or `height` pixels tall. Null for one with nothing to
   * show, such as a config that can't be read.
   */
  box(written: { config: string; body: string }): BelowBox | null;
  /**
   * Draws into `el`, which is as large as the room. May return a function that stops whatever it
   * started. `update` rewrites the embed in the note as {@link Embedded.update} does, which is how
   * what is only known once it has loaded, such as a picture's size, gets into the note for `box` to
   * read: the room is worked out from the note alone, and `render` can't change it any other way.
   */
  render(el: HTMLElement, embed: Pick<Embedded, "config" | "body" | "readOnly" | "update">): void | (() => void);
  /**
   * Whether a web address written alone on a line, with no embed's syntax around it, is this embed's
   * to show below that line, such as a video's address. It is then kept and drawn as if the note said
   * `::name{address}`, with the address as its config, and the line stays the link it is. `update`
   * does nothing for one: an address has no config to rewrite. The first embed to say so has it.
   */
  ofAddress?(address: string): boolean;
}

export type BelowBox = { ratio: number } | { height: number };

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
 * in a path or a date opens nothing. One with `anywhere` opens wherever its trigger is typed. Completions whose triggers both fit share one list, each
 * one's items in the order of their plugins.
 */
export interface Completion {
  id: string;
  /** What is typed to open it, such as `/`, `@`, or `[[`. */
  trigger: string;
  /** Whether what is typed after the trigger may hold spaces, as a note's title does. Without it a space closes the list. */
  spaces?: boolean;
  /** Whether the trigger opens the list anywhere outside code, such as right after a bracket or a word. For a trigger nobody types by accident, as `[[` is. */
  anywhere?: boolean;
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
  /**
   * True for a drawing of the note that is only read, such as an expanded card in a folder's list.
   * It may be there beside the note's editor, and there may be several, so whatever keeps the
   * note's editor by the note's id leaves a reading out.
   */
  reading?: boolean;
}

/** A workspace's folders, indexed for drawing the tree and naming a folder's path. */
export interface Folders {
  /** Null for a guest who wasn't given Unsorted. */
  unsortedId: string | null;
  byId: ReadonlyMap<string, ListedFolder>;
  /** Children in display order; at the top level, Unsorted comes first. */
  childrenOf(parentId: string | null): readonly ListedFolder[];
  /** The folder and its ancestors, outermost first. */
  pathOf(id: string): ListedFolder[];
  /** The names along `pathOf`, such as `Projects / Roadmap`. For null, the folder of a note whose folder the guest can't see, "Shared with me". */
  pathName(id: string | null): string;
}

/** Something the app tells the member in a line at its foot, which goes after a few seconds or when dismissed. */
export interface Notice {
  message: string;
  /** A button beside the message, such as Undo. The notice goes when it is pressed. */
  action?: { label: string; run: () => void };
}

export type PageInfo = Pick<Slots["page"], "id" | "path" | "label" | "icon" | "nav">;

/** The app at one moment: what is open, and what can be done about it. */
export interface App {
  me: { id: string; name: string; email: string };
  workspace: WorkspaceSummary;
  /** Every workspace the member is in. */
  workspaces: readonly WorkspaceSummary[];
  /**
   * Whether the member may change something in this workspace: a member who isn't a viewer, or a
   * guest. Whether they may change one note is that note's `access`.
   */
  canEdit: boolean;
  /** Whether `createNote` can make a note where it would put one. */
  canCreateNote: boolean;
  /** The address the app is at, such as `/history`. */
  path: string;
  /** The address's query as the browser has it, such as `?q=plan`, or empty. A page reads it with `URLSearchParams`. */
  query: string;
  /** What `go` was handed for this address, if anything. It is handed over once: Back or a reload finds nothing. */
  pageState: unknown;
  /** What the address names in the editor area: the note or the folder's list in front. Null on a page, and when nothing is open. */
  opened: Opened | null;
  /** The note the address names. Null on a page, on a folder's list, and when nothing is open. */
  noteId: string | null;
  /** That note, once the workspace's notes have loaded and if the member can see it. It may be archived, or in Trash. */
  note: NoteSummary | null;
  /** Whether the open note has changes by someone else that the member hasn't been shown. */
  unseen: boolean;
  /**
   * Every note in the workspace the member can see that isn't in Trash: the live ones and the
   * archived ones, told apart by `state`. A listing leaves the archived ones out unless the member
   * asked for them. Null while they load.
   */
  notes: readonly NoteSummary[] | null;
  /** The notes in Trash that the member can see. No listing but Trash's own shows them; they are here so a tab or a link can say what one is. */
  trashed: readonly NoteSummary[];
  /** Null while they load. */
  folders: Folders | null;
  /**
   * The folder in front: the one whose list the address names, {@link ALL_NOTES} and
   * {@link SHARED_WITH_ME} among them, or the folder of the note it names. Null on a page, and when
   * nothing is open. The folder tree marks it.
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

  /** Goes to an address, which may carry a query. `state` is for the page there, which reads it as `pageState`. `replace` keeps Back from retracing the step. */
  go(path: string, options?: { state?: unknown; replace?: boolean }): void;
  /** Where a note lives, such as `/note/plan-3k2j5h8d9f0a`. */
  notePath(noteId: string): string;
  /**
   * Opens a note. A preview gives way to the next thing previewed, and takes the place of the one there, unless that is the folder's list in front: a list a note is previewed from is kept. `focus` puts the cursor in its
   * editor. `background` opens it in a tab of its own, which is kept, without leaving what is in
   * front. Where the editor area has no tabs the note is opened as it otherwise would be.
   */
  openNote(noteId: string, options?: { preview?: boolean; focus?: boolean; background?: boolean }): void;
  /** Opens a folder's list of notes: a folder's id, {@link ALL_NOTES} or {@link SHARED_WITH_ME}. A preview, which it is unless said, takes the place of the preview there, a note's or a folder's. */
  openFolder(folderId: string, options?: { preview?: boolean }): void;
  /** Where a folder's list lives, such as `/folder/all`. */
  folderPath(folderId: string): string;
  /** For the editor area: puts a note or a folder's list at the app's address, or nothing. `replace` keeps Back from retracing the step. */
  show(tab: Opened | null, options?: { replace?: boolean }): void;
  /**
   * Creates a note and opens it. It goes in `folderId` when that is a folder; otherwise in the
   * folder in front, which is the open note's folder when a note is in front; otherwise in Unsorted.
   * Refused with the server's reason where the member can't.
   */
  createNote(folderId?: string): Promise<void>;
  moveNote(noteId: string, folderId: string): Promise<void>;
  /** Tells the app a note changed, with the note as it is now: its text, its folder, or its state. */
  noteChanged(note: Note): void;
  /** Reads the folders and notes again, after a change the app wasn't told about. */
  refresh(): void;
  /** Sends what is typed in a note's editor now, without waiting for a pause in the typing. For a change that must reach the server as it is, before anything else is typed. */
  saveNote(noteId: string): void;
  /** Records that the member was shown a note's changes up to a revision. */
  markSeen(noteId: string, revision: number): void;
  /** Tells the member something that just happened, such as that a note was moved to Trash. One notice shows at a time: the next takes its place. */
  notify(notice: Notice): void;
  /** Opens an overlay, or closes it when it is the one open. `state` is for the overlay, which is handed it. */
  toggleOverlay(id: string, state?: unknown): void;
  switchWorkspace(workspaceId: string): void;
  /** Reads again which workspaces the member is in and their role in each, after a change to members that may be to the member themself. */
  reloadWorkspaces(): void;
  signOut(): void;
}
