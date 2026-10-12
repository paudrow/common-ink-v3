import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthorRef, PluginHost, Resolve, RevertPreview } from "../../plugin-api.ts";
import { RevertChanges, RevertDialog, useRevertPreview } from "./RevertDialog.tsx";

interface Props {
  host: PluginHost;
  author: AuthorRef;
  name: string;
  /** Where the changes are, as a sentence ends: "in Acme", "in the 2 notes chosen". */
  where: string;
  /** Only these notes; every note in the workspace when left out. */
  noteIds?: string[];
  /** What this leaves untouched that the member might take it to cover, said when asking and after. */
  beyond?: string;
  /** Changes when the workspace's notes do, so a preview on show is worked out again. */
  version?: number;
  /** Called once notes have changed, so they are read again. */
  onReverted: () => void;
}

const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
const list = new Intl.ListFormat("en", { type: "conjunction" });

/** As many notes as one request names. An author who changed more has the rest reverted unseen, and the dialog says so. */
const MOST_NOTES = 100;

interface NotePreview {
  noteId: string;
  title: string;
  /** Null when this note's preview couldn't be read. The revert passes over a note it can't change, so the others are still shown. */
  preview: RevertPreview | null;
}

type Previewed = { state: "reading" } | { state: "read"; notes: NotePreview[]; more: boolean } | { state: "failed"; message: string };

/** What reverting the author would do to each note they changed, a few notes at a time, leaving out the notes it wouldn't change. */
async function previewOf(host: PluginHost, author: AuthorRef, noteIds: string[] | undefined): Promise<{ notes: NotePreview[]; more: boolean }> {
  const { notes, next } = await host.perform({ type: "history.summary", authors: [author], noteIds, limit: MOST_NOTES });
  const previews: NotePreview[] = [];
  for (let i = 0; i < notes.length; i += 4) {
    const some = notes.slice(i, i + 4);
    const read = await Promise.all(some.map((n) => host.perform({ type: "note.previewRevert", id: n.noteId, author }).catch(() => null)));
    previews.push(...some.map((n, j) => ({ noteId: n.noteId, title: n.noteTitle || "Untitled", preview: read[j]! })));
  }
  return { notes: previews.filter((n) => n.preview === null || n.preview.revisions.length > 0), more: next !== null };
}

/** How each note's conflicts are settled, by note id. A note with every later edit kept isn't named. */
type Resolves = Record<string, Resolve>;

interface NoteRevertProps {
  host: PluginHost;
  author: AuthorRef;
  noteId: string;
  first: RevertPreview;
  /** Told whether what is shown for this note is what the revert would do to it, and how its conflicts are settled when any later edit isn't kept. */
  onSettle: (noteId: string, settled: boolean, resolve: Resolve | null) => void;
}

/** What reverting the author would do to one note, with each of its conflicts to settle. */
function NoteRevert({ host, author, noteId, first, onSettle }: NoteRevertProps) {
  const asked = JSON.stringify(author);
  const read = useCallback((resolve?: Resolve) => host.perform({ type: "note.previewRevert", id: noteId, author: JSON.parse(asked) as AuthorRef, ...(resolve && { resolve }) }), [host, noteId, asked]);
  const previewed = useRevertPreview(read, undefined, first);
  const { resolve } = previewed;
  // A note whose preview can no longer be read is reverted with every later edit kept, as one that never could be is, and doesn't hold up the others.
  const settled = previewed.settled || (!previewed.state.preview && !previewed.state.reading);
  // Every later edit kept is what the revert does unasked, and asks nothing of the note staying as it was read.
  const sent = resolve && (typeof resolve.choices === "string" || resolve.choices.some((choice) => choice !== "keep")) ? JSON.stringify(resolve) : null;
  useEffect(() => {
    onSettle(noteId, settled, sent ? (JSON.parse(sent) as Resolve) : null);
    return () => onSettle(noteId, true, null);
  }, [onSettle, noteId, settled, sent]);
  return (
    <>
      {previewed.state.error && (
        <p role="alert" className="error">
          {previewed.state.error}
        </p>
      )}
      <RevertChanges revert={previewed} heading="h4" />
    </>
  );
}

interface AuthorRevertProps extends Pick<Props, "host" | "author" | "name" | "where" | "noteIds" | "beyond" | "version"> {
  title: string;
  onRevert: (resolve: Resolves) => void;
  onClose: () => void;
}

