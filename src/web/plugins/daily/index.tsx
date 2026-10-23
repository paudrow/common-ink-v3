import { useEffect, useState } from "react";
import { DAILY_FOLDER, DAILY_SETTINGS, type App, type Opened, type Plugin, type PluginHost } from "../../plugin-api.ts";
import { browserZone, dayTitled, todayIn, toward } from "./days.ts";
import { openDay, todaysNote } from "./opening.ts";
import { dayStepper } from "./steps.ts";

const PATH = "/today";

/** Where Today leads, whether gone to or dropped on a group: today's daily note. */
const todaysPage = (host: PluginHost): Promise<Opened> => todaysNote(host).then((note) => ({ kind: "note", id: note.id }));

/** Shows today's daily note in place of this page, so Back goes to where the member was before and not through here again. */
function Today({ host, app }: { host: PluginHost; app: App }) {
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    todaysPage(host).then(
      (note) => {
        if (stale) return;
        app.show(note, { replace: true });
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
      type: "folder",
      default: folder.default,
      defaultFolder: DAILY_FOLDER,
      title: "Daily notes folder",
      description: `The folder a new daily note is made in, from the folders you can edit. ${DAILY_FOLDER}, at the top of the workspace, is made when it isn't there. Changing this leaves the daily notes already made where they are.`,
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
      title: "Time zone override",
      description: "A time zone by its IANA name, such as America/Chicago, to use in place of the one Common Ink finds. It says what day it is when an agent completes a todo or opens a daily note without saying the day, and agents are given times in it. The app itself always uses this browser's day. Empty is the time zone of the browser you last used Common Ink in.",
    },
  },
  activate(host) {
    host.views.register("page", { id: "today", path: PATH, label: "Today", description: "Today's daily note, made the first time you open it.", icon: "today", nav: "primary", order: 25, transient: () => todaysPage(host), component: ({ app }) => <Today host={host} app={app} /> });
    host.commands.register({ id: "daily.today", title: "Open today's daily note", group: "Navigation", run: () => host.app().go(PATH) });
    const step = (from: string, by: number) => void openDay(host, toward(from, by, todayHere()));
    host.commands.register({ id: "daily.yesterday", title: "Yesterday's note", group: "Navigation", run: () => step(todayHere(), -1) });
    host.commands.register({ id: "daily.tomorrow", title: "Tomorrow's note", group: "Navigation", run: () => step(todayHere(), 1) });
    host.commands.register({ id: "daily.previous", title: "Previous day", group: "Navigation", run: () => void dayInFront(host).then((day) => step(day, -1)) });
    host.commands.register({ id: "daily.next", title: "Next day", group: "Navigation", run: () => void dayInFront(host).then((day) => step(day, 1)) });
    host.editorExtensions.register({ id: "daily.steps", extension: (editor) => (editor.reading ? [] : dayStepper(editor.noteId, (noteId, day) => isDaily(host, noteId, day), step)) });
  },
};
