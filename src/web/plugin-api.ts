/**
 * The plugin API. A plugin is a value with an id, a name, and an `activate` function, which is
 * handed a {@link PluginHost} and uses it to add commands, views, embeds, completions, and editor extensions.
 *
 * Everything a plugin can do comes through the host it is handed. A plugin imports this module
 * and nothing else from the app. The built-in plugins in `plugins/` follow the same rule, which
 * `test/core/plugin-boundary.test.ts` checks.
 *
 * A plugin declares its options as `settings` and reads them through its host. It cannot change
 * them, other than one it declares `remembered`, or read anyone else's: settings are the member's.
 */
import type { ComponentType, ReactNode } from "react";
import type { Agent, AgentEdit, ConnectOptions, Grant, GrantAccess, Invite, LinkKind, ListedFolder, Member, Note, NoteSummary, OpInput, ReferredUpload, Results, Role, Sharing, Upload, WorkspaceSummary, Written } from "../core/protocol.ts";
import type { DeclaredOption, Swatch } from "../core/embedOptions.ts";
import type { IconName } from "./icons.tsx";
import type { Showing } from "./inspected.ts";
import type { UploadKind } from "../core/filetypes.ts";

/** The workspace operations and what they answer with: the same ones an agent has. */
export type * from "../core/protocol.ts";
export { CONTACT_LABELS, DEFAULT_EXPIRY_DAYS, labelType, MAX_AGENT_NAME, MAX_EXPIRY_DAYS, MAX_FOLDER_DESCRIPTION, MAX_NOTE_LENGTH, MAX_NOTES_AT_ONCE, MAX_SEARCH_LENGTH, MAX_TAG_DESCRIPTION, MAX_UPLOAD_BYTES, MAX_VOCABULARY, TODO_SORT_WORDS, PART_BYTES } from "../core/protocol.ts";
/**
 * The query language notes and todos are found by, as the server reads it: what is typed to a query
 * and back, every filter there is with what it takes and means, and what is being typed at the
 * cursor. A bar that takes a query, a builder of one and the help are all made from these.
 */
export {
  EMPTY as EMPTY_QUERY,
  FILTERS,
  PRIORITIES,
  fieldMeans,
  fieldName,
  fieldOf,
  fieldsOf,
  filterOf,
  keyNamed,
  keyOf,
  keysFor,
  keysStarting,
  names as queryNames,
  parse as parseQuery,
  print as printQuery,
  soughtIn,
  syntax as querySyntax,
  typingAt,
  wordsFor,
  wordsIn,
  wordsOf,
  written as writtenValue,
  type Cmp,
  type Field as QueryField,
  type Filter as QueryFilter,
  type FilterKey,
  type In as QueryIn,
  type Key as QueryKey,
  type Node as QueryNode,
  type Query,
  type QueryError,
  type Scope as QueryScope,
  type SortKey,
  type SyntaxRow,
} from "../core/query.ts";
/** Where two lists of lines differ, for a view that marks what changed inside a line. */
export { lineHunks } from "../core/text.ts";
/** Every row of a list that pages, a page at a time. */
export { allPages } from "../core/allPages.ts";
/** Who wrote each line, moved over an edit as the note's history moves it: for a view that marks lines by the change that last wrote them, as `note.blame` answers. */
export { reline } from "../core/blame.ts";

/** How a note writes a link to another note, which is the same for a plugin as for an agent. */
export { isNoteId, linkedEvent, linkedFolder, linksIn, linksOn, writtenFolderLink, writtenLink, type WrittenLink } from "../core/links.ts";
export { dayLinksOn, linkedDay, writtenDayLink, type DayLink, type LinkedDay } from "../core/dateLinks.ts";

/** How a note writes a mention of a person, which is the same for a plugin as for an agent. */
export { isPersonId, mentionKey, mentionName, mentionsIn, mentionsOn, readableName, writtenMention, type WrittenMention } from "../core/mentions.ts";

/** How a note refers to an upload, which is the same for a plugin as for an agent, and what kind of file an upload is. */
export { SIZE_SHARE, SIZE_WORDS, UPLOAD_EMBEDS, cropIn, shareIn, sizeIn, uploadIn, withCrop, withShare, withUpload, writtenUpload, type Crop, type SizeWord, type UploadEmbed } from "../core/uploadRefs.ts";
export { FILE_CLASSES, TEXT_ENDINGS, fileClass, type FileClass, type UploadKind } from "../core/filetypes.ts";

/** How a note writes a todo and its options, read and rewritten by the functions the core indexes todos with. */
export { BOX_PATTERN, TODO_STATES, changeTodo, completeTodo, skipTodo, isDay, isTagName, locateTodo, markOf, nameKey, parseTodo, rewriteTodo, tagsIn, tagsOn, todosIn, type Completed, type Importance, type LastDone, type NoteTodo, type Todo, type TodoChange, type TodoState } from "../core/todos.ts";

/** The lines of a note that aren't in a fenced code block, which is where the core reads todos and tags. */
export { linesOutsideCode } from "../core/lines.ts";

/** How a todo's `every:` token writes when it comes around again, read, written and said by the functions the core rolls a todo forward with. */
export { DAY_NAMES, MONTHS, MONTH_NAMES, WEEKDAYS, counted, describeRule, endLabel, isInterval, nextDue, occurrences, ordinal, parseRule, pastThe28th, ruleLabel, skippedTo, writeRule, type End, type Rule, type Unit, type Weekday } from "../core/recurrence.ts";

/** The settings a daily note is made by, which the daily plugin declares under exactly these keys and the server reads. */
export { DAILY_FOLDER, DAILY_SETTINGS } from "../core/daily.ts";

/** One time a recurring todo was checked off, as `todo.history` answers it. The protocol calls it `Completion`, which here is a list offered at the cursor. */
export type TodoCompletion = Results["todo.history"]["completions"][number];

export { dismissing, useDismiss } from "./dismiss.ts";
export { sandboxed } from "./htmlFrame.ts";
export { askSite } from "./otherSites.ts";
/** The theme the app is drawn in, for what is drawn by someone else and has to be asked for in one: another site's frame. */
export { onTheme, themeNow, type Theme } from "./theme.ts";
/** Whether an editor state is that of a reading of a note, where nothing is shown as written whatever is selected. */
export { isReading } from "./readOnly.ts";
export { ResizeHandle } from "./resize.tsx";
export { Icon, type IconName } from "./icons.tsx";
/** Help shown over the page, such as the query syntax or the keyboard shortcuts: one look for every help there is. */
export { HelpOverlay } from "./HelpOverlay.tsx";
export { ago, dayOf, today, useNow } from "./time.ts";
/** A note's text and selection as its editor has them now, for a view that says something of the note in front. */
export { useOpenNote, type OpenNote } from "./openNotes.ts";
/**
 * A CodeMirror effect that says the cursor jumped within a note, as vim's G or a search sends it:
 * `{ from, to }` as offsets. Put on a transaction of its own after the move, it makes a stop in the
 * app's history, so Go back comes back to `from` before it leaves the note.
 */
