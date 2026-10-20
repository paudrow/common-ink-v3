import type { Dispose, Plugin } from "../../plugin-api.ts";
import { heightNow, typewriter, Writing, type Hold } from "./hold.ts";

/** Typewriter mode: the line holding the cursor stays at one height in the note's pane, and the text scrolls under it. */
export const typewriterMode: Plugin = {
  id: "typewriter",
  name: "Typewriter mode",
  description: "Keeps the line you're typing at one height in the note, the middle unless you keep it elsewhere, and scrolls the text under it. It can dim every paragraph, heading and bullet but the ones you're in.",
  icon: "typewriter",
  enabledByDefault: false,
  settings: {
    on: {
      type: "boolean",
      default: true,
      remembered: true,
      title: "Typewriter mode is on",
      description: "Whether the line is held right now. The command Toggle typewriter mode changes it, and so does its key.",
    },
    height: {
      type: "integer",
      default: 50,
      minimum: 0,
      maximum: 100,
      remembered: true,
      title: "Height of the line",
      description: "Where the line is held, in percent of the note's height: 0 at the top, 100 at the foot. The command Typewriter: keep the line at this height sets it to where the line is.",
    },
    dim: {
      type: "boolean",
      default: false,
      title: "Dim the rest of the note",
      description: "Fades every paragraph, heading and bullet but the one the cursor is in and any you select. A bullet is lit without the bullets under it, and a code block or a table is lit whole.",
    },
    vimSetsHeight: {
      type: "boolean",
      default: true,
      title: "Vim's zz, zt and zb set the height",
      description: "With vim on, zt keeps the line at the top from then on, zz in the middle and zb at the foot. Off, they leave the line at its height.",
    },
  },
  activate(host) {
    const writing = new Writing();
    const hold = (): Hold =>
      host.settings.get<boolean>("on") ? { at: host.settings.get<number>("height") / 100, dim: host.settings.get<boolean>("dim"), asked: host.settings.get<boolean>("vimSetsHeight") } : null;

    // A new registration reconfigures every open editor, so it is made only when the hold changes and not with every other setting.
    let held: string | null = null;
    let registered: Dispose | null = null;
    const refresh = () => {
      const now = hold();
      if (JSON.stringify(now) === held) return;
      held = JSON.stringify(now);
      registered?.();
      registered = host.editorExtensions.register({ id: "typewriter", extension: (editor) => (editor.reading ? [] : typewriter(now, writing, keep)) });
    };
    // Told once, and not again for every key pressed until a setting has been written.
    let told = false;
    const written = (set: boolean) => {
      if (set) told = false;
      else if (!told) {
        told = true;
        host.app().notify({ message: "Typewriter mode can't be changed until your settings have loaded.", icon: "typewriter" });
      }
      return set;
    };
    const keep = (height: number) => written(host.settings.set("height", height));

    host.commands.register({
      id: "typewriter.toggle",
      title: "Toggle typewriter mode",
      keys: ["mod+shift+y"],
      group: "Typewriter",
      run() {
        written(host.settings.set("on", !host.settings.get<boolean>("on")));
      },
    });
    host.commands.register({
      id: "typewriter.holdHere",
      title: "Typewriter: keep the line at this height",
      group: "Typewriter",
      run() {
        const height = heightNow(writing);
        if (height === null) return void host.app().notify({ message: "Put the cursor on a line of a note first, where you want lines kept.", icon: "typewriter" });
        written(host.settings.set("height", height) && host.settings.set("on", true));
      },
    });

    // Not at once, as Night shift: a setting read while the plugin is starting has its options listed as off.
    let stopped = false;
    queueMicrotask(() => !stopped && refresh());
    host.settings.subscribe(refresh);
    return () => {
      stopped = true;
    };
  },
};
