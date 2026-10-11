import { useState } from "react";
import type { AuthorRef, PluginHost } from "../../plugin-api.ts";

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
  /** Called once notes have changed, so they are read again. */
  onReverted: () => void;
}

const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
const list = new Intl.ListFormat("en", { type: "conjunction" });

/** Takes one author's changes back out and keeps everyone else's, after asking once. */
export function RevertAuthor({ host, author, name, where, noteIds, beyond, onReverted }: Props) {
  const [step, setStep] = useState<"idle" | "asking" | "busy" | "trashing">("idle");
  const [said, say] = useState<{ text: string; failed?: boolean } | null>(null);
  /** The notes the last revert left with no text, which the member is offered to move to Trash. */
  const [emptied, setEmptied] = useState<{ noteId: string; title: string }[]>([]);
  const title = `Revert ${name}'s changes`;

  const run = async () => {
    setStep("busy");
    try {
      const done = { notes: 0, changes: 0, emptied: [] as { noteId: string; title: string }[], failed: [] as { title: string; message: string }[] };
      // A few notes are covered a request, so it is asked again until every note has been.
      for (let after: string | undefined, more = true; more; ) {
        const { reverted, emptied, failed, next } = await host.perform({ type: "history.revertAuthor", author, noteIds, after });
        done.notes += reverted.length;
        for (const { revisions } of reverted) done.changes += revisions.length;
        done.emptied.push(...emptied.filter((e) => !e.trashed));
        done.failed.push(...failed);
        more = next !== null;
        after = next ?? undefined;
      }
      const took = done.notes ? `Took ${count(done.changes, "change")} by ${name} back out of ${count(done.notes, "note")}.` : done.failed.length ? "" : `Nothing by ${name} still stands ${where}.`;
      const empty = done.emptied.length ? `${list.format(done.emptied.map((e) => e.title || "Untitled"))} ${done.emptied.length === 1 ? "is" : "are"} now empty.` : "";
      const left = done.failed.map((f) => `${f.title || "Untitled"} was left as it is: ${f.message}.`);
      say({ text: [took, empty, ...left, beyond].filter(Boolean).join(" "), failed: left.length > 0 });
      setEmptied(done.emptied);
      if (done.notes) onReverted();
    } catch (err) {
      say({ text: (err as Error).message, failed: true });
      onReverted();
    }
    setStep("idle");
  };

  const trashEmptied = async () => {
    setStep("trashing");
    const left: string[] = [];
    let moved = 0;
    for (const { noteId, title } of emptied) {
      await host.perform({ type: "note.trash", id: noteId }).then(
        (note) => {
          moved++;
          host.app().noteChanged(note);
        },
        (err: Error) => void left.push(`${title || "Untitled"} was left where it is: ${err.message}.`),
      );
    }
    say({ text: [moved ? `Moved ${count(moved, "emptied note")} to Trash, where ${moved === 1 ? "it waits" : "they wait"} 30 days.` : "", ...left].filter(Boolean).join(" "), failed: left.length > 0 });
    setEmptied([]);
    onReverted();
    setStep("idle");
  };

  if (step === "asking") {
    return (
      <div className="confirm" role="group" aria-label={title}>
        <span>
          Take back out every change {name} made {where} that still stands? Everyone else's changes are kept. Each note gets one new change by you, which can be reverted too. {beyond}
        </span>
        <button type="button" className="button small primary" autoFocus onClick={run}>
          Revert
        </button>
        <button type="button" className="link" onClick={() => setStep("idle")}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        className="button small"
        disabled={step !== "idle"}
        onClick={() => {
          say(null);
          setEmptied([]);
          setStep("asking");
        }}
      >
        {step === "busy" ? "Reverting…" : title}
      </button>
      {said && (
        <span role={said.failed ? "alert" : "status"} className={said.failed ? "said failed" : "said"}>
          {said.text}
        </span>
      )}
      {emptied.length > 0 && (
        <button type="button" className="button small" disabled={step !== "idle"} onClick={trashEmptied}>
          Move {count(emptied.length, "emptied note")} to Trash
        </button>
      )}
    </>
  );
}