export { noteJump } from "./openNotes.ts";
/** A CodeMirror annotation on the change an editor takes from the member's own undo or redo through the note's history, which comes back a moment after the key. */
export { historyStepped } from "./openNotes.ts";
/** A CodeMirror facet of what vim's `gd` follows at the cursor: an editor extension gives one that does what a click on its kind of thing does, and answers whether the cursor was on one. */
export { following } from "./following.ts";

/**
 * Dragging to the editor area. `draggableAs(what)` is the props that make an element drag a note, a
 * folder's list, a page or a new note there, spread on it as `{...draggableAs(what)}`. `carried`
 * reads what was dragged back where it is dropped, and `carriesTab` says while it is over something
 * whether it has one. A note is carried under `NOTE_DRAG` as its id, so it also drops wherever a note does.
 */
export { NOTE_DRAG, carried, carriesTab, draggableAs, linkIn, type Dragged } from "./dragged.ts";

/** What going to an address of the app's opens in a tab, as a link to it does, from the pages there are. Null where no tab is. */
export { openedAt } from "./router.ts";

/** What a plugin can't do without: a keyboard with keys, or more room than a phone's width. */
export type Need = "keyboard" | "room";

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
   * What the plugin can't do without. On a device that lacks it the plugin is off, and its switch
   * stays as the member set it: `keyboard` is a keyboard with keys, which a touch screen has only
   * once one is attached; `room` is more than a phone has.
   */
  needs?: Need;
  /**
   * Called when the plugin is turned on. Everything it registers here is taken back out when it is
   * turned off. A plugin that starts anything else, such as a timer or a listener, returns a
   * function that stops it.
   */
  activate(host: PluginHost): void | Dispose;
  /** False for a plugin that is off until the member turns it on. */
  enabledByDefault?: boolean;
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
export type Setting = {
  title: string;
  description?: string;
  /**
   * Set for an option the plugin remembers from what the member does in its own views, such as which
   * calendars the Calendar shows or the order the Todos page is sorted in, so it is kept on the server with the member's settings and not in one browser. The
   * plugin may change it with `host.settings.set`; it can change no other, and the member can reset it.
   */
  remembered?: true;
} & (
  | { type: "boolean"; default: boolean }
  /**
   * `unreadable` is what it reads as when the member's value isn't one it can take, if that is not the default: the safe choice, for a
   * setting that guards something. `defaultWithoutEmbedSite` is its default instead on a server whose HTML embeds have no host of
   * their own (`EMBED_ORIGIN`), as the server says: the safe choice there.
   */
  | { type: "string"; default: string; enum?: readonly string[]; maxLength?: number; unreadable?: string; defaultWithoutEmbedSite?: string }
  /**
   * `follows` names another setting, by its key and title, whose value this one is until the member sets it, as the editor's text size is the
   * app's: so a value the same as `default` is the member's choice and is kept.
   */
  | { type: "number" | "integer"; default: number; minimum?: number; maximum?: number; follows?: { key: string; title: string } }
  /** Chords such as `mod+shift+p`, which is what a keybinding holds. */
  | { type: "chords"; default: readonly string[] }
  /** Words, each at most `maxLength` characters, at most `maxItems` of them. */
  | { type: "list"; default: readonly string[]; maxItems: number; maxLength: number }
  /**
   * A folder the member can edit, by its id, picked from a list of them. `""` is the default, the
   * folder `defaultFolder` names, which whoever reads the setting finds or makes.
   */
  | { type: "folder"; default: ""; defaultFolder: string }
);

export type SettingValue = boolean | string | number | readonly string[];

/**
 * The operations `host.perform` won't take: the member's settings, every change to who is in the
 * workspace, which goes through `host.members`, who a note, folder or upload is shared with, which
 * goes through `host.sharing`, an upload's bytes, which go through `host.uploads`, what a link's
 * holder asks, which nobody signed in does, every change to which plugins a workspace has and
 * what they are permitted, which is the Plugins page's and no plugin's, and deleting an account or
 * a workspace, which only the person does.
 */
export type KeptFromPerform =
  | `settings.${string}`
  | `invite.${string}`
  | "member.invite"
  | "member.setRole"
  | "member.remove"
  | "member.leave"
  | "member.signOut"
  | `account.${string}`
  | "workspace.delete"
  | `grant.${string}`
  | "note.setPrivate"
  | "upload.setPrivate"
  | "upload.create"
  | "upload.open"
  | "upload.start"
  | "upload.resume"
  | "upload.part"
  | "upload.finish"
  | "upload.abort"
  | `shared.${string}`
  | "plugin.install"
  | "plugin.uninstall"
  | "plugin.permit"
  | "plugin.request"
  | "plugin.read"
  | "agentsFile.write";

/**
 * The operations `host.perform` takes only from Common Ink's own plugins: everything of the
 * member's data sources, which are theirs and nobody else's, and everything of the workspace's
 * uploads, and what the member keeps for their own dashboard: their pins, and how far they have read
 * the changes. A plugin that isn't Common Ink's own is refused them, and so can't copy a member's
 * contacts or calendar into a note or a frame, list, move or remove a file, or mark as read what
 * the member hasn't seen. The workspace's record of its plugins is theirs alone too: `plugin.list`,
 * and `plugin.frame`, which opens a frame that may reach the network.
 */
export type OwnOnly = `source.${string}` | `event.${string}` | `contact.${string}` | `email.${string}` | `record.${string}` | `upload.${string}` | `pin.${string}` | `visit.${string}` | `plugin.${string}`;

/** What a grant is on: one note, one folder or one upload. An upload has no link of its own. */
export type SharedItem = { noteId: string } | { folderId: string } | { uploadId: string };

/** What a folder's list is called. Null for a folder that isn't there, or that the member can't see. */
export const folderTitle = (folders: Folders, folderId: string): string | null =>
  folderId === ALL_NOTES ? "All notes" : folderId === SHARED_WITH_ME ? "Shared with me" : (folders.byId.get(folderId)?.name ?? null);

/** What is told of an upload a note refers to. Null for one that isn't there or that the reader can't see: nothing tells the two apart. */
export type ReferredTo = ReferredUpload["upload"];

/** What stands for a folder where the notes listed are the ones shared with a guest whose folders they can't see. */
export const SHARED_WITH_ME = "shared-with-me";

