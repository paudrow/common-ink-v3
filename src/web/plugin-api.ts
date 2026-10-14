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
import type { Agent, AgentEdit, ConnectOptions, Grant, GrantAccess, Invite, LinkKind, ListedFolder, Member, Note, NoteSummary, OpInput, Results, Role, Sharing, WorkspaceSummary } from "../core/protocol.ts";
import type { IconName } from "./icons.tsx";
import type { Showing } from "./inspected.ts";

/** The workspace operations and what they answer with: the same ones an agent has. */
export type * from "../core/protocol.ts";
export { DEFAULT_EXPIRY_DAYS, MAX_AGENT_NAME, MAX_EXPIRY_DAYS, MAX_NOTES_AT_ONCE } from "../core/protocol.ts";
/** Where two lists of lines differ, for a view that marks what changed inside a line. */
export { lineHunks } from "../core/text.ts";

/** How a note writes a link to another note, which is the same for a plugin as for an agent. */
export { isNoteId, linksIn, linksOn, writtenLink, type WrittenLink } from "../core/links.ts";

/** How a note writes a todo and its options, read and rewritten by the functions the core indexes todos with. */
export { changeTodo, completeTodo, isDay, locateTodo, nameKey, parseTodo, rewriteTodo, tagsOn, todosIn, type Importance, type NoteTodo, type Todo, type TodoChange } from "../core/todos.ts";

export { dismissing, useDismiss } from "./dismiss.ts";
export { sandboxed } from "./htmlFrame.ts";
export { askSite } from "./otherSites.ts";
/** The theme the app is drawn in, for what is drawn by someone else and has to be asked for in one: another site's frame. */
export { onTheme, themeNow, type Theme } from "./theme.ts";
/** Whether an editor state is that of a reading of a note, where nothing is shown as written whatever is selected. */
export { isReading } from "./readOnly.ts";
export { ResizeHandle } from "./resize.tsx";
export { TITLE_MARK } from "./titleMark.ts";
export { Icon, type IconName } from "./icons.tsx";
export { ago, useNow } from "./time.ts";
/** A note's text and selection as its editor has them now, for a view that says something of the note in front. */
export { useOpenNote, type OpenNote } from "./openNotes.ts";

/**
 * Dragging to the editor area. `carry` puts a note, a folder's list or a page on a drag, `carried`
 * reads it back where it is dropped, and `carriesTab` says while it is over something whether it
 * has one. A note is carried under `NOTE_DRAG` as its id, so it also drops wherever a note does.
 */