/** What reverting an author would do, note by note, shown before it is done. */
function AuthorRevert({ host, author, name, where, noteIds, beyond, version, title, onRevert, onClose }: AuthorRevertProps) {
  const [previewed, setPreviewed] = useState<Previewed>({ state: "reading" });
  const [resolves, setResolves] = useState<Resolves>({});
  const [unsettled, setUnsettled] = useState<readonly string[]>([]);
  const settle = useCallback((noteId: string, settled: boolean, resolve: Resolve | null) => {
    setUnsettled((was) => (was.includes(noteId) === !settled ? was : settled ? was.filter((id) => id !== noteId) : [...was, noteId]));
    setResolves(({ [noteId]: _, ...others }) => (resolve ? { ...others, [noteId]: resolve } : others));
  }, []);
  const asked = JSON.stringify({ author, noteIds });
  useEffect(() => {
    let live = true;
    const { author, noteIds } = JSON.parse(asked) as { author: AuthorRef; noteIds?: string[] };
    previewOf(host, author, noteIds).then(
      (read) => live && setPreviewed({ state: "read", ...read }),
      (err: Error) => live && setPreviewed({ state: "failed", message: err.message }),
    );
    return () => {
      live = false;
    };
  }, [host, asked, version]);

  const read = previewed.state === "read" ? previewed : null;
  const seen = read?.notes.flatMap((n) => (n.preview ? [n.preview] : [])) ?? [];
  const changes = seen.reduce((sum, preview) => sum + preview.revisions.length, 0);
  return (
    <RevertDialog title={title} ready={read !== null && (read.notes.length > 0 || read.more)} settled={!unsettled.length} onRevert={() => onRevert(resolves)} onClose={onClose}>
      {previewed.state === "reading" && <p className="diff-none">Working out what this would change…</p>}
      {previewed.state === "failed" && (
        <p role="alert" className="error">
          {previewed.message}
        </p>
      )}
      {read &&
        (read.notes.length ? (
          <p>
            Reverts {count(changes, "change")} {name} made {where} that still {changes === 1 ? "stands" : "stand"}, in {count(seen.length, "note")}. Everyone else's changes are kept. Each note gets one new change by you, which can be
            reverted too. {beyond}
          </p>
        ) : (
          <p>
            Nothing by {name} still stands {where}
            {read.more ? " in the notes looked at" : ""}. {beyond}
          </p>
        ))}
      {read && read.notes.length > 0 && (
        <ul className="revert-notes" aria-label="Notes this would change">
          {read.notes.map(({ noteId, title, preview }) => (
            <li key={noteId} aria-label={title}>
              <h3>
                {title} {preview && <span className="revert-note-count">{count(preview.revisions.length, "change")}</span>}
              </h3>
              {!preview ? (
                <p className="diff-none">What this would change here couldn't be worked out just now. {name}'s changes to it are reverted all the same.</p>
              ) : (
                <NoteRevert host={host} author={author} noteId={noteId} first={preview} onSettle={settle} />
              )}
            </li>
          ))}
        </ul>
      )}
      {read?.more && (
        <p className="revert-more">
          {name} changed more notes than the {MOST_NOTES} looked at here. The rest are reverted too, without being shown.
        </p>
      )}
    </RevertDialog>
  );
}

/** Reverts one author's changes and keeps everyone else's, after showing what that would change. */
export function RevertAuthor({ host, author, name, where, noteIds, beyond, version, onReverted }: Props) {
  const button = useRef<HTMLButtonElement>(null);
  const [step, setStep] = useState<"idle" | "asking" | "busy">("idle");
  const [said, say] = useState<{ text: string; failed?: boolean } | null>(null);
  const title = `Revert ${name}'s changes`;

  const run = async (resolve: Resolves) => {
    setStep("busy");
    try {
      const done = { notes: 0, changes: 0, emptied: [] as string[], failed: [] as { title: string; message: string }[] };
      // A few notes are covered a request, so it is asked again until every note has been.
      for (let after: string | undefined, more = true; more; ) {
        const { reverted, emptied, failed, next } = await host.perform({ type: "history.revertAuthor", author, noteIds, after, resolve });
        done.notes += reverted.length;
        for (const { revisions } of reverted) done.changes += revisions.length;
        done.emptied.push(...emptied.map((e) => e.title));
        done.failed.push(...failed);
        more = next !== null;
        after = next ?? undefined;
      }
      const took = done.notes ? `Reverted ${count(done.changes, "change")} by ${name} in ${count(done.notes, "note")}.` : done.failed.length ? "" : `Nothing by ${name} still stands ${where}.`;
      const empty = done.emptied.length ? `${list.format(done.emptied.map((title) => title || "Untitled"))} ${done.emptied.length === 1 ? "is now empty. It" : "are now empty. They"} can be deleted once Trash exists.` : "";
      const left = done.failed.map((f) => `${f.title || "Untitled"} was left as it is: ${f.message}.`);
      say({ text: [took, empty, ...left, beyond].filter(Boolean).join(" "), failed: left.length > 0 });
      if (done.notes) onReverted();
    } catch (err) {
      say({ text: (err as Error).message, failed: true });
      onReverted();
    }
    setStep("idle");
    // The button was disabled while the dialog closed, so focus couldn't go back to it then.
    requestAnimationFrame(() => button.current?.focus());
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className="button small"
        disabled={step === "busy"}
        onClick={() => {
          say(null);
          setStep("asking");
        }}
      >
        {step === "busy" ? "Reverting…" : `${title}…`}
      </button>
      {step === "asking" && <AuthorRevert host={host} author={author} name={name} where={where} noteIds={noteIds} beyond={beyond} version={version} title={title} onRevert={run} onClose={() => setStep("idle")} />}
      {said && (
        <span role={said.failed ? "alert" : "status"} className={said.failed ? "said failed" : "said"}>
          {said.text}
        </span>
      )}
    </>
  );
}