/** What stands for a folder where the notes listed are every note the member can see. */
export const ALL_NOTES = "all";

/**
 * What the editor area has in front, and what an address can name there: a note, a folder's list
 * of notes, or a page. A folder's `id` is a folder's id, {@link ALL_NOTES} or {@link SHARED_WITH_ME}.
 * A page's `id` is the id it was registered with, and `path` is the address it is at:
 * `/plugins/tabs` for the page at `/plugins`. Wherever under its path a page is, it is the same page.
 */
export type Opened = { kind: "note"; id: string } | { kind: "folder"; id: string } | { kind: "page"; id: string; path: string };

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
    /** Every view in the slot, from every plugin that is on. */
    in<S extends keyof Slots>(slot: S): readonly Slots[S][];
  };
  readonly embeds: {
    register(embed: Embed | AddressEmbed): Dispose;
    /** Every embed from every plugin that is on, as a menu would offer them. An {@link AddressEmbed} is not among them: nothing writes one but its address. */
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
  /** Calls `listener` each time the notes the member can see change: one made, renamed, moved, or changed by anyone, and each time the folders do. `app().notes` and `app().folders` then hold them as they are. */
  onItems(listener: () => void): Dispose;
  /** The app as it is now. A view is handed this as `app`; a command reads it when it runs. It isn't there yet during `activate`. */
  app(): App;
  /**
   * Performs a workspace operation as the member, with the member's access. Typing in open editors
   * is saved before an operation that moves a note through its history or previews that, and the editors take the result.
   * A settings operation is refused, and so is one that changes who is in the workspace or reads its invites,
   * one that reads or changes who a note, folder or upload is shared with, and one that sends or opens
   * an upload's bytes. A plugin that isn't Common Ink's own is also refused each {@link OwnOnly} operation.
   */
  perform<T extends PluginOp>(op: T): Promise<Results[T["type"]]>;
  /** This plugin's own options, as the member set them or as they default. Only one declared `remembered` can be changed. */
  readonly settings: {
    /** The option declared under `name` in the plugin's `settings`. A value the member got wrong reads as the default. */
    get<T extends SettingValue = SettingValue>(name: string): T;
    /**
     * Changes an option the plugin declared `remembered`, for the member, wherever they sign in. Any
     * other throws. False when it wasn't changed: the member's settings aren't read yet, or the value
     * isn't one the option takes.
     */
    set(name: string, value: SettingValue): boolean;
    /** Calls `listener` when the member's settings change. A view is drawn again without asking. */
    subscribe(listener: () => void): Dispose;
  };
  /** The member's agents. The token in `connect`'s answer is the only time it can be seen. */
  readonly agents: {
    list(): Promise<Agent[]>;
    connect(name: string, options: ConnectOptions): Promise<{ agent: Agent; token: string }>;
    /** Changes what an agent may do. Its token stays the one it has. */
    edit(id: string, edit: AgentEdit): Promise<Agent>;
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
    /** Signs a member out of every browser they are signed in on, and the member themself when it is their id. With `agents`, disconnects their agents too. */
    signOut(memberId: string, agents: boolean): Promise<void>;
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
    /** Gives whoever signs in with an email view or edit, or changes what they have. A member can be named by their id instead, since only an admin is told a member's email. */
    grant(on: SharedItem, to: string | { memberId: string }, access: GrantAccess): Promise<Grant>;
    /** Sets who the item's link opens for, or takes the link away with null. The address is `/s/<token>`. */
    link(on: SharedItem, kind: LinkKind | null): Promise<Grant | null>;
    revoke(grantId: string): Promise<void>;
    /** Makes a note private, by its id, or an upload. `removed` is how many grants and links other people had put on it, which go as it becomes private. */
    setPrivate(on: string | { uploadId: string }, isPrivate: boolean): Promise<{ removed: number }>;
    /** Every grant in the workspace, for an admin. */
    all(): Promise<Grant[]>;
  };
  /**
   * The workspace's uploads as the notes on screen refer to them, and their bytes. Only Common Ink's
   * own plugins are given it: for any other, nothing is known of any upload, there is no address,
   * and nothing is sent. Listing, moving and removing uploads are `perform`'s `upload.*` operations.
   */
  readonly uploads: {
    /**
     * What the app was last told of an upload: by the read of a note that refers to it, or by
     * `learn`. Null for one that isn't there or that the member can't see, and undefined for one
     * nothing has been said of yet.
     */
    referred(id: string): ReferredTo | undefined;
    /** Calls `listener` when what `referred` answers has changed for any upload. */
    onReferred(listener: () => void): Dispose;
    /** Tells the app what an upload is now, after an operation that made, changed or removed it, so every note that shows it follows. */
    learn(uploads: readonly ReferredUpload[]): void;
    /** Where an upload's bytes are asked for, as the source of a picture, a video or a download. It is good only for whoever is looking: the member's session, or on a link's page the link. */
    address(id: string): string;
    /**
     * Where an upload is opened in a tab of its own: the app's address for it, which sends a PDF on to
     * the site kept for files. Null where there is no such site, or on a link's page, where a PDF is
     * downloaded instead.
     */
    tabAddress(id: string): string | null;
    /**
     * The first `upTo` bytes of an upload, or all of them for a shorter one, asked for where `address`
     * says and answered the same way: for whoever is looking. It rejects with the server's refusal,
     * `not_found` for one that isn't there or that they can't see.
     */
    bytes(id: string, upTo: number): Promise<Uint8Array>;
    /**
     * Sends a file to the workspace as the member, up to 25 GB. `folderId` left out puts it in
     * Unsorted. `onProgress` is told how many bytes have gone. A file over 8 MB goes in parts, which
     * pick up where they stopped when the connection drops, and `onStarted` is told its id and the kind
     * its name says it is as soon as it has them, while it is still on its way and seen by no one. The
     * server's refusal is what it throws.
     */
    send(file: Blob, as: { name: string; folderId?: string; private?: boolean }, onProgress?: (sent: number) => void, onStarted?: (sending: { id: string; kind: UploadKind }) => void): Promise<Upload>;
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
  /**
   * A plugin frame gives this chord back to the app. `when` is about a field of the app, and a frame is
   * neither that nor a list, so without this the frame would keep the chord. Set it for a chord that
   * leaves the frame, such as going back.
   */
  escapesFrames?: boolean;
  /** A text field has its own answer to this command, so its keys are left to a field that has focus. */
  leaveToFields?: boolean;
  /**
   * The heading the keyboard shortcuts list it under: by convention one of `Navigation`, `Notes`,
   * `Editor`, or a plugin's own, as vim's are under `Vim`. One with none is under Other.
   */
  group?: string;
  /** Other names the command palette finds it by, such as what it was called before. Its title is what is shown. */
  aliases?: readonly string[];
}

export interface CommandInfo {
  id: string;
  title: string;
  /** The first chord that runs it now, as a person reads it, such as `⇧⌘P`. */
  shortcut: string | undefined;
  /** Every chord that runs it now, as a person reads them: its own, or the member's in their place. */
  keys: readonly string[];
  group: string | undefined;
  aliases?: readonly string[];
}

/** What a view is drawn with. */
export interface ViewProps {
  app: App;
}

export type View = ComponentType<ViewProps>;

/** The places a view can go. Views in a slot are drawn in the order of the plugins that added them. */
export interface Slots {
  /**
   * A column left of the editor: the sidebar. It is drawn closed too, when `app.sidebarOpen` is
   * false, and is then to be a narrow bar of icons (`<nav class="rail">`) for what it lists when
   * open. Its edge is the member's way back to open, and `app.toggleSidebar` is the view's own.
   * In focus it is still drawn, out of sight.
   */
  column: { id: string; component: View };
  /**
   * A section of the sidebar, such as the folder tree. A column places them with `app.sections` while it is open, and may show one
   * over the page from its bar with `app.sectionsOpening`. `label` and `icon` are what stands for it there: one with both is in
   * `app.sectionNames`.
   */
  section: { id: string; component: View; label?: string; icon?: IconName };
  /** What fills the editor area when a note, a folder's list, a page, or nothing is open. The last one registered is used; with none, the app shows what the address names alone. */
  editor: {
    id: string;
    component: ComponentType<EditorProps>;
    /**
     * Asked to open a note, a folder's list or a page, in place of the app going to it. Call
     * `app.show` with what ends up in front. With `background` it is opened without being put in front.
     * With `here`, as from `app.openNote`, a note open in another pane opens in the one in front too,
     * and isn't gone to there, as going to an address, Back among them, does.
     */
    open?: (tab: Opened, options: { preview: boolean; background?: boolean; here?: boolean }) => void;
    /**
     * What it has in front whatever the address says, such as the tab that was last in front, or null
     * with nothing open. The app asks it at an address that names no page, to know a tab kept on a
     * page that has gone since. At `/` the editor area itself goes to it, and with nothing to go to
     * opens the `home` page, as the Tabs plugin does in a tab.
     */
    returnsTo?: () => Opened | null;
    /**
     * Asked to open a note, a folder's list or a page in a part of the editor area of its own,
     * right of or under what is in front, and to keep it there. An editor area that has this is
     * what `app.openBeside` goes to, and what makes a page's link and a folder's row in the sidebar
     * offer "Open in a split".
     */
    split?: (tab: Opened, side: "right" | "down") => void;
    /** Asked to open a note, a folder's list or a page to the side, for `app.openToSide`. With `stay` the pane in front stays so. */
    aside?: (tab: Opened, options: { preview: boolean; stay: boolean }) => void;
    /** Every tab open, pane by pane in reading order and each pane's left to right, for `app.openTabs`. */
    tabs?: () => readonly OpenTab[];
  };
  /**
   * A folder's list of notes, drawn in the editor area where a folder is open. The last one
   * registered is used; with none, the app lists the folder's notes by title.
   */
  folder: { id: string; component: ComponentType<FolderProps> };
  /**
   * A panel of the inspector. The inspector has a narrow bar of icons at the right of the window,
   * one for each view, which is the same whatever the editor area has in front. An icon shows its
   * panel over the page until the member goes elsewhere, or beside the page once they pin it; the
   * app keeps which panel, and whether it is pinned, as the member last had them. A panel is about
   * what is in front ({@link About}): the view says which kinds of thing it has something to show
   * `for`, and its component is handed the thing. For any other kind, and for a page that says
   * nothing of what it shows, the inspector says "Nothing to show for this view" in the panel's
   * place. Each view gets an `inspector.<id>` command that does what its icon does.
   */
  inspector: InspectorView;
  /**
   * A page with its own address, shown in the editor area as a note is: in a tab, where the editor
   * area has tabs. A page does nothing for that. It is drawn with an `app` whose `path` and
   * `pageState` are its own, so two pages open side by side each read their own address, and
   * `app.go` to an address under its path moves that page and no other. `nav` says where its link goes:
   * with the main links of the sidebar, under More, or in the workspace menu. Each page gets a
   * `go.<id>` command titled Go to its label.
   * A page of the app's own may name its `command` instead, to keep an id a member's keys may be bound to. `order` places its link among the others: lower first, and those with none
   * after them, in the order of their plugins. A page is also shown at every address under its
   * path, such as `/plugins/tabs` for the page at `/plugins`, unless another page is at exactly that address:
   * it reads the rest from `app.path`. One that is `transient` only leads somewhere else, as Today
   * leads to the day's note with `app.show`: it is never a tab, and is drawn in place of the editor
   * area for the moment it takes to find where to go, with the editor area kept as it is underneath.
   * Given as the function that finds where it leads, its link dragged to the editor area opens that
   * place where it is dropped; given as `true`, its link isn't dragged.
   * One with `home` is where the app goes from `/` when the editor area has nothing to return to: it is opened as any page is, a tab where there are tabs.
   * A page is one tab wherever under its path it is, unless it has `tabAt`: then the addresses under
   * its path are tabs of their own, one for each `key` that `tabAt` gives an address (its path, without
   * the query), called its `title`. Each tag's page is "#name" beside the others and the page of every
   * tag, its key the tag's name in lower case, so `/tags/Garden` and `/tags/garden` are one tab.
   * `description` says what the page is for, in a sentence, on the card its link shows; one left
   * out is its plugin's description.
   */
  page: { id: string; path: `/${string}`; label: string; description?: string; icon?: IconName; nav?: "primary" | "more" | "menu"; order?: number; transient?: true | (() => Promise<Opened>); home?: boolean; tabAt?: (path: string) => { key: string; title: string }; command?: { id: string; title: string }; component: View };
  /**
   * A panel on the Dashboard. It is listed in Add panel and drawn in a card once the member adds it.
   * The member's arrangement still decides whether it is shown, as it does for the Dashboard's own panels.
   */
  dashboard: { id: string; label: string; component: View };
  /**
   * An item in the bottom bar: one thin line along the foot of the window for small things to
   * glance at, such as a count of the open note's words. `side` is the end it sits at, the left
   * unless said, and `order` places it among the others at that end, lowest first and 0 unless
   * said. Items of one order stay in the order of the plugins that added them. A component with
   * nothing to say draws nothing, and takes no room. The bar is there while any plugin has an item
   * in it, with something to say or not, so nothing above it moves as items come and go. In focus
   * it is out of sight, and an item that is `live`, such as a running timer, is drawn at the foot of
   * the note instead, beside vim's mode and whether the note is saved: only what changes as it is
   * watched belongs there, not a count.
   */
  bar: { id: string; component: View; side?: "left" | "right"; order?: number; live?: true };
  /**
   * A word or two about a note in a quiet line under its title, in every editor showing it: that it
   * is archived, say, with a button that undoes it. The line takes no room while no mark has anything
   * to say, and the text under the title moves down by its height when one does.
   */
  mark: { id: string; component: ComponentType<ViewProps & { note: NoteSummary }> };
  /**
   * A quiet button at an open note's top right, before Focus, in every editor group showing the note
   * in front: Archive, and the note's "…" menu. `order` places it among the others, lowest first and
   * 0 unless said. One with nothing to offer for a note draws nothing.
   */
  tool: { id: string; order?: number; component: ComponentType<ViewProps & { note: NoteSummary }> };
  /**
   * A banner above a note's text, in every editor showing it, for what changes what
   * the member can do with the note: that it is in Trash. One with nothing to say of a note draws
   * nothing. When one appears the text moves down by the banner's height and no further.
   */
  notice: { id: string; component: ComponentType<ViewProps & { note: NoteSummary }> };
  /** Something drawn over the app, such as the command palette. One is open at a time; `app.toggleOverlay` opens it, and what it hands over is `state`. */
  overlay: { id: string; component: ComponentType<ViewProps & { close: () => void; state: unknown }> };
  /**
   * A section of Settings that holds no setting, such as the Tags plugin's list of every tag to
   * describe and rename: listed among the app's own sections under `label`, at `/settings/<id>`,
   * and drawn under that heading. A search of the settings never finds it.
   */
  settings: { id: string; label: string; component: View };
}

/**
 * What the inspector is about: what the editor area has in front. A note; a folder's list, where
 * `folderId` is a folder's id or {@link ALL_NOTES}, `name` is what the list is called and `notes`
 * are the live notes in it, as its list counts them, none archived or in Trash; or the notes a page
 * says it is showing, under the name the page gave them.
 */
export type About =
  | { kind: "note"; note: NoteSummary }
  | { kind: "folder"; folderId: string; name: string; notes: readonly NoteSummary[] }
  | { kind: "notes"; label: string; notes: readonly NoteSummary[] };

export interface InspectorView {
  id: string;
  label: string;
  icon: IconName;
  /** The kinds of thing it has something to show for. With any other in front the inspector says there is nothing to show, and the component is not drawn. */
  for: readonly About["kind"][];
  component: ComponentType<ViewProps & { about: About }>;
  /** Something to flag on its icon in the bar, by a dot and these words for a screen reader, or null. */
  badge?: (app: App) => string | null;
}

/**
 * How a page says what it is showing, so the inspector's panels are about that while the page is
 * in front: `useInspected(app, { kind: "notes", label: "Open todos", noteIds })`, or a single
 * note with `{ kind: "note", noteId }`, or null while it has nothing to say. Notes the member
 * can't see are left out.
 */
export { useInspected, type Showing } from "./inspected.ts";

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
   * Draws the editor for a note. `onEdit` is called on each change typed or pasted. With `focus`
   * the editor takes the cursor once the note is there, and then calls `onFocused`: for a note the
   * view moved to another part of itself, where its editor is drawn anew. With `behind`, it is one of
   * several editors of the note and not the one in front, so a note opened to take the cursor leaves it alone.
   */
  renderNote: (noteId: string, options?: { onEdit?: () => void; focus?: boolean; onFocused?: () => void; behind?: boolean }) => ReactNode;
  /** Draws a folder's list of notes, with whatever is in the `folder` slot. */
  renderFolder: (folderId: string) => ReactNode;
  /** Draws an open note's own buttons for its group's tab row, before Focus: the `tool` slot's. Nothing for a note not known yet. */
  renderNoteTools: (noteId: string) => ReactNode;
  /** Draws a page at the address it is at, which is {@link Opened}'s `path`. One no plugin has registered any more is drawn as nothing being there. */
  renderPage: (pageId: string, path: string) => ReactNode;
  /** What to show where nothing is open: a line saying to pick a note. */
  empty: ReactNode;
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
  /** What a new one is written with when it is picked from the insert menu. With none, an empty config and an empty body. */
  starts?: { config?: string; body?: string };
  /** What the insert menu says it makes, in a line of words: never its syntax. With none the menu shows its title alone. */
  description?: string;
  /** What the insert menu shows beside it while it is highlighted, such as a small picture of it drawn in a note. */
  preview?: CompletionPreview;
  /**
   * For an embed a menu can't write, because what it holds is made by doing something: an upload's
   * is made by sending a file, or by choosing one already sent. A menu offers each under its title,
   * after the embeds it writes, in the order given, and picking one writes what its `insert` answers.
   */
  pick?: EmbedPick | readonly EmbedPick[];
  /**
   * False for an embed no menu lists by itself: one another embed's `pick` writes, as "Upload an
   * image" writes a picture, or one written another way, as `@` writes a reference to a contact.
   * `host.embeds.list()` leaves it out.
   */
  menu?: boolean;
  /**
   * Draws into `el`, once, all of it before returning, so the embed is never seen half drawn. May
   * return a function that stops whatever it started, or a {@link Drawn}. An embed is registered
   * while its plugin starts, not later, so a note never shows it as written first.
   *
   * An embed that is all below its line, as an uploaded picture is, has none: its line shows nothing
   * of it while the cursor is elsewhere, and its text where it is written while the cursor is on it.
   * A line that is such an embed and nothing else takes no room while the cursor is elsewhere. One
   * whose `below` keeps no room is shown as written. One whose `below` is `alone` has both: what
   * `render` draws among words, and what `below` keeps on a line of its own.
   */
  render?(el: HTMLElement, embed: Embedded): void | (() => void) | Drawn;
  /** What it keeps below the line that writes it, such as a video. */
  below?: Below;
  /**
   * What a member can adjust about it without reading its config. The host draws one settings button
   * in the embed's card, and opens beneath the card a field for each key of a built-in embed's
   * schema (`src/core/embedSchema.ts`) and then one for each of these. An embed that has none, or
   * gives none for what the note says of it now, has no button, and neither has a member who can't
   * change the note.
   *
   * Declared as data, a list of {@link DeclaredOption}s, the host reads each from the config as
   * `id=value` and writes it back there, and draws the field for its type: no code at all. That is
   * how a third-party plugin's manifest declares them. `fields` and `set` are for settings that live
   * anywhere else in what the note says, as a stopwatch's time so far and a board's column colours do.
   */
  options?: EmbedOptions | readonly DeclaredOption[];
}

