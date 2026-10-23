import { useEffect, useId, useRef, useState } from "react";
import { MAX_NOTES_AT_ONCE, nameKey, type App, type DeletedTag, type Notice, type PluginHost } from "../../plugin-api.ts";
import { notes } from "./renaming.ts";
import type { TagStore } from "./Tags.tsx";

/** The title of the dialog, from a preview of the delete. */
export function deleteTitle(plan: DeletedTag): string {
  if (plan.deleted.length) return `Delete #${plan.name} from ${notes(plan.deleted.length)}?`;
  if (plan.skipped) return `You can't delete #${plan.name}`;
  return plan.descriptions.length || plan.under.length ? `Delete #${plan.name}?` : `No note has #${plan.name}`;
}

/** What the notice after a delete says it did. */
export function deletedWords(done: DeletedTag): string {
  const failed = done.failed ? ` ${notes(done.failed)} couldn't be changed and ${done.failed === 1 ? "keeps" : "keep"} it.` : "";
  return `Deleted #${done.name}${done.deleted.length ? ` from ${notes(done.deleted.length)}` : ""}.${failed}`;
}

/**
 * Takes a delete back: each note's change is reverted, as many at once as a revert takes, and each
 * description the delete took is said again. A note changed since keeps its change, and the notice says how many.
 */
export async function undoDelete(host: PluginHost, done: DeletedTag): Promise<Notice> {
  let kept = 0;
  for (let at = 0; at < done.deleted.length; at += MAX_NOTES_AT_ONCE) {
    const some = done.deleted.slice(at, at + MAX_NOTES_AT_ONCE);
    const { skipped } = await host.perform({ type: "history.revert", changes: some.map((note) => ({ noteId: note.noteId, revisions: [note.revision] })) });
    kept += skipped.length;
  }
  for (const { name, description } of done.descriptions) await host.perform({ type: "tag.describe", name, description });
  return { message: kept ? `#${done.name} is back, but ${notes(kept)} changed since and ${kept === 1 ? "doesn't have" : "don't have"} it` : `#${done.name} is back` };
}

/** Which descriptions go with the tag, said by the tags they are of. */
function described(plan: DeletedTag): string | null {
  const said = plan.descriptions.filter((d) => d.description).map((d) => `#${d.name}`);
  if (!said.length) return null;
  if (said.length === 1 && nameKey(said[0]!) === nameKey(`#${plan.name}`)) return "Its description goes with it.";
  return `The ${said.length === 1 ? "description" : "descriptions"} of ${said.length === 1 ? said[0] : `${said.slice(0, -1).join(", ")} and ${said.at(-1)}`} ${said.length === 1 ? "goes" : "go"} too.`;
}

interface Props {
  host: PluginHost;
  app: App;
  store: TagStore;
  name: string;
  /** Called once, when it closes: whether the tag is gone, which it isn't while a note the member can't change keeps it. */
  onClose: (deleted: boolean) => void;
}

/**
 * Asks before a tag is deleted, over the page, from the preview of the delete: the notes it changes,
 * the tags under it that go with it, and the notes the member can't change, which keep it. Cancel has
 * the keyboard first, and Escape cancels. Delete writes it, and the notice after has Undo.
 */
export function DeleteTagDialog({ host, app, store, name, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const ids = useId();
  const [plan, setPlan] = useState<DeletedTag | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const focused = document.activeElement;
    const modal = dialog.current!;
    modal.showModal();
    cancel.current!.focus();
    let live = true;
    host.perform({ type: "tag.delete", name, preview: true }).then(
      (answer) => live && setPlan(answer),
      (err: unknown) => live && setProblem(err instanceof Error ? err.message : "The tag couldn't be read. Try again."),
    );
    return () => {
      live = false;
      modal.close();
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
    };
  }, []);

  const run = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const done = await host.perform({ type: "tag.delete", name });
      await store.reload();
      app.notify({
        message: deletedWords(done),
        icon: "tag",
        action: {
          label: "Undo",
          run: () =>
            undoDelete(host, done).then(
              async (notice) => (await store.reload(), notice),
              (err: unknown) => ({ message: err instanceof Error ? err.message : "The delete couldn't be undone." }),
            ),
        },
      });
      onClose(done.skipped === 0 && done.failed === 0);
    } catch (err) {
      setBusy(false);
      setProblem(err instanceof Error ? err.message : "That didn't go through. Try again.");
    }
  };

  // A tag only notes the member can't change have stays, and so does what is said of it: there is nothing to delete.
  const can = !!plan && (plan.deleted.length > 0 || (plan.skipped === 0 && (plan.descriptions.length > 0 || plan.under.length > 0)));
  const one = plan?.skipped === 1;
  return (
    <dialog
      ref={dialog}
      className="trust-dialog tag-delete-dialog"
      aria-labelledby={`${ids}-title`}
      aria-describedby={`${ids}-what`}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose(false);
      }}
      onKeyDown={(e) => {
        // Escape is this dialog's alone, and not that of Settings or anything else it is drawn in.
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        if (!busy) onClose(false);
      }}
    >
      <div className="trust-dialog-body">
        <h2 id={`${ids}-title`}>{plan ? deleteTitle(plan) : `Delete #${name}`}</h2>
        <div id={`${ids}-what`} className="tag-delete-what">
          {!plan && !problem && <p role="status">Finding the notes with #{name}…</p>}
          {plan && plan.deleted.length > 0 && (
            <>
              <p>
                At the end of a line, among its tags, #{plan.name} is taken out. In a sentence it stays as a word: “the #{plan.name} plan” becomes “the {plan.name.split("/").at(-1)} plan”.
              </p>
              <ul className="tag-delete-notes" aria-label="Notes it changes">
                {plan.deleted.map((note) => (
                  <li key={note.noteId}>{note.noteTitle || "Untitled"}</li>
                ))}
              </ul>
            </>
          )}
          {plan && plan.under.length > 0 && (
            <p>
              {plan.under.length === 1 ? "The tag under it goes too: " : `The ${plan.under.length} tags under it go too: `}
              {plan.under.map((tag) => `#${tag}`).join(", ")}.
            </p>
          )}
          {plan && described(plan) && <p>{described(plan)}</p>}
          {plan && plan.skipped > 0 && (
            <p>
              {plan.deleted.length ? `${notes(plan.skipped)} you can't edit ${one ? "keeps" : "keep"} it, ` : `${one ? "The note" : `All ${notes(plan.skipped)}`} with it ${one ? "is one" : "are ones"} you can't edit, `}
              such as a note shared with you only to view. The tag stays in the sidebar for {one ? "that note" : "those notes"}.
            </p>
          )}
          {plan && plan.deleted.length > 0 && <p>Each note's history has the change, labeled “Deleted #{plan.name}”, and Undo puts them all back.</p>}
          {problem && (
            <p role="alert" className="error">
              {problem}
            </p>
          )}
        </div>
        <div className="trust-actions">
          {plan && can && (
            <button type="button" className="button small danger" aria-disabled={busy || undefined} onClick={() => !busy && void run()}>
              {plan.deleted.length ? `Delete from ${notes(plan.deleted.length)}` : "Delete tag"}
            </button>
          )}
          <button ref={cancel} type="button" className="link" disabled={busy} onClick={() => onClose(false)}>
            {can || !plan ? "Cancel" : "Close"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
