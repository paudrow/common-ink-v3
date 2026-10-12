import { Fragment, useCallback, useEffect, useId, useReducer, useRef, useState, type ReactNode } from "react";
import type { Author, Diff, Resolve, RevertConflict, RevertPreview } from "../core/protocol.ts";
import { ApiError } from "./api.ts";
import { useDismiss } from "./dismiss.ts";

const list = new Intl.ListFormat("en", { type: "conjunction" });
const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
export const authorKey = (author: Author) => `${author.kind}:${author.kind === "agent" ? author.agentId : author.personId}`;
export const nameOf = (author: Author) => (author.kind === "agent" ? `${author.name} (agent)` : author.name);

const MARK = { add: "+", del: "−", same: "" } as const;

export function DiffView({ diff }: { diff: Diff }) {
  if (!diff.hunks.length) return <p className="diff-none">No text changed.</p>;
  return (
    <div className="diff">
      {diff.hunks.map((hunk) => (
        <div key={hunk.oldStart} className="hunk">
          <div className="hunk-head">
            @@ −{hunk.oldStart} +{hunk.newStart} @@
          </div>
          {hunk.lines.map((line, i) => {
            const Line = line.kind === "add" ? "ins" : line.kind === "del" ? "del" : "div";
            return (
              <Line key={i} className="diff-line">
                <span className="diff-mark" aria-hidden="true">
                  {MARK[line.kind]}
                </span>
                <span className="diff-text">{line.text || " "}</span>
              </Line>
            );
          })}
        </div>
      ))}
      {diff.omitted > 0 && (
        <p className="diff-none">
          {diff.omitted} more {diff.omitted === 1 ? "line" : "lines"}
        </p>
      )}
    </div>
  );
}


/** The changes a sentence names, each one a way to it where there is a way to show it. More than a few are only counted. */
export function Named({ revisions, onShow }: { revisions: number[]; onShow?: (revision: number) => void }) {
  if (revisions.length > 3) return <>{revisions.length} changes</>;
  if (!onShow) return <>{revisions.length === 1 ? "change" : "changes"} {list.format(revisions.map(String))}</>;
  return (
    <>
      {revisions.length === 1 ? "change " : "changes "}
      {revisions.map((revision, i) => (
        <Fragment key={revision}>
          {i > 0 && (i === revisions.length - 1 ? " and " : ", ")}
          <button type="button" className="link change-ref" aria-label={`Change ${revision}`} onClick={() => onShow(revision)}>
            {revision}
          </button>
        </Fragment>
      ))}
    </>
  );
}

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

function Lines({ lines }: { lines: string[] }) {
  if (!lines.length) return <span className="conflict-none">No line here</span>;
  return lines.map((line, i) => (
    <span key={i} className="diff-text">
      {line || " "}
    </span>
  ));
}

/** Who edited a conflict's lines later, and in which changes. */
function Later({ later, onShow }: { later: RevertConflict["later"]; onShow?: (revision: number) => void }) {
  const authors = new Map<string, { author: Author; revisions: number[] }>();
  for (const { author, revision } of later) authors.set(authorKey(author), { author, revisions: [...(authors.get(authorKey(author))?.revisions ?? []), revision] });
  return [...authors].map(([key, { author, revisions }], i) => (
    <Fragment key={key}>
      {i > 0 && (i === authors.size - 1 ? " and " : ", ")}
      {nameOf(author)} in <Named revisions={revisions} onShow={onShow} />
    </Fragment>
  ));
}

interface ConflictsProps {
  conflicts: RevertConflict[];
  /** One for each conflict, in their order. */
  choices: Choice[];
  onChoose: (at: number | "all", choice: Picked) => void;
  heading: "h3" | "h4";
  onShow?: (revision: number) => void;
}

