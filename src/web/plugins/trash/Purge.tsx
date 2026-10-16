import { useState } from "react";

interface Props {
  title: string;
  /** Removes the note. What it throws is said beside the button. */
  onPurge: () => Promise<void>;
}

/** Removes a note in Trash for good, after asking once and naming the note. */
export function Purge({ title, onPurge }: Props) {
  const [step, setStep] = useState<"idle" | "asking" | "busy">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const name = title || "Untitled";

  if (step === "asking") {
    return (
      <div className="confirm" role="group" aria-label={`Delete ${name} forever`}>
        <span>
          Delete “{name}” forever? The note and its history are removed now, and can't be brought back.
        </span>
        <button
          type="button"
          className="button small danger"
          autoFocus
          onClick={() => {
            setStep("busy");
            onPurge().catch((err: Error) => {
              setProblem(err.message);
              setStep("idle");
            });
          }}
        >
          Delete forever
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
          setProblem(null);
          setStep("asking");
        }}
      >
        {step === "busy" ? "Deleting…" : "Delete forever"}
      </button>
      {problem && (
        <span role="alert" className="said failed">
          {problem}
        </span>
      )}
    </>
  );
}
