import { useEffect, useState } from "react";
import type { NoteSummary, PluginHost, Sharing, ViewProps } from "../../plugin-api.ts";
import { summaryOf } from "./words.ts";

/** The Sharing plugin's command and overlay, which are there while that plugin is on. */
export const SHARE_COMMAND = "sharing.share";
export const SHARE_OVERLAY = "share";

type Found = { noteId: string; sharing: Sharing } | { noteId: string; error: string };

/** How the open note is shared, in a line, with a button that opens the Share dialog for whoever may change it. */
export function SharingSummary({ host, app, note }: ViewProps & { host: PluginHost; note: NoteSummary }) {
  const [found, setFound] = useState<Found | null>(null);
  // Read again when the notes are, which the Share dialog asks for after each change it makes.
  useEffect(() => {
    let live = true;
    host.sharing.of({ noteId: note.id }).then(
      (sharing) => live && setFound({ noteId: note.id, sharing }),
      (err: Error) => live && setFound({ noteId: note.id, error: err.message }),
    );
    return () => {
      live = false;
    };
  }, [host, note.id, app.notes]);

  if (found?.noteId !== note.id) return null;
  if ("error" in found) return <span role="alert" className="error">{found.error}</span>;
  const { sharing } = found;
  const canChange = sharing.canShare || sharing.note?.canSetPrivate;
  return (
    <>
      <span>{summaryOf(sharing, note.access)}</span>
      {canChange && host.commands.list().some((c) => c.id === SHARE_COMMAND) && (
        <button type="button" className="button small" onClick={() => app.toggleOverlay(SHARE_OVERLAY, { noteId: note.id })}>
          Share
        </button>
      )}
    </>
  );
}