export { NOTE_DRAG, carried, carriesTab, carry } from "./dragged.ts";

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
export type Setting = { title: string; description?: string } & (
  | { type: "boolean"; default: boolean }
  /**
   * `unreadable` is what it reads as when the member's value isn't one it can take, if that is not the default: the safe choice, for a
   * setting that guards something. `defaultWithoutEmbedSite` is its default instead on a server whose HTML embeds have no host of
   * their own (`EMBED_ORIGIN`), as the server says: the safe choice there.
   */
  | { type: "string"; default: string; enum?: readonly string[]; maxLength?: number; unreadable?: string; defaultWithoutEmbedSite?: string }
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
  /** Calls `listener` each time the notes the member can see change: one made, renamed, moved, or changed by anyone. `app().notes` then holds them as they are. */
  onNotes(listener: () => void): Dispose;
  /** The app as it is now. A view is handed this as `app`; a command reads it when it runs. It isn't there yet during `activate`. */
  app(): App;
  /**
   * Performs a workspace operation as the member, with the member's access. Typing in open editors
   * is saved before an operation that moves a note through its history or previews that, and the editors take the result.
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
  /**
   * A column left of the editor: the sidebar. It is drawn closed too, when `app.sidebarOpen` is
   * false, and is then to be a narrow bar of icons (`<nav class="rail">`) for what it lists when
   * open. Its edge is the member's way back to open, and `app.toggleSidebar` is the view's own.
   * In focus it is still drawn, out of sight.
   */
  column: { id: string; component: View };
  /** A section of the sidebar, such as the folder tree. A column places them with `app.sections` while it is open, and may show them over the page from its bar with `app.sectionsOpening`. */
  section: { id: string; component: View };
  /** What fills the editor area when a note, a folder's list, a page, or nothing is open. The last one registered is used; with none, the app shows what the address names alone. */
  editor: {
    id: string;
    component: ComponentType<EditorProps>;
    /**
     * Asked to open a note, a folder's list or a page, in place of the app going to it. Call
     * `app.show` with what ends up in front. With `background` it is opened without being put in front.
     */
    open?: (tab: Opened, options: { preview: boolean; background?: boolean }) => void;
    /**
     * Asked to open a note, a folder's list or a page in a part of the editor area of its own,
     * right of or under what is in front, and to keep it there. An editor area that has this is
     * what `app.openBeside` goes to, and what makes a page's link and a folder's row in the sidebar
     * offer "Open in a split".
     */
    split?: (tab: Opened, side: "right" | "down") => void;
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
   * `go.<id>` command. `order` places its link among the others: lower first, and those with none
   * after them, in the order of their plugins. A page is also shown at every address under its
   * path, such as `/plugins/tabs` for the page at `/plugins`, unless another page is at exactly that address:
   * it reads the rest from `app.path`. One that is `transient` only leads somewhere else
   * with `app.show`: it is never a tab, and is drawn in place of the editor area for the moment it
   * takes to find where to go, with the editor area kept as it is underneath.
   */
  page: { id: string; path: `/${string}`; label: string; icon?: IconName; nav?: "primary" | "more" | "menu"; order?: number; transient?: boolean; component: View };
  /**
   * An item in the bottom bar: one thin line along the foot of the window for small things to
   * glance at, such as a count of the open note's words. `side` is the end it sits at, the left
   * unless said, and `order` places it among the others at that end, lowest first and 0 unless
   * said. Items of one order stay in the order of the plugins that added them. A component with
   * nothing to say draws nothing, and takes no room. The bar is there while any plugin has an item
   * in it, with something to say or not, so nothing above it moves as items come and go. In focus
   * it is out of sight.
   */
  bar: { id: string; component: View; side?: "left" | "right"; order?: number };
  /** Something drawn over the app, such as the command palette. One is open at a time; `app.toggleOverlay` opens it, and what it hands over is `state`. */
  overlay: { id: string; component: ComponentType<ViewProps & { close: () => void; state: unknown }> };
}

/**
 * What the inspector is about: what the editor area has in front. A note; a folder's list, where
 * `folderId` is a folder's id or {@link ALL_NOTES}, `name` is what the list is called and `notes`
 * are the notes in it; or the notes a page says it is showing, under the name the page gave them.
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
   * view moved to another part of itself, where its editor is drawn anew.
   */
  renderNote: (noteId: string, options?: { onEdit?: () => void; focus?: boolean; onFocused?: () => void }) => ReactNode;
  /** Draws a folder's list of notes, with whatever is in the `folder` slot. */
  renderFolder: (folderId: string) => ReactNode;
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
  /** What a new one is written with when it is picked from the embed menu. With none, an empty config and an empty body. */
  starts?: { config?: string; body?: string };
  /**
   * Draws into `el`, once, all of it before returning, so the embed is never seen half drawn. May
   * return a function that stops whatever it started, or a {@link Drawn}. An embed is registered
   * while its plugin starts, not later, so a note never shows it as written first.
   */
  render(el: HTMLElement, embed: Embedded): void | (() => void) | Drawn;
  /** What it keeps below the line that writes it, such as a video. */
  below?: Below;
  /**
   * What a member can adjust about it without reading its config. The host draws one options button
   * in the embed's card, and opens beneath the card a field for each of these. An embed that has
   * none, or gives none for what the note says of it now, has no button, and neither has a member
   * who can't change the note.
   */
  options?: EmbedOptions;
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
 * one of {@link SWATCHES}, or `""` for no colour.
 */
export type EmbedField =
  | { id: string; label: string; kind: "text"; value: string; placeholder?: string; hint?: string }
  | { id: string; label: string; kind: "choice"; value: string; choices: readonly { value: string; label: string; swatch?: Swatch | "" }[] };

/** The colours an embed can ask for by name. Each is drawn to suit the theme, light or dark, as `--swatch` on an element with `data-colour`. */
export const SWATCHES = ["red", "orange", "yellow", "green", "blue", "purple", "pink", "gray"] as const;
export type Swatch = (typeof SWATCHES)[number];

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
   * read. `resize` is for what the note can't hold, such as how tall a post turned out to be once it
   * had loaded: it gives the room that height in pixels, which moves what is under it once, and does
   * nothing for a room sized by a ratio.
   */
  render(el: HTMLElement, embed: Pick<Embedded, "config" | "body" | "readOnly" | "update"> & { resize(height: number): void }): void | (() => void);
}

