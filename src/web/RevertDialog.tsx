import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import { MAX_NOTES_AT_ONCE, type Author, type Diff, type NoteRevertPreview, type OpInput, type Resolve, type RevertConflict, type RevertedNotes } from "../core/protocol.ts";
import { ApiError, perform } from "./api.ts";
import { useDismiss } from "./dismiss.ts";
import { DiffView, Stat } from "./HistoryDiff.tsx";
import { authorKey, count, titleOf } from "./historyView.ts";
import { commitTyping, revertMany } from "./sync.ts";

/** One note's revert as it is asked for: of some of its changes, or of the note to a revision. */
export interface RevertAsk {
  noteId: string;
  title: string;
  revisions?: number[];
  to?: number;
}

type Item = Extract<OpInput, { type: "history.revert" }>["changes"][number];

/** What becomes of one conflict: the later edits kept, the lines as they were before, or lines typed by hand. */
type Choice = Exclude<Resolve["choices"], string>[number];

const CHOICES = [
  ["keep", "Keep the later edit"],
  ["back", "Go back to how it was"],
  ["edit", "Edit"],
] as const;

/** A choice as it is picked: Edit asks for the lines to be typed, before any are. */
type Picked = Choice | "edit";

/** The lines a choice leaves, each without its line end. Typed text is read as the server reads it, so lines joined by line ends come back as the same lines. */
const leaves = (conflict: RevertConflict, choice: Choice) => (choice === "keep" ? conflict.kept : choice === "back" ? conflict.before : choice.text ? choice.text.split("\n") : []);

const nameOf = (author: Author) => (author.kind === "agent" ? `${author.name} (agent)` : author.name);

function Lines({ lines }: { lines: string[] }) {
  if (!lines.length) return <span className="conflict-none">No line here</span>;
  return lines.map((line, i) => (
    <span key={i} className="diff-text">
      {line || " "}
    </span>
  ));
}

/** Who edited a conflict's lines later. */
function later(conflict: RevertConflict): string {
  const names = [...new Map(conflict.later.map(({ author }) => [authorKey(author), nameOf(author)])).values()];
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
}

interface ConflictsProps {
  conflicts: RevertConflict[];
  /** One for each conflict, in their order. */
  choices: Choice[];
  onChoose: (at: number | "all", choice: Picked) => void;
}