/** Each place a later change edited lines the revert changes: its lines before and now, who edited them, and the choice of what they become. */
function Conflicts({ conflicts, choices, onChoose, heading: Heading, onShow }: ConflictsProps) {
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
              <Heading id={`${id}-name`}>
                Conflict {i + 1} of {conflicts.length}, line {conflict.line}
              </Heading>
              <dl id={`${id}-sides`}>
                <dt>Before</dt>
                <dd className="conflict-lines">
                  <Lines lines={conflict.before} />
                </dd>
                <dt>
                  Now, edited by <Later later={conflict.later} onShow={onShow} />
                </dt>
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

interface Previewed {
  /** Null until the preview is read, and when it can't be. */
  preview: RevertPreview | null;
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
  | { type: "read"; preview: RevertPreview }
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

const TYPING_PAUSE_MS = 300;

/** What a revert's diff comes to, as a sentence. */
function tally({ added, removed }: Diff) {
  const does = [added > 0 && `adds ${count(added, "line")}`, removed > 0 && `removes ${count(removed, "line")}`].filter(Boolean).join(" and ") || "changes nothing";
  return `${does[0]!.toUpperCase()}${does.slice(1)}.`;
}

export interface RevertPreviewing {
  state: Previewed;
  choose: (at: number | "all", choice: Picked) => void;
  /** The server refused the revert: its words are shown, and the preview read again for the note as it is now. */
  refused: (err: Error) => void;
  /** Whether what is shown is what a revert would do now: the preview is read, and its diff is of the choices made. */
  settled: boolean;
  /** What a revert sends to settle the conflicts as chosen. Null with no conflict, when nothing is settled. */
  resolve: Resolve | null;
}

/**
 * A revert's preview, the choice made for each of its conflicts, and the diff of the revert as chosen.
 * `read` asks for the preview, settled as given when it is. It is asked again when `version` changes,
 * unless `first` holds a preview already read, which is taken instead and replaced when the note changes.
 */
export function useRevertPreview(read: (resolve?: Resolve) => Promise<RevertPreview>, version?: number, first?: RevertPreview): RevertPreviewing {
  const [state, dispatch] = useReducer(previewing, first, (first) => (first ? previewing(NOT_READ, { type: "read", preview: first }) : NOT_READ));
  const [reads, readAgain] = useState(0);
  const { preview, choices, diffIs, reading } = state;

  useEffect(() => {
    if (first && !reads) return dispatch({ type: "read", preview: first });
    let live = true;
    dispatch({ type: "reading" });
    read().then(
      (preview) => live && dispatch({ type: "read", preview }),
      // Only the server saying no means there is no such revert to show. Not reaching it leaves what is shown.
      (err: Error) => live && dispatch({ type: err instanceof ApiError && err.status < 500 ? "unreadable" : "unreached", message: err.message }),
    );
    return () => {
      live = false;
    };
  }, [read, version, reads, first]);

  const refused = useCallback((err: Error) => {
    dispatch({ type: "refused", message: err.message });
    readAgain((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!preview || reading || (diffIs !== "due" && diffIs !== "due soon")) return;
    let live = true;
    const timer = setTimeout(
      () =>
        read({ at: preview.revision, choices }).then(
          (settled) => live && dispatch({ type: "settled", choices, diff: settled.diff }),
          (err: Error) => live && refused(err),
        ),
      diffIs === "due soon" ? TYPING_PAUSE_MS : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [read, refused, preview, choices, diffIs, reading]);

  return {
    state,
    choose: useCallback((at, choice) => dispatch({ type: "chose", at, choice }), []),
    refused,
    settled: preview !== null && !reading && diffIs === "current",
    resolve: preview?.conflicts.length ? { at: preview.revision, choices } : null,
  };
}

interface RevertChangesProps {
  revert: RevertPreviewing;
  /** The heading of each conflict and of the result, under the heading these are shown beneath. */
  heading?: "h3" | "h4";
  onShow?: (revision: number) => void;
}

/** What a previewed revert would change: each conflict with a later change and the choice of how it is settled, and the note's lines the revert changes as chosen. */
export function RevertChanges({ revert, heading: Heading = "h3", onShow }: RevertChangesProps) {
  const ids = useId();
  const { preview, choices, diff, diffIs, reading, startedOver } = revert.state;
  if (!preview || !diff) return null;
  const changesNothing = !diff.hunks.length;
  return (
    <>
      {startedOver && <p className="revert-started-over">The note has changed, so the choices made here start over with every later edit kept.</p>}
      {preview.conflicts.length > 0 ? (
        <>
          <Conflicts conflicts={preview.conflicts} choices={choices} heading={Heading} onChoose={revert.choose} onShow={onShow} />
          <section className="revert-result" aria-labelledby={`${ids}-result`} aria-busy={reading || diffIs === "due" || diffIs === "due soon"}>
            <div className="revert-result-head">
              <Heading id={`${ids}-result`}>This revert</Heading>
              <output aria-labelledby={`${ids}-result`}>{tally(diff)}</output>
            </div>
            {!changesNothing && <DiffView diff={diff} />}
          </section>
        </>
      ) : changesNothing ? (
        <p className="diff-none">Nothing in the note would change.</p>
      ) : (
        <DiffView diff={diff} />
      )}
    </>
  );
}

interface Props {
  title: string;
  /** What the revert would do, as it is worked out and once it is. */
  children: ReactNode;
  /** Whether there is something to revert, and it isn't being reverted already. */
  ready: boolean;
  /** Whether what is shown is what the revert would do. While it isn't, as a diff catches up with a choice, Revert waits. */
  settled?: boolean;
  onRevert: () => void;
  onClose: () => void;
}

/** The dialog every revert is shown in before it is made. Escape, a press outside it, and Cancel all leave things as they are. */
export function RevertDialog({ title, children, ready, settled = true, onRevert, onClose }: Props) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const inside = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

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

  return (
    <dialog ref={dialog} className="revert-dialog" aria-labelledby={id} onCancel={(e) => e.preventDefault()}>
      <div ref={inside} className="revert-dialog-body">
        <h2 id={id}>{title}</h2>
        {children}
        <div className="revert-dialog-actions">
          <button ref={cancel} type="button" className="button small" onClick={onClose}>
            Cancel
          </button>
          {/* Not `disabled` while the diff catches up with a choice, so the button a Tab is headed for is still there. */}
          <button type="button" className="button small primary" disabled={!ready} aria-disabled={!settled} onClick={() => settled && onRevert()}>
            Revert
          </button>
        </div>
      </div>
    </dialog>
  );
}