/**
 * An embed's options. Both are given what the note says of the embed now and nothing else, so they
 * are as pure as `render`'s reading of it. What `set` returns is written as {@link Embedded.update}
 * writes: one change by the member, saved, recorded, undone and seen by everyone else as typing is.
 */
export interface EmbedOptions {
  /** The fields to show, each with its value as the note has it. None for one that can't be read. */
  fields(written: { config: string; body: string }): readonly EmbedField[];
  /** The embed with the field `id` set to `value`, or a sentence saying why that value can't be taken, which is shown under the fields. */
  set(written: { config: string; body: string }, id: string, value: string): { config?: string; body?: string } | string;
}

/**
 * One thing to adjust: text that is typed and taken on Enter or when the keyboard leaves it, or one
 * of a few choices. A choice with a `swatch` is drawn as a dot of that colour and not as its label:
 * one of {@link SWATCHES}, or `""` for no colour. A duration is set in hours, minutes and seconds,
 * and its value is the duration as written, as `1h30m`. `written` says whether the note writes it, for one
 * the host can take out of the note: a Clear button beside it is shown while it does.
 */
export type EmbedField = (
  | { id: string; label: string; kind: "text"; value: string; placeholder?: string; hint?: string; written?: boolean }
  | { id: string; label: string; kind: "choice"; value: string; choices: readonly { value: string; label: string; swatch?: Swatch | "" }[]; written?: boolean }
  | { id: string; label: string; kind: "duration"; value: string; written?: boolean }
) & {
  /** What is wrong with what the note writes for it, shown under it. */
  error?: string;
};

