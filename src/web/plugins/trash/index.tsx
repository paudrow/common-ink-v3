import { Icon, useNow, type NoteSummary, type Plugin, type PluginHost, type ViewProps } from "../../plugin-api.ts";
import { lifecycle, mayPurge } from "../lib/lifecycle.ts";
import { daysLeft, leftSentence } from "./days.ts";
import { Purge } from "./Purge.tsx";
import { TrashPage } from "./TrashPage.tsx";

type NoteView = ViewProps & { host: PluginHost; note: NoteSummary };

/** Said quietly under an archived note's title, with the way back. */
function ArchivedMark({ host, note }: NoteView) {
  if (note.state !== "archived") return null;
  return (
    <span className="state-mark">
      Archived
      {note.access === "edit" && (
        <>
          <span aria-hidden="true">·</span>
          <button type="button" className="link" onClick={() => void lifecycle(host).setArchived(note.id, false)}>
            Unarchive
          </button>
        </>
      )}
    </span>
  );
}

/** The open note's Archive button, beside its "…" and Focus: archiving gets a note out of the way. For an archived note it is Unarchive, with an icon of its own. */
function ArchiveButton({ host, note }: NoteView) {
  if (note.access !== "edit" || note.state === "trashed") return null;
  const archived = note.state === "archived";
  const label = archived ? "Unarchive" : "Archive";
  const keys = host.commands.list().find((c) => c.id === ARCHIVE_COMMAND)?.shortcut;
  return (
    <button type="button" className="icon-button" aria-label={label} title={keys ? `${label} (${keys})` : label} onClick={() => void lifecycle(host).setArchived(note.id, !archived)}>
      <Icon name={archived ? "unarchive" : "archive"} />
    </button>
  );
}

const ARCHIVE_COMMAND = "note.toggleArchived";

function TrashBanner({ host, note }: NoteView) {
  const now = useNow();
  if (note.state !== "trashed") return null;
  const { restore, purge } = lifecycle(host);
  return (
    <div className="trash-banner" role="group" aria-label="In Trash">
      <span>This note is in Trash, where it can be read and not changed. {leftSentence(daysLeft(note.purgesAt ?? now, now))}</span>
      <button type="button" className="button small" disabled={note.access !== "edit"} onClick={() => void restore(note.id)}>
        Restore
      </button>
      {mayPurge(host, note) && <Purge title={note.title} onPurge={() => purge(note.id)} />}
    </div>
  );
}

/**
 * A note's life after it is written: archived and brought back, moved to Trash and restored, and
 * removed from Trash for good. The open note says where it is, and Trash has a page of its own.
 */
export const trash: Plugin = {
  id: "trash",
  name: "Archive and Trash",
  description: "Archives a note out of the way, and keeps a deleted one in Trash for 30 days to restore.",
  icon: "trash",
  activate(host) {
    const { setArchived, trash: moveToTrash } = lifecycle(host);
    /** The open note, when the member may change it. Otherwise they are told why nothing happened. */
    const open = () => {
      const app = host.app();
      if (!app.note) app.notify({ message: "Open a note first." });
      else if (app.note.access !== "edit") app.notify({ message: "You can read this note, and not change it." });
      else if (app.note.state === "trashed") app.notify({ message: "This note is in Trash. Restore it to change it." });
      else return app.note;
      return null;
    };

    host.commands.register({
      id: ARCHIVE_COMMAND,
      title: "Archive or unarchive note",
      group: "Notes",
      // Free in Chrome and Safari, in the editor's own keys, and in vim mode, which has no Ctrl+Shift keys.
      keys: ["mod+shift+e"],
      run() {
        const note = open();
        if (note) void setArchived(note.id, note.state !== "archived");
      },
    });
    host.commands.register({
      id: "note.trash",
      title: "Move note to Trash",
      group: "Notes",
      run() {
        const note = open();
        if (note) void moveToTrash(note.id);
      },
    });

    host.views.register("mark", { id: "archived", component: (props) => <ArchivedMark host={host} {...props} /> });
    host.views.register("tool", { id: "archive", component: (props) => <ArchiveButton host={host} {...props} /> });
    host.views.register("notice", { id: "trashed", component: (props) => <TrashBanner host={host} {...props} /> });
    // Under More, and with no order so that it comes after the modes there: it is where notes go, not a way to work.
    host.views.register("page", { id: "trash", path: "/trash", label: "Trash", description: "Notes deleted in the last 30 days, to put back or delete for good.", icon: "trash", nav: "more", component: (props) => <TrashPage host={host} {...props} /> });
  },
};