/** The room kept below a line. `maxWidth` is a limit in pixels narrower than the host's own, for what is drawn no wider, such as a post. */
export type BelowBox = ({ ratio: number } | { height: number }) & { maxWidth?: number };

/**
 * Something shown below a line that is one https address and nothing else: a video, a post. It has
 * no syntax of its own and is in no menu. Pasting or typing the address is the only way to write
 * one. The address is its config, and `update` does nothing for it. The line stays in the note, as
 * small as a caption, and its text is seen only with the pointer over the line or over what is shown
 * below it, or with the cursor on the line. So the address comes and goes and nothing moves.
 */
export interface AddressEmbed {
  /** A name of its own among the embeds. A note that says `::name{}` is not this, and stays text. */
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
  /**
   * Whether the trigger is written in prose too, as `/` is. After other words on its line Enter is
   * then always a new line, and Tab, the arrow keys or a click pick from the list.
   */
  prose?: boolean;
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
  /**
   * The same sections, for a place that goes away once something is opened from it, as the closed
   * sidebar's folder tree over the page does. `opened` is called each time one of them opens a
   * note, a folder's list or a page, or goes to an address.
   */
  sectionsOpening: (opened: () => void) => ReactNode;
  /** Draws a note's text to be read and not changed, as {@link FolderProps.readNote} does, for a page that lists notes. */
  readNote: (noteId: string) => ReactNode;
  /** The overlay that is open. */
  overlay: string | null;

  /** Goes to an address. `state` is for the page there, which reads it as `pageState`. `replace` keeps Back from retracing the step. */
  go(path: string, options?: { state?: unknown; replace?: boolean }): void;
  /** Where a note lives, such as `/note/plan-3k2j5h8d9f0a`. */
  notePath(noteId: string): string;
  /**
   * Opens a note. There is one preview in the window at most: a preview takes the place of the one there, a folder's list among them, wherever in the
   * editor area that is. `focus` puts the cursor in its
   * editor. `background` opens it in a tab of its own, which is kept, without leaving what is in
   * front. Where the editor area has no tabs the note is opened as it otherwise would be.
   */
  openNote(noteId: string, options?: { preview?: boolean; focus?: boolean; background?: boolean }): void;
  /** Opens a folder's list of notes: a folder's id, {@link ALL_NOTES} or {@link SHARED_WITH_ME}. A preview, which it is unless said, takes the place of the preview there, a note's or a folder's. */
  openFolder(folderId: string, options?: { preview?: boolean }): void;
  /**
   * Opens a note, a folder's list or a page in a split: a part of the editor area of its own, right
   * of or under what is in front, where it is kept. Null where the editor area has no splits.
   */
  openBeside: ((tab: Opened, side: "right" | "down") => void) | null;
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
   * Refused with the server's reason where the member can't.
   */
  createNote(folderId?: string): Promise<void>;
  moveNote(noteId: string, folderId: string): Promise<void>;
  /** Tells the app a note changed, with the note as it is now. */
  noteChanged(note: Note): void;
  /** Reads the folders and notes again, after a change the app wasn't told about. */
  refresh(): void;
  /** Records that the member was shown a note's changes up to a revision. */
  markSeen(noteId: string, revision: number): void;
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
