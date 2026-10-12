import { useEffect, useId, useRef, type ReactNode } from "react";
import { useDismiss, type Diff } from "../../plugin-api.ts";

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

interface Props {
  title: string;
  /** What the revert would do, as it is worked out and once it is. */
  children: ReactNode;
  /** Whether there is something to revert, and it isn't being reverted already. */
  ready: boolean;
  onRevert: () => void;
  onClose: () => void;
}

/** The dialog every revert is shown in before it is made. Escape, a press outside it, and Cancel all leave things as they are. */
export function RevertDialog({ title, children, ready, onRevert, onClose }: Props) {
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
          <button type="button" className="button small primary" disabled={!ready} onClick={onRevert}>
            Revert
          </button>
        </div>
      </div>
    </dialog>
  );
}
