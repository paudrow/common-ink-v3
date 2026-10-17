import type { Author, IconName, NoteSummary, Standing } from "../plugin-api.ts";

/** How tall a card's note is drawn before the rest is asked for. */
export const EXCERPT_HEIGHT = 220;

/** How far outside the list's window a card's note is read and drawn, so it is there by the time it is scrolled to. */
export const NEAR_PX = 300;

/** How many of a note's editors a card names before it counts the rest. */
export const NAMES_SHOWN = 2;

/** A snippet this long was cut, so its note goes on. */
const CUT_SNIPPET = 150;
/** What a note of a title alone takes, a title with a line under it, and each line more, as the reader draws them. */
const TITLE_HEIGHT = 38;
const TITLE_AND_LINE_HEIGHT = 85;
const LINE_HEIGHT = 23;
const CHARS_A_LINE = 90;

/**
 * How tall a card's note is taken to be before it has been drawn, from what the listing says of it.
 * A note whose snippet was cut goes on past the excerpt, and is said to be a little taller than it,
 * which is all a card cut to the excerpt needs to know. A short one is guessed as its title and its
 * snippet in one paragraph, which is right for a note written that way and short for one of several blocks.
 */
export const estimatedHeight = (note: Pick<NoteSummary, "snippet">) =>
  note.snippet.length >= CUT_SNIPPET
    ? EXCERPT_HEIGHT + 1
    : note.snippet
      ? Math.min(EXCERPT_HEIGHT, TITLE_AND_LINE_HEIGHT + LINE_HEIGHT * (Math.ceil(note.snippet.length / CHARS_A_LINE) - 1))
      : TITLE_HEIGHT;

/** How tall a card's note is shown, of how tall it is. */
export const shownHeight = (full: number, whole: boolean) => (whole ? full : Math.min(full, EXCERPT_HEIGHT));

const idOf = (a: Author) => (a.kind === "member" ? `member:${a.personId}` : a.kind === "agent" ? `agent:${a.agentId}` : `plugin:${a.pluginId}`);

/** An editor as the full list names them: an agent and a plugin say what they are, since either may share a person's name. */
export const editorLabel = (a: Author) => (a.kind === "member" ? a.name : `${a.name} (${a.kind})`);

export interface Editors {
  /** The first few, whoever changed the note latest first. */
  shown: string[];
  /** How many more there are than are shown. */
  more: number;
  /** Everyone, each said with what they are. */
  all: string[];
}

/**
 * Who has edited a note, for its card. `authors` is everyone the history has for it, latest first,
 * or undefined before that is known, when the card names who the listing says changed it last.
 * A note nobody has written yet has its creator.
 */
export function editorsOf(note: Pick<NoteSummary, "updatedBy">, authors: readonly Author[] | undefined): Editors {
  const seen = new Set<string>();
  const everyone = [note.updatedBy, ...(authors ?? [])].filter((a) => !seen.has(idOf(a)) && seen.add(idOf(a)));
  return { shown: everyone.slice(0, NAMES_SHOWN).map((a) => a.name), more: Math.max(0, everyone.length - NAMES_SHOWN), all: everyone.map(editorLabel) };
}

export const CARD_ITEMS = ["share", "move", "copyLink", "splitRight", "splitDown", "info", "archive", "unarchive", "trash"] as const;
export type CardItem = (typeof CARD_ITEMS)[number];

/** What the app can do where the card is, besides what the note allows. */
export interface CardReach {
  standing: Standing;
  /** Whether the Share dialog is there to open. */
  sharing: boolean;
  /** Whether the editor area has splits. */
  splits: boolean;
  /** How many folders other than the note's own the member could move it to. */
  targets: number;
  /** For a private note, whether the server says this person may share it or stop it being private. A listing can't tell whose a private note is. */
  mayShare?: boolean;
}

/**
 * What a card's menu holds for one note and one person. An item they may not use is not there:
 * a viewer and a guest who can only read get no way to archive, move, trash or share.
 * Sharing is `canShare` in the core: an admin or an editor who can edit a note that isn't private.
 * A private note is its owner's to share whatever their role, which only the server knows: `mayShare`.
 */
export function cardItems(note: Pick<NoteSummary, "access" | "state" | "folderId" | "private">, reach: CardReach): CardItem[] {
  const edits = note.access === "edit";
  const allowed: Record<CardItem, boolean> = {
    share: reach.sharing && (note.private ? reach.mayShare === true : edits && (reach.standing === "admin" || reach.standing === "editor")),
    move: edits && note.folderId !== null && reach.targets > 0,
    copyLink: true,
    splitRight: reach.splits,
    splitDown: reach.splits,
    info: true,
    archive: edits && note.state === "live",
    unarchive: edits && note.state === "archived",
    trash: edits,
  };
  return CARD_ITEMS.filter((item) => allowed[item]);
}

export const ITEM_LABELS: Record<CardItem, string> = {
  share: "Share settings",
  move: "Move to folder",
  copyLink: "Copy link",
  splitRight: "Open in a split right",
  splitDown: "Open in a split down",
  info: "Info",
  archive: "Archive",
  unarchive: "Unarchive",
  trash: "Move to Trash",
};

/** The icon before each item, so the menu can be skimmed. */
export const ITEM_ICONS: Record<CardItem, IconName> = {
  share: "share",
  move: "folders",
  copyLink: "copy",
  splitRight: "split",
  splitDown: "splitDown",
  info: "info",
  archive: "archive",
  unarchive: "unarchive",
  trash: "trash",
};
