import { useEffect, useState } from "react";
import type { LastDone, TodoCompletion } from "../../plugin-api.ts";
import { dueLabel } from "./dates.ts";

interface Props {
  /** Reads the todo's completions, latest first. */
  ask: () => Promise<TodoCompletion[]>;
  /** What the todo's line says of them, which may count more than are listed. */
  done: LastDone;
  now: string;
  /** Opens the daily note a completion was filed on. */
  onOpen: (noteId: string) => void;
}

/** Each time a recurring todo was checked off: the day and who did it, and its daily note a click away. */
export function Completions({ ask, done, now, onOpen }: Props) {
  const [read, setRead] = useState<{ completions: TodoCompletion[] } | { problem: string } | null>(null);
  useEffect(() => {
    let stale = false;
    ask().then(
      (completions) => !stale && setRead({ completions }),
      (err: unknown) => !stale && setRead({ problem: err instanceof Error ? err.message : "The completions couldn't be read." }),
    );
    return () => {
      stale = true;
    };
  }, [ask]);

  if (!read) return <p className="completions-note" data-autofocus tabIndex={-1} aria-busy="true" />;
  if ("problem" in read)
    return (
      <p className="completions-note" role="alert" data-autofocus tabIndex={-1}>
        {read.problem}
      </p>
    );
  const { completions } = read;
  const missing = done.times - completions.length;
  const says = (completion: TodoCompletion) => (
    <>
      <span>{dueLabel(completion.on, now)}</span>
      <span className="completion-by">
        {completion.by.name}
        {completion.by.kind === "agent" && <span className="badge">agent</span>}
      </span>
    </>
  );
  return (
    <div className="completions">
      <h2 data-autofocus tabIndex={-1}>
        Done {done.times} {done.times === 1 ? "time" : "times"}
      </h2>
      {completions.length > 0 && (
        <ol aria-label="Completions">
          {completions.map((completion) => (
            <li key={`${completion.at}/${completion.on}`}>
              {completion.dailyNoteId ? (
                <button type="button" title="Open the daily note it was filed on" onClick={() => onOpen(completion.dailyNoteId!)}>
                  {says(completion)}
                </button>
              ) : (
                <div>{says(completion)}</div>
              )}
            </li>
          ))}
        </ol>
      )}
      {missing > 0 && (
        <p className="completions-note">
          {completions.length === 0 ? "None of them are listed here." : `${missing} earlier ${missing === 1 ? "one isn't" : "ones aren't"} listed here.`} A completion made before the line was cut and pasted is not followed.
        </p>
      )}
    </div>
  );
}