/** An embed's options declared as data, which the host reads from and writes into its config as `key=value` words. */
export { SWATCHES, type DeclaredOption, type OptionValue, type Swatch } from "../core/embedOptions.ts";
export { EMBED_SCHEMAS, optionValues } from "../core/embedSchema.ts";

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
   * Whether it is kept below only a line the embed is alone on. Among words it is what `render`
   * draws there and keeps nothing below, as an uploaded file is a chip in a sentence and a preview on
   * a line of its own.
   */
  alone?: boolean;
  /**
   * The room to keep, from what the note says of the embed alone: as wide as the note's column up to
   * a limit and `ratio` times as wide as tall, or `height` pixels tall. With `width`, it is no wider
   * than that many pixels, as a small picture isn't drawn larger than it is. Null for one with nothing
   * to show, such as a config that can't be read.
   */
  box(written: { config: string; body: string }): BelowBox | null;
  /**
   * Draws into `el`, which is as large as the room. May return a function that stops whatever it
   * started, or a {@link BelowDrawn}. `update` rewrites the embed in the note as {@link Embedded.update} does, which is how
   * what is only known once it has loaded, such as a picture's size, gets into the note for `box` to
   * read. `resize` is for what the note can't hold, such as how tall a post turned out to be once it
   * had loaded: it gives the room that height in pixels, which moves what is under it once, and does
   * nothing for a room sized by a ratio. `column` is how wide the note's column is now in pixels, the
   * widest a room can be, for something that offers to be drawn at a share of it.
   */
  render(el: HTMLElement, embed: BelowEmbedded): void | (() => void) | BelowDrawn;
}

