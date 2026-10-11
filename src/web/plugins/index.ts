import type { Plugin } from "../plugin-api.ts";
import { agents } from "./agents/index.tsx";
import { backlinks } from "./backlinks.tsx";
import { folders } from "./folders.tsx";
import { comingSoon } from "./comingSoon.tsx";
import { commandPalette } from "./commandPalette.tsx";
import { history } from "./history/index.tsx";
import { noteInfo } from "./noteInfo.tsx";
import { noteList } from "./noteList.tsx";
import { quickOpen } from "./quickOpen.tsx";
import { sidebar } from "./sidebar.tsx";
import { stopwatch } from "./stopwatch.ts";
import { tabs } from "./tabs/index.tsx";
import { vim } from "./vim/index.ts";

/** The plugins that come with the app, in the order their contributions are shown. Each is on until a member turns it off, except one that says it starts off. */
export const BUILT_INS: readonly Plugin[] = [sidebar, folders, noteList, tabs, quickOpen, commandPalette, comingSoon, history, agents, backlinks, noteInfo, stopwatch, vim];
