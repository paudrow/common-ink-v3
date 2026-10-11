import { useState } from "react";
import type { AuthorRef } from "../core/protocol.ts";
import { revertAuthor } from "./sync.ts";

interface Props {
  workspaceId: string;
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
export function RevertAuthor({ workspaceId, author, name, where, noteIds, beyond, onReverted }: Props) {
  const [step, setStep] = useState<"idle" | "asking" | "busy">("idle");
  const [said, say] = useState<{ text: string; failed?: boolean } | null>(null);
  const title = `Revert ${name}'s changes`;

  const run = async () => {
    setStep("busy");
    try {
      const done = await revertAuthor(workspaceId, author, noteIds);
      const took = done.notes ? `Took ${count(done.changes, "change")} by ${name} back out of ${count(done.notes, "note")}.` : done.failed.length ? "" : `Nothing by ${name} still stands ${where}.`;
      const empty = done.emptied.length ? `${list.format(done.emptied.map((title) => title || "Untitled"))} ${done.emptied.length === 1 ? "is now empty. It" : "are now empty. They"} can be deleted once Trash exists.` : "";
      const left = done.failed.map((f) => `${f.title || "Untitled"} was left as it is: ${f.message}.`);
      say({ text: [took, empty, ...left, beyond].filter(Boolean).join(" "), failed: left.length > 0 });
      if (done.notes) onReverted();
    } catch (err) {
      say({ text: (err as Error).message, failed: true });
      onReverted();
    }
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
        disabled={step === "busy"}
        onClick={() => {
          say(null);
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
    </>
  );
}
