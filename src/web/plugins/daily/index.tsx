import { useEffect, useState } from "react";
import { DAILY_SETTINGS, today, type App, type Plugin, type PluginHost } from "../../plugin-api.ts";
import { browserZone, dayTitled, todayIn, toward, type Asked } from "./days.ts";
import { dayStepper } from "./steps.ts";

const PATH = "/today";

/**
 * Finds or makes the member's daily note for today, where today is this browser's day, and shows it
 * in place of this page, so Back goes to where the member was before and not through here again.
 */
function Today({ host, app }: { host: PluginHost; app: App }) {
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    host.perform({ type: "daily.open", on: today() }).then(
      (note) => {
        if (stale) return;
        // It may have just been made, in a folder that was just made.
        app.noteChanged(note);
        app.refresh();
        app.show({ kind: "note", id: note.id }, { replace: true });
        app.openNote(note.id, { focus: true });
      },
      (err: unknown) => !stale && setProblem(err instanceof Error ? err.message : "Common Ink can't be reached."),
    );
    return () => {
      stale = true;
    };
  }, [host]);

  return (
    <section className="daily-opening" aria-label="Today" aria-busy={problem === null}>
      {problem !== null && (
        <>
          <h1>Today's daily note couldn't be opened</h1>
          <p role="alert">{problem}</p>
        </>
      )}
    </section>
  );
}

/** Whether the note is the member's daily note for `day`, as the server keeps which note that is. A guest has none. */
const isDaily = (host: PluginHost, noteId: string, day: string): Promise<boolean> =>
  host.perform({ type: "daily.find", on: day }).then(
    ({ note }) => note?.id === noteId,
    () => false,
  );

/** Opens the member's daily note for the day asked, made as Today makes it when it may be, or says there is none. */
async function openDay(host: PluginHost, { day, make }: Asked) {
  try {
    if (make) {
      const note = await host.perform({ type: "daily.open", on: day });
      host.app().noteChanged(note);
      host.app().refresh();
      host.app().openNote(note.id, { focus: true });
      return;
    }
    const { note } = await host.perform({ type: "daily.find", on: day });
    if (note) host.app().openNote(note.id, { focus: true });
    else host.app().notify({ message: `No note for ${day}` });
  } catch (err) {
    host.app().notify({ message: err instanceof Error ? err.message : "Common Ink can't be reached." });
  }
}

const todayHere = () => todayIn(Date.now(), browserZone());

/** The day of the daily note in front, or today when the note in front isn't one. */
async function dayInFront(host: PluginHost): Promise<string> {
  const note = host.app().note;
  const day = note && dayTitled(note.title);
  return day && (await isDaily(host, note.id, day)) ? day : todayHere();
}

const { folder, private: isPrivate, timeZone } = DAILY_SETTINGS;
const named = (key: string) => key.slice("daily.".length);

/**
 * Daily notes. Each member has one note a day, headed by its date, which is where the recurring
 * todos they check off are filed. The server makes it, by the settings declared here, which it reads
 * under the same keys.
 */
export const daily: Plugin = {
  id: "daily",
  name: "Daily notes",
  description: "A note for each day, made when first needed, where checked-off todos are filed.",
  icon: "today",
  settings: {
    [named(folder.key)]: {
      type: "string",
      default: folder.default,
      maxLength: folder.maxLength,
      title: "Daily notes folder",
      description: "The folder at the top of the workspace that a new daily note is made in. It is made when it isn't there. Changing this leaves the daily notes already made where they are.",
    },
    [named(isPrivate.key)]: {
      type: "boolean",
      default: isPrivate.default,
      title: "Private daily notes",
      description: "Whether a new daily note is hidden from the other members of the workspace. A todo you check off is filed on your daily note with its words. On a daily note that others can read, a todo from a note that is private or shared with only some people is filed as a link alone.",
    },
    [named(timeZone.key)]: {
      type: "string",
      default: timeZone.default,
      maxLength: 64,
      title: "Time zone for agents",
      description: "A time zone by its IANA name, such as America/Chicago. It says what day it is when an agent completes a todo or opens a daily note without saying the day, and agents are given times in it. The app itself always uses this browser's day. Empty is UTC.",
    },
  },
  activate(host) {
    host.views.register("page", { id: "today", path: PATH, label: "Today", icon: "today", nav: "primary", order: 25, transient: true, component: ({ app }) => <Today host={host} app={app} /> });
    host.commands.register({ id: "daily.today", title: "Open today's daily note", group: "Navigation", run: () => host.app().go(PATH) });
    const step = (from: string, by: number) => void openDay(host, toward(from, by, todayHere()));
    host.commands.register({ id: "daily.yesterday", title: "Yesterday's note", group: "Navigation", run: () => step(todayHere(), -1) });
    host.commands.register({ id: "daily.tomorrow", title: "Tomorrow's note", group: "Navigation", run: () => step(todayHere(), 1) });
    host.commands.register({ id: "daily.previous", title: "Previous day", group: "Navigation", run: () => void dayInFront(host).then((day) => step(day, -1)) });
    host.commands.register({ id: "daily.next", title: "Next day", group: "Navigation", run: () => void dayInFront(host).then((day) => step(day, 1)) });
    host.editorExtensions.register({ id: "daily.steps", extension: (editor) => (editor.reading ? [] : dayStepper(editor.noteId, (noteId, day) => isDaily(host, noteId, day), step)) });
  },
};
