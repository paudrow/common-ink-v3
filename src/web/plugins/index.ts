import type { Plugin } from "../plugin-api.ts";
import { agents } from "./agents/index.tsx";
import { blame } from "./blame/index.ts";
import { bullets } from "./bullets/index.ts";
import { calendar } from "./calendar/index.tsx";
import { codeBlocks } from "./code/index.ts";
import { folders } from "./folders.tsx";
import { commandPalette } from "./commandPalette.tsx";
import { contacts } from "./contacts/index.tsx";
import { email } from "./email/index.tsx";
import { daily } from "./daily/index.tsx";
import { dashboard } from "./dashboard/index.tsx";
import { dates } from "./dates/index.tsx";
import { embedMenu } from "./embedMenu.ts";
import { gfm } from "./gfm/index.ts";
import { html } from "./html/index.ts";
import { history } from "./history/index.tsx";
import { forms } from "./forms/index.ts";
import { kanban } from "./kanban/index.ts";
import { lineNumbers } from "./lineNumbers.ts";
import { links } from "./links/index.ts";
import { math } from "./math/index.ts";
import { media } from "./media/index.ts";
import { members } from "./members/index.tsx";
import { mentions } from "./mentions/index.tsx";
import { nightShift } from "./nightShift/index.ts";
import { noteClocks } from "./noteClocks.tsx";
import { noteInfo } from "./noteInfo.tsx";
import { noteList } from "./noteList.tsx";
import { quickOpen } from "./quickOpen.tsx";
import { search } from "./search/index.tsx";
import { sharing } from "./sharing/index.tsx";
import { sidebar } from "./sidebar.tsx";
import { stopwatch } from "./stopwatch.ts";
import { tables } from "./tables/index.ts";
import { tabs } from "./tabs/index.tsx";
import { tags } from "./tags/index.tsx";
import { timer } from "./timer.ts";
import { todos } from "./todos/index.tsx";
import { trash } from "./trash/index.tsx";
import { typewriterMode } from "./typewriter/index.ts";
import { uploads } from "./uploads/index.tsx";
import { vim } from "./vim/index.ts";

/**
 * The plugins that come with the app and run inside it, each beside the file it starts from, in the
 * order their contributions are shown. Each is on until a member turns it off, except one that says
 * it starts off. The ones that run shut off from the app are not here: their code is in
 * `sandboxed/`, they are declared in `src/core/ownPlugins.ts`, and `PLACED_AFTER` places them among these.
 */
const AT: readonly (readonly [Plugin, string])[] = [
  [sidebar, "sidebar.tsx"],
  [folders, "folders.tsx"],
  [tags, "tags/index.tsx"],
  [noteList, "noteList.tsx"],
  [tabs, "tabs/index.tsx"],
  [quickOpen, "quickOpen.tsx"],
  [commandPalette, "commandPalette.tsx"],
  [search, "search/index.tsx"],
  [dashboard, "dashboard/index.tsx"],
  [uploads, "uploads/index.tsx"],
  [history, "history/index.tsx"],
  [blame, "blame/index.ts"],
  [agents, "agents/index.tsx"],
  [members, "members/index.tsx"],
  [sharing, "sharing/index.tsx"],
  [noteInfo, "noteInfo.tsx"],
  [trash, "trash/index.tsx"],
  [embedMenu, "embedMenu.ts"],
  [timer, "timer.ts"],
  [stopwatch, "stopwatch.ts"],
  [kanban, "kanban/index.ts"],
  [forms, "forms/index.ts"],
  [noteClocks, "noteClocks.tsx"],
  [media, "media/index.ts"],
  [html, "html/index.ts"],
  [calendar, "calendar/index.tsx"],
  [contacts, "contacts/index.tsx"],
  [email, "email/index.tsx"],
  [gfm, "gfm/index.ts"],
  [todos, "todos/index.tsx"],
  [daily, "daily/index.tsx"],
  [dates, "dates/index.tsx"],
  [links, "links/index.ts"],
  [mentions, "mentions/index.tsx"],
  [tables, "tables/index.ts"],
  [math, "math/index.ts"],
  [codeBlocks, "code/index.ts"],
  [bullets, "bullets/index.ts"],
  [lineNumbers, "lineNumbers.ts"],
  [vim, "vim/index.ts"],
  [nightShift, "nightShift/index.ts"],
  [typewriterMode, "typewriter/index.ts"],
];

export const BUILT_INS: readonly Plugin[] = AT.map(([plugin]) => plugin);

/** Where each one's source starts, under this folder. A plugin's page shows that file and what it imports from here. */
export const SOURCE_OF: ReadonlyMap<string, string> = new Map(AT.map(([plugin, file]) => [plugin.id, file]));

/** Which of the plugins above each plugin that runs shut off comes after, so its contributions keep the place they had when it ran inside the app. */
export const PLACED_AFTER: Readonly<Record<string, string>> = { backlinks: "sharing", coin: "vim", dice: "vim", "quick-timer": "note-clocks", "sample-calendar": "calendar", "word-count": "vim", weather: "dashboard" };