export type BelowEmbedded = Pick<Embedded, "config" | "noteId" | "body" | "readOnly" | "update"> & { resize(height: number): void; column(): number };

/** What `Below.render` can give back. */
export interface BelowDrawn {
  /** Changes what was drawn to fit what the note says of the embed now, in the elements already there, as a playing video keeps playing at another size. Without it the element is emptied and drawn again. */
  update?(embed: BelowEmbedded): void;
  stop?(): void;
}

/**
 * The room kept below a line. `maxWidth` is a limit in pixels narrower than the host's own, for what
 * is drawn no wider, such as a post. `share` is how much of the column's width it takes, more than 0
 * and up to 1, which is what it takes without one.
 */
export type BelowBox = ({ ratio: number } | { height: number }) & { maxWidth?: number; share?: number };

/**
 * Something shown below a line that is one https address and nothing else: a video, a post. It has
 * no syntax of its own and is in no menu. Pasting or typing the address is the only way to write
 * one. The address is its config, and `update` does nothing for it. The line stays in the note, as
 * small as a caption, and its text is seen only with the pointer over the line or over what is shown
 * below it, or with the cursor on the line. So the address comes and goes and nothing moves.
 */
export interface AddressEmbed {
  /** A name of its own among the address embeds. A note that says `::name{}` is not this: an embed with a syntax may have the same name, as an uploaded video's `::video{}` has. */
  name: string;
  /** What a person sees it called. */
  title: string;
  /** Whether `address` is this one's to show. The first registered to say so has it. */
  claims(address: string): boolean;
  below: Below;
}

/** What an embed is handed about one place a note writes it. */
export interface Embedded {
  config: string;
  /** The note the embed is written in. */
  noteId: string;
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
   * Puts the cursor in the embed as the note writes it, to be changed there, as moving the cursor
   * onto it does. The embed stays drawn, the element it was, and its text is shown above its
   * drawing for as long as the cursor is in it: an inline embed's in rows of their own above its
   * line, a block's lines above its card. For a block, `at` is how far into its body the cursor goes,
   * as a board puts it on the line of the card that was pressed. Without it the cursor goes in the config.
   */
  edit(at?: number): void;
}

export type EmbedInfo = Pick<Embed, "name" | "title" | "block" | "starts" | "description" | "preview" | "pick">;

/** One entry of an embed in a menu that does something to make what it writes, as "Upload a file" asks for a file. */
export interface EmbedPick {
  title: string;
  /** What picking it does, in a line of words. */
  description?: string;
  /** @deprecated The same as `description`, read as one where there is no `description`. */
  detail?: string;
  preview?: CompletionPreview;
  /** What is written in place of the trigger and what was typed, made once it is picked, as a completion item's function `insert` is. */
  insert: (at: InsertAt) => Promise<string | null>;
}

/**
 * A list offered at the cursor while the member types after a trigger, such as the insert menu on
 * `/`. It opens where the trigger starts a line or follows a space, and not inside code, so a `/`
 * in a path or a date opens nothing. One with `anywhere` opens wherever its trigger is typed. Completions whose triggers both fit share one list, each
 * one's items in the order of their plugins, grouped by their `kind`.
 */
