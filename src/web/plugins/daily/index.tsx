import { useEffect, useState } from "react";
import { DAILY_SETTINGS, today, type App, type Plugin, type PluginHost } from "../../plugin-api.ts";

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
      description: "A time zone by its IANA name, such as America/Chicago. It says what day it is when an agent completes a todo or opens a daily note without saying the day. The app itself always uses this browser's day. Empty is UTC.",
    },
  },
  activate(host) {
    host.views.register("page", { id: "today", path: PATH, label: "Today", icon: "today", nav: "primary", order: 35, component: ({ app }) => <Today host={host} app={app} /> });
    host.commands.register({ id: "daily.today", title: "Open today's daily note", run: () => host.app().go(PATH) });
  },
};