/** Each place a later change edited lines the revert changes: its lines before and now, who edited them, and the choice of what they become. */
function Conflicts({ conflicts, choices, onChoose }: ConflictsProps) {
  const ids = useId();
  return (
    <div className="conflicts">
      <p>{conflicts.length === 1 ? "A later change edited a place this revert changes. Choose what it becomes." : `Later changes edited ${conflicts.length} places this revert changes. Choose what each becomes.`}</p>
      {conflicts.length > 1 && (
        <div className="conflicts-all">
          <button type="button" className="button small" onClick={() => onChoose("all", "keep")}>
            Keep all later edits
          </button>
          <button type="button" className="button small" onClick={() => onChoose("all", "back")}>
            Go back on all
          </button>
        </div>
      )}
      {/* The role is spelled out because a list with no markers isn't read as one everywhere. */}
      <ol role="list" aria-label="Conflicts">
        {conflicts.map((conflict, i) => {
          const choice = choices[i] ?? "keep";
          const made = typeof choice === "string" ? choice : "edit";
          const id = `${ids}-${i}`;
          return (
            <li key={i} className="conflict">
              <h4 id={`${id}-name`}>
                Conflict {i + 1} of {conflicts.length}, line {conflict.line}
              </h4>
              <dl id={`${id}-sides`}>
                <dt>Before</dt>
                <dd className="conflict-lines">
                  <Lines lines={conflict.before} />
                </dd>
                <dt>Now, edited by {later(conflict)}</dt>
                <dd className="conflict-lines now">
                  <Lines lines={conflict.now} />
                </dd>
              </dl>
              <div role="radiogroup" className="conflict-choices" aria-labelledby={`${id}-name`} aria-describedby={`${id}-sides`}>
                {CHOICES.map(([value, name]) => (
                  <label key={value}>
                    <input type="radio" name={id} checked={made === value} onChange={() => onChoose(i, value)} />
                    {name}
                  </label>
                ))}
              </div>
              <div className="conflict-after">
                <span id={`${id}-after`}>After the revert</span>
                {typeof choice === "string" ? (
                  <output className="conflict-lines after" aria-labelledby={`${id}-after`}>
                    <Lines lines={leaves(conflict, choice)} />
                  </output>
                ) : (
                  <textarea
                    className="conflict-typed"
                    aria-label={`Lines for conflict ${i + 1}`}
                    rows={Math.max(2, choice.text.split("\n").length)}
                    spellCheck={false}
                    value={choice.text}
                    onChange={(e) => onChoose(i, { text: e.target.value })}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** One note's revert as the dialog holds it. */
interface Previewed {
  /** Null until the preview is read, and when it can't be. */
  preview: NoteRevertPreview | null;
  /** One for each of the preview's conflicts, in their order. */
  choices: Choice[];
  /** What was last typed for each conflict, which Edit starts from again. Null where nothing was. */
  drafts: (string | null)[];
  /** What the revert would change, as last worked out. */
  diff: Diff | null;
  /** Whether `diff` is of `choices`. If not, it is to be asked for now, or soon, once the typing pauses, or asking for it failed and it waits for the next choice. */
  diffIs: "current" | "due" | "due soon" | "refused";
  /** Whether the preview is being read, for the first time or again. */
  reading: boolean;
  /** Whether choices made were lost to the note changing. */
  startedOver: boolean;
  error: string | null;
}

type PreviewEvent =
  | { type: "reading" }
  | { type: "read"; preview: NoteRevertPreview }
  | { type: "unreadable"; message: string }
  | { type: "unreached"; message: string }
  | { type: "chose"; at: number | "all"; choice: Picked }
  | { type: "settled"; choices: Choice[]; diff: Diff }
  | { type: "refused"; message: string };

const NOT_READ: Previewed = { preview: null, choices: [], drafts: [], diff: null, diffIs: "current", reading: true, startedOver: false, error: null };

function previewing(state: Previewed, event: PreviewEvent): Previewed {
  switch (event.type) {
    case "reading":
      return { ...state, reading: true };
    case "read":
      // The same revision has the same conflicts, so what was chosen and typed for them stands.
      if (state.preview?.revision === event.preview.revision) return { ...state, reading: false };
      return {
        preview: event.preview,
        choices: event.preview.conflicts.map(() => "keep"),
        drafts: event.preview.conflicts.map(() => null),
        diff: event.preview.diff,
        diffIs: "current",
        reading: false,
        startedOver: state.startedOver || state.choices.some((choice) => choice !== "keep"),
        // A refusal stays to explain why the choices started over; a preview that couldn't be read is behind us.
        error: state.preview ? state.error : null,
      };
    case "unreadable":
      return { ...NOT_READ, reading: false, error: event.message };
    case "unreached":
      return { ...(state.preview ? state : NOT_READ), reading: false, error: event.message };
    case "chose": {
      const { preview } = state;
      if (!preview) return state;
      const { at, choice } = event;
      const choices = state.choices.map((was, i) => {
        if (at !== "all" && at !== i) return was;
        return choice === "edit" ? { text: state.drafts[i] ?? leaves(preview.conflicts[i]!, was).join("\n") } : choice;
      });
      const typed = typeof choice === "object";
      const drafts = typed ? state.drafts.map((was, i) => (at === "all" || at === i ? choice.text : was)) : state.drafts;
      const kept = choices.every((made) => made === "keep");
      return { ...state, choices, drafts, diff: kept ? preview.diff : state.diff, diffIs: kept ? "current" : typed ? "due soon" : "due", startedOver: false, error: null };
    }
    case "settled":
      return event.choices === state.choices ? { ...state, diff: event.diff, diffIs: "current" } : state;
    case "refused":
      // A diff that was of the choices still is if the note hasn't changed. One that was being asked for isn't asked for again by itself, or a refusal of what was typed would be asked for without end.
      return { ...state, diffIs: state.diffIs === "current" ? "current" : "refused", reading: true, error: event.message };
  }
}

/** Every note of the revert, by its id. */
type Notes = ReadonlyMap<string, Previewed>;
type NotesEvent = { noteIds: readonly string[]; event: PreviewEvent } | { type: "only"; noteIds: readonly string[] };

function previewingNotes(state: Notes, action: NotesEvent): Notes {
  if ("type" in action) return new Map(action.noteIds.map((id) => [id, state.get(id) ?? NOT_READ]));
  const next = new Map(state);
  for (const id of action.noteIds) next.set(id, previewing(state.get(id) ?? NOT_READ, action.event));
  return next;
}

const TYPING_PAUSE_MS = 300;
/** As many notes as the dialog draws at first, and with each "Show more". */
const NOTES_SHOWN = 8;

/** What a revert's diff comes to, as a sentence. */
function tally({ added, removed }: Diff) {
  const does = [added > 0 && `adds ${count(added, "line")}`, removed > 0 && `removes ${count(removed, "line")}`].filter(Boolean).join(" and ") || "changes nothing";
  return `${does[0]!.toUpperCase()}${does.slice(1)}.`;
}

const itemOf = (ask: RevertAsk): Item => (ask.to !== undefined ? { noteId: ask.noteId, to: ask.to } : { noteId: ask.noteId, revisions: ask.revisions! });

function chunks<T>(all: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < all.length; i += size) out.push(all.slice(i, i + size));
  return out;
}

/** Whether the server said no, as it does to a revert there is no making, and not that it couldn't be reached. */
const saidNo = (err: unknown) => err instanceof ApiError && err.status < 500;

interface NoteRevertProps {
  workspaceId: string;
  ask: RevertAsk;
  state: Previewed;
  dispatch: (event: PreviewEvent) => void;
  /** Reads this note's preview again, after a refusal. */
  onRefused: (message: string) => void;
}

/** One note of a revert: what it would change, and its conflicts with the choice of how each is settled. */
function NoteRevert({ workspaceId, ask, state, dispatch, onRefused }: NoteRevertProps) {
  const ids = useId();
  const { preview, choices, diff, diffIs, reading } = state;
  const refused = useRef(onRefused);
  refused.current = onRefused;
  const item = useMemo(() => itemOf(ask), [ask]);

  useEffect(() => {
    if (!preview || reading || (diffIs !== "due" && diffIs !== "due soon")) return;
    let live = true;
    const timer = setTimeout(
      () =>
        perform(workspaceId, { type: "history.previewRevert", changes: [{ ...item, at: preview.revision, choices }] }).then(
          ([settled]) => live && (settled!.refused ? refused.current(settled!.refused) : dispatch({ type: "settled", choices, diff: settled!.diff })),
          (err: Error) => live && refused.current(err.message),
        ),
      diffIs === "due soon" ? TYPING_PAUSE_MS : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [workspaceId, item, preview, choices, diffIs, reading, dispatch]);

  const changesNothing = diff !== null && !diff.hunks.length;
  const readBefore = useCallback(async () => (await perform(workspaceId, { type: "note.read", id: ask.noteId, revision: preview?.revision })).text, [workspaceId, ask.noteId, preview?.revision]);
  return (
    <section className="revert-note" aria-labelledby={`${ids}-note`}>
      <div className="revert-note-head">
        <h3 id={`${ids}-note`}>{titleOf(preview?.noteTitle ?? ask.title)}</h3>
        {diff && !changesNothing && <Stat added={diff.added} removed={diff.removed} />}
      </div>
      {state.error && <p role="alert" className="error">{state.error}</p>}
      {preview?.refused && <p role="alert" className="error">{preview.refused}. This note is left out of the revert.</p>}
      {!preview && !state.error && <p className="diff-none">Working out what this would change…</p>}
      {preview && diff && !preview.refused && (
        <>
          {preview.already.length > 0 && <p className="revert-already">{preview.already.length === 1 ? "1 change picked was already reverted, and is left as it is." : `${preview.already.length} changes picked were already reverted, and are left as they are.`}</p>}
          {state.startedOver && <p className="revert-started-over">The note has changed, so the choices made here start over with every later edit kept.</p>}
          {preview.conflicts.length > 0 ? (
            <>
              <Conflicts conflicts={preview.conflicts} choices={choices} onChoose={(at, choice) => dispatch({ type: "chose", at, choice })} />
              <section className="revert-result" aria-labelledby={`${ids}-result`} aria-busy={reading || diffIs === "due" || diffIs === "due soon"}>
                <div className="revert-result-head">
                  <h4 id={`${ids}-result`}>This revert</h4>
                  <output aria-labelledby={`${ids}-result`}>{tally(diff)}</output>
                </div>
                {!changesNothing && <DiffView diff={diff} readBefore={readBefore} />}
              </section>
            </>
          ) : changesNothing ? (
            <p className="revert-nothing">{preview.revisions.length ? "Nothing in this note would change: what was picked comes to no change in its text." : "Nothing in this note would change."}</p>
          ) : (
            <DiffView diff={diff} readBefore={readBefore} />
          )}
        </>
      )}
    </section>
  );
}

interface RevertDialogProps {
  workspaceId: string;
  /** The notes to revert, each named once. */
  asks: RevertAsk[];
  /** Changes when any note does, so the previews are read again. */
  version: number;
  /** Called with what a revert did, each time one is made: the dialog stays open on the notes it skipped. */
  onReverted: (done: RevertedNotes) => void;
  onClose: () => void;
}

/**
 * What a revert would do, shown before it is made: for each note the lines it changes, each conflict
 * with a later change and the choice of how it is settled. Reverting makes one change in each note,
 * says which notes it reverted and which it left, and keeps the ones it left for another try.
 */
export function RevertDialog({ workspaceId, asks, version, onReverted, onClose }: RevertDialogProps) {
  const ids = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const inside = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  /** The notes still to revert: all of them, then the ones a revert skipped. */
  const [pending, setPending] = useState(asks);
  const [notes, dispatch] = useReducer(previewingNotes, new Map<string, Previewed>());
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reads, readAgain] = useState(0);
  const [showing, setShowing] = useState(NOTES_SHOWN);

  useDismiss(onClose, inside);
  useEffect(() => {
    const focused = document.activeElement;
    const modal = dialog.current!;
    modal.showModal();
    cancel.current!.focus();
    return () => {
      // While it is still open as a modal the rest of the page can't take focus.
      modal.close();
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
    };
  }, []);

  const latest = useRef(pending);
  latest.current = pending;
  useEffect(() => {
    let live = true;
    const wanted = latest.current;
    const noteIds = wanted.map((a) => a.noteId);
    dispatch({ type: "only", noteIds });
    dispatch({ noteIds, event: { type: "reading" } });
    void (async () => {
      // What is typed and not yet saved would change the note under the preview.
      await commitTyping(noteIds).catch(() => {});
      for (const part of chunks(wanted, MAX_NOTES_AT_ONCE)) {
        const ofPart = part.map((a) => a.noteId);
        try {
          const previews = await perform(workspaceId, { type: "history.previewRevert", changes: part.map(itemOf) });
          if (!live) return;
          for (const preview of previews) dispatch({ noteIds: [preview.noteId], event: { type: "read", preview } });
        } catch (err) {
          // Only the server saying no means there is no such revert to show. Not reaching it leaves what is shown.
          if (live) dispatch({ noteIds: ofPart, event: { type: saidNo(err) ? "unreadable" : "unreached", message: (err as Error).message } });
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [workspaceId, version, reads]);

  const states = pending.map((ask) => ({ ask, state: notes.get(ask.noteId) ?? NOT_READ }));
  const read = states.every(({ state }) => state.preview !== null);
  const changing = states.filter(({ state }) => state.diff?.hunks.length);
  const changesNothing = read && !changing.length;
  const ready = read && !busy && states.every(({ state }) => !state.reading && state.diffIs === "current");

  /** Set at once, where `busy` waits for the next drawing: a second press in the same moment must not send the revert again. */
  const sending = useRef(false);
  const revert = async () => {
    if (!ready || sending.current) return;
    sending.current = true;
    setBusy(true);
    setSaid(null);
    const done: RevertedNotes = { reverted: [], skipped: [] };
    const items = changing.map(({ ask, state }): Item => ({ ...itemOf(ask), at: state.preview!.revision, ...(state.preview!.conflicts.length ? { choices: state.choices } : {}) }));
    try {
      for (const part of chunks(items, MAX_NOTES_AT_ONCE)) {
        const made = await revertMany(workspaceId, part);
        done.reverted.push(...made.reverted);
        done.skipped.push(...made.skipped);
      }
    } catch (err) {
      // Whatever was not answered for is as it was: its preview is read again, and says so.
      const answered = new Set([...done.reverted, ...done.skipped].map((n) => n.noteId));
      for (const item of items) if (!answered.has(item.noteId)) done.skipped.push({ noteId: item.noteId, noteTitle: "", why: "refused", message: (err as Error).message });
    }
    if (done.reverted.length) onReverted(done);
    const left = done.skipped.filter((s) => s.why !== "nothing");
    if (!left.length) return onClose();
    const kept = pending.filter((ask) => left.some((s) => s.noteId === ask.noteId));
    setPending(kept);
    dispatch({ type: "only", noteIds: kept.map((a) => a.noteId) });
    for (const skipped of left) {
      const message = skipped.why === "changed" ? `${titleOf(skipped.noteTitle)} changed after this was worked out, so it was left as it is. This is its revert as it would be now.` : skipped.message;
      dispatch({ noteIds: [skipped.noteId], event: { type: "refused", message } });
    }
    setSaid(done.reverted.length ? `Reverted ${count(done.reverted.length, "note")}. ${count(left.length, "note")} ${left.length === 1 ? "was" : "were"} left as ${left.length === 1 ? "it is" : "they are"}, shown here again.` : null);
    readAgain((n) => n + 1);
    sending.current = false;
    setBusy(false);
  };

  const total = read ? changing.reduce((sum, { state }) => sum + state.preview!.revisions.length, 0) : pending.reduce((sum, ask) => sum + (ask.revisions?.length ?? 0), 0);
  const [first] = pending;
  const title = changesNothing
    ? "Revert: nothing would change"
    : pending.length === 1 && first
      ? first.to !== undefined
        ? `Revert ${titleOf(first.title)} to revision ${first.to}`
        : `Revert ${count(total || first.revisions!.length, "change")} to ${titleOf(first.title)}`
      : `Revert ${count(total, "change")} in ${count(read ? changing.length : pending.length, "note")}`;
  // The notes with something to settle come first, then the ones that change, then the ones that don't.
  const rank = ({ state }: (typeof states)[number]) => (state.error || state.preview?.refused ? 0 : state.preview?.conflicts.length ? 1 : state.diff?.hunks.length ? 2 : 3);
  const ordered = pending.length > 1 ? [...states].sort((a, b) => rank(a) - rank(b)) : states;
  const drawn = ordered.filter((s) => rank(s) < 3 || pending.length === 1).slice(0, showing);
  const unchanged = pending.length > 1 ? ordered.filter((s) => rank(s) === 3 && s.state.preview) : [];
  const more = ordered.filter((s) => rank(s) < 3).length - drawn.length;
  return (
    <dialog ref={dialog} className="revert-dialog" aria-labelledby={`${ids}-title`} onCancel={(e) => e.preventDefault()}>
      <div ref={inside} className="revert-dialog-body">
        <h2 id={`${ids}-title`}>{title}</h2>
        {said && <p role="status" className="revert-said">{said}</p>}
        {!changesNothing && <p className="revert-lead">{pending.length === 1 ? "This is recorded as one new change. Nothing is erased." : "Each note gets one new change. Nothing is erased."}</p>}
        {changesNothing && pending.length > 1 && <p className="revert-nothing">Nothing would change: everything picked was already reverted, or comes to no change.</p>}
        {drawn.map(({ ask, state }) => (
          <NoteRevert
            key={ask.noteId}
            workspaceId={workspaceId}
            ask={ask}
            state={state}
            dispatch={(event) => dispatch({ noteIds: [ask.noteId], event })}
            onRefused={(message) => {
              dispatch({ noteIds: [ask.noteId], event: { type: "refused", message } });
              readAgain((n) => n + 1);
            }}
          />
        ))}
        {more > 0 && (
          <button type="button" className="button small" onClick={() => setShowing(showing + NOTES_SHOWN)}>
            Show {Math.min(more, NOTES_SHOWN)} more of {count(more, "note")}
          </button>
        )}
        {unchanged.length > 0 && !changesNothing && (
          <p className="revert-unchanged">
            Nothing would change in {unchanged.map(({ ask, state }) => titleOf(state.preview?.noteTitle ?? ask.title)).join(", ")}: {unchanged.length === 1 ? "it is" : "they are"} left out of this revert.
          </p>
        )}
        <div className="revert-dialog-actions">
          <button ref={cancel} type="button" className="button small" onClick={onClose}>
            {said ? "Close" : "Cancel"}
          </button>
          {/* Not `disabled` while the diff catches up with a choice, so the button a Tab is headed for is still there. */}
          <button type="button" className="button small primary" disabled={busy || !read || changesNothing} aria-disabled={!ready} onClick={revert}>
            Revert
          </button>
        </div>
      </div>
    </dialog>
  );
}