export interface Completion {
  id: string;
  /** What is typed to open it, such as `/`, `@`, or `[[`. */
  trigger: string;
  /** Whether what is typed after the trigger may hold spaces, as a note's title does. Without it a space closes the list. */
  spaces?: boolean;
  /** Whether the trigger opens the list anywhere outside code, such as right after a bracket or a word. For a trigger nobody types by accident, as `[[` is. */
  anywhere?: boolean;
  /**
   * Whether the trigger is written in prose too, as `/` is. After other words on its line Enter is
   * then always a new line, and Tab, the arrow keys or a click pick from the list.
   */
  prose?: boolean;
  /** What to offer for what has been typed after the trigger, in the note `at` names, best first. Nothing closes the list. */
  items(typed: string, at: { noteId: string }): readonly CompletionItem[] | Promise<readonly CompletionItem[]>;
  /**
   * Where its items go in the list among those of the other completions that fit and of the same
   * kind: lower first, 0 when not said, and in the order of their plugins where it is the same.
   */
  order?: number;
}

/**
 * The kinds of thing a list at the cursor groups what it offers by, in the order their groups are
 * listed, each with the heading its group is shown under. A new kind of thing to offer is a row here,
 * and its row is where its group goes. What is new is made when it is picked, such as a contact,
 * outside the note where undo doesn't reach: it `waits`, so the list never highlights it of itself
 * and Enter stays a new line until an arrow key or Tab picks it.
 */
export const COMPLETION_KINDS = [
  { kind: "person", heading: "People" },
  { kind: "date", heading: "Dates" },
  { kind: "note", heading: "Notes" },
  { kind: "folder", heading: "Folders" },
  { kind: "upload", heading: "Uploads" },
  { kind: "event", heading: "Events" },
  { kind: "block", heading: "Blocks" },
  { kind: "embed", heading: "Embeds" },
  { kind: "new", heading: "New", waits: true },
] as const;

export type CompletionKind = (typeof COMPLETION_KINDS)[number]["kind"];

/**
 * A small look at a completion item, shown beside the list while the item is highlighted: a note's
 * first lines, an upload's picture, an event's day and time. It is data, so whatever offers an item
 * says what to show and the list draws it. Each part is left out where it isn't given.
 */
export interface CompletionPreview {
  /** The address of a picture, drawn small. */
  image?: string;
  /** Words to read, as plain text, cut where the pane ends. */
  text?: string;
  /** What the item is, a name and a value each, such as an event's calendar. */
  facts?: readonly (readonly [name: string, value: string])[];
}

/** Where a completion item picked is to be written, for an `insert` that is made when it is picked. */
export interface InsertAt {
  /** The note it goes in. */
  noteId: string;
  /**
   * An empty element at the cursor that scrolls with the note's text, for a popover to hang from. It
   * is there until what `insert` answers is written, or nothing is.
   */
  anchor: HTMLElement;
  /** Gives the keyboard back to the note's editor, if it is still on the page, as a popover closed with Escape does. */
  focus(): void;
}

export interface CompletionItem {
  /**
   * What the item is, such as a person or a note. The list groups items by it, the groups in the
   * order of `COMPLETION_KINDS`, under a heading each where there is more than one. An item of no kind
   * comes before every group.
   */
  kind?: CompletionKind;
  label: string;
  /** A line under the label that says what the item is in words, such as a note's folder or an event's day. */
  description?: string;
  /** Said after the label, more quietly. */
  detail?: string;
  /** What is shown beside the list while the item is highlighted. */
  preview?: CompletionPreview;
  /**
   * What takes the place of the trigger and what was typed after it. A function is asked only when
   * the item is picked, for text that is made then, as a reference to an event is, or picked in a
   * popover, as a day from a calendar is. It is told where: what it answers is written once it does,
   * where the trigger and what was typed still are. Null, a failure, or a change to them meanwhile
   * writes nothing. One that sets off something that writes in its own time, as asking for a file to
   * upload does, answers `""` at once, so the trigger goes.
   */
  insert: string | ((at: InsertAt) => Promise<string | null>);
  /** The part of `insert` left selected, as offsets into it, such as a value to type over. Without it the cursor goes after. */
  select?: readonly [from: number, to: number];
  /** Whether `insert` goes on lines of its own, as a block embed must. The cursor goes to the line after, or to `select` where it is given, as in a heading's `# `. */
  block?: boolean;
  /** Whether a block is kept a blank line apart from words on the line under it, as a table is, which would take them in as a row. */
  apart?: boolean;
  /** How the label is coloured: `accent` is the theme colour and `muted` is gray. Without it, as the list's text is. */
  tone?: "accent" | "muted";
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
  /**
   * Also given to an editor of text that is no note: the member's settings JSON and the workspace's agents file. For how an editor is worked,
   * such as vim's keys, typewriter scrolling and line numbers, and not for what a note holds. Only Common Ink's own plugins may.
   */
  anyText?: boolean;
}

/** What an editor extension given as a function is told about the editor it is being made for. */
export interface EditorContext {
  /** The note the editor holds, or for text that is no note, which only an `anyText` extension is made for, its address: `/settings.json` or `/agents-file.md`. An editor holds one for as long as it lasts. */
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

export interface NoticeAction {
  label: string;
  run: () => void | Notice | Promise<void | Notice | undefined>;
}

/** Something the app tells the member in a card in the window's bottom right corner, which goes after a few seconds or when pressed. */
export interface Notice {
  message: string;
  /** The icon in the card's tile: "info" unless said. */
  icon?: IconName;
  /**
   * A button beside the message, such as Undo, or a few in a row. While what one's `run` answers is on
   * its way the card stays, without its buttons. A notice it answers with is said in the card's place;
   * nothing, and the card goes.
   */
  action?: NoticeAction | readonly NoticeAction[];
  /** Whether it stays until it is answered, pressed or taken down, as one that says something still true does. */
  stays?: boolean;
  /**
   * Whether it holds something the member would lose with it. It goes only by its buttons, never by a
   * press on it or Escape, and a newer card neither sends it away nor takes its place.
   */
  keeps?: boolean;
}

/** A tab open in the editor area, and which pane it is in: 1 for the first in reading order. */
export interface OpenTab {
  opened: Opened;
  pane: number;
}

export type PageInfo = Pick<Slots["page"], "id" | "path" | "label" | "description" | "icon" | "nav" | "home" | "transient" | "tabAt">;

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
  /** What the address names in the editor area: the note, the folder's list or the page in front. Null when nothing is open, and at an address nothing is at. */
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
  /** Whether the first listing of the notes or of the folders failed. It is asked for again on its own, and `refresh` asks now. */
  listingFailed: boolean;
  /**
   * The folder in front: the one whose list the address names, {@link ALL_NOTES} and
   * {@link SHARED_WITH_ME} among them, or the folder of the note it names. Null on a page, and when
   * nothing is open. The folder tree marks it.
   */
  folderId: string | null;
  /**
   * Focus: what is in front in the editor area fills the window. The sidebar, the inspector and
   * their bars are still drawn, out of sight, so leaving focus puts everything back as it was. A
   * view in the `editor` slot marks what fills the window: `data-focus-mode` on its `.groups`
   * and `data-front` on the one `.group` to show.
   */
  focus: boolean;
  /** Whether the sidebar is open. Closed, the `column` view is a narrow bar of icons. */
  sidebarOpen: boolean;
  pages: readonly PageInfo[];
  /** What plugins put in the `section` slot, for the column that shows them. Null when there is nothing in it. */
  sections: ReactNode;
  /** Each section that says what it is called, in the order they are drawn, for a column that is closed to stand an icon for. */
  sectionNames: readonly { id: string; label: string; icon: IconName }[];
  /**
   * One of those sections by its id, for a place that goes away once something is opened from it, as
   * the closed sidebar's picker over the page does. `opened` is called each time it opens a note, a
   * folder's list or a page, or goes to an address.
   */
  sectionsOpening: (opened: () => void, id: string) => ReactNode;
  /** Draws a note's text to be read and not changed, as {@link FolderProps.readNote} does, for a page that lists notes. */
  readNote: (noteId: string) => ReactNode;
  /**
   * Draws markdown that is not a note, such as an uploaded file's, to be read and not changed, as a
   * link's page draws a note: the same embeds, with nothing of the workspace behind them, and HTML
   * in it run only when the reader presses Run.
   */
  readMarkdown: (text: string) => ReactNode;
  /** The overlay that is open. */
  overlay: string | null;

  /** Goes to an address, which may carry a query. `state` is for the page there, which reads it as `pageState`. `replace` keeps Back from retracing the step. */
  go(path: string, options?: { state?: unknown; replace?: boolean }): void;
  /** Where a note lives, such as `/note/plan-3k2j5h8d9f0a`. */
  notePath(noteId: string): string;
  /**
   * Opens a note in the pane in front, even where another pane has it too. There is one preview in
   * the window at most: a preview takes the place of the one there, a folder's list among them, and
   * one in another pane goes. `focus` puts the cursor in its editor. `background` opens it in a tab
   * of its own, which is kept, without leaving what is in front. Where the editor area has no tabs
   * the note is opened as it otherwise would be.
   */
  openNote(noteId: string, options?: { preview?: boolean; focus?: boolean; background?: boolean }): void;
  /** Opens a folder's list of notes in the pane in front, unless another pane keeps it: a folder's id, {@link ALL_NOTES} or {@link SHARED_WITH_ME}. A preview, which it is unless said, takes the place of the preview there, a note's or a folder's. */
  openFolder(folderId: string, options?: { preview?: boolean }): void;
  /**
   * Opens a note, a folder's list or a page in a split: a part of the editor area of its own, right
   * of or under what is in front, where it is kept. Null where the editor area has no splits.
   */
  openBeside: ((tab: Opened, side: "right" | "down") => void) | null;
  /**
   * Opens a note, a folder's list or a page to the side: in the pane after the one in front, or in a
   * new pane right of it when there is one pane, as a preview unless `preview` is false. With `focus`
   * the pane it opens in comes in front, and a note's editor takes the cursor; without, the pane in
   * front stays so. Null where the editor area has no splits.
   */
  openToSide: ((tab: Opened, options?: { preview?: boolean; focus?: boolean }) => void) | null;
  /** Where a folder's list lives, such as `/folder/all`. */
  folderPath(folderId: string): string;
  /**
   * For the editor area: puts a note, a folder's list or a page at the app's address, or nothing.
   * `replace` keeps Back from retracing the step. `move` is a step between things already open, as a
   * click on a tab is: Back retraces it, and the next move takes its place, so a run of moves is one
   * step and none of them takes the place of an open.
   */
  show(tab: Opened | null, options?: { replace?: boolean; move?: boolean }): void;
  /**
   * Creates a note and opens it. It goes in `folderId` when that is a folder; otherwise in the
   * folder in front, which is the open note's folder when a note is in front; otherwise in Unsorted.
   * Refused with the server's reason where the member can't. Answers the note's id. With `open: false`
   * it is made and not opened, for whoever opens it somewhere of their own, as a drop on a group does.
   */
  createNote(folderId?: string, options?: { open?: boolean }): Promise<string>;
  moveNote(noteId: string, folderId: string): Promise<void>;
  /** Tells the app a note changed, with the note as it is now: its text, its folder, or its state. */
  noteChanged(note: Note): void;
  /** Reads the folders and notes again, after a change the app wasn't told about: done once the folders are read. */
  refresh(): Promise<void>;
  /**
   * For the editor area: says a note is open in none of its tabs now. A note the member made that
   * never had anything in it but spaces or a lone `#` is then removed outright, not put in Trash, once
   * what was typed in it has been sent: so a new note left untouched leaves nothing behind. Any other
   * note is left as it is.
   */
  left(noteId: string): void;
  /**
   * Sends what is typed in a note's editor now, without waiting for a pause in the typing. For a
   * change that must reach the server as it is, before anything else is typed. It answers with the
   * note as that write left it, `filed` saying whether it checked off a recurring todo, and with
   * nothing when there was nothing to send, no editor of the note, or the write didn't land.
   */
  saveNote(noteId: string): Promise<Written | undefined>;
  /** Records that the member was shown a note's changes up to a revision. */
  markSeen(noteId: string, revision: number): void;
  /** Every tab open in the editor area, pane by pane. Where the editor area has no tabs, what is in front. */
  openTabs(): readonly OpenTab[];
  /**
   * The notes, folders' lists and pages the member has been to in this browser, the latest first and
   * each once, what is in front among them. A page is at the address it was last at.
   */
  recent(): readonly Opened[];
  /** Tells the member something that just happened, such as that a note was moved to Trash. Notices stack, newest at the foot, three at most; one saying what a shown one says takes its place. It answers with what takes the card down, which does nothing once it has gone. */
  notify(notice: Notice): () => void;
  /** Opens an overlay, or closes it when it is the one open. `state` is for the overlay, which is handed it. */
  toggleOverlay(id: string, state?: unknown): void;
  toggleSidebar(): void;
  /** Does what a panel's icon in the inspector's bar does: shows that panel, or closes it if it is the one showing. */
  togglePanel(viewId: string): void;
  /**
   * For a page: says what the page is showing, for the inspector to be about while the page is in
   * front, or null for nothing. {@link useInspected} calls it and takes it back when the page goes.
   * Anywhere but in a page it does nothing.
   */
  inspect(showing: Showing | null): void;
  /** Enters or leaves focus. */
  setFocus(on: boolean): void;
  switchWorkspace(workspaceId: string): void;
  /** Reads again which workspaces the member is in and their role in each, after a change to members that may be to the member themself. */
  reloadWorkspaces(): void;
  signOut(): void;
}
