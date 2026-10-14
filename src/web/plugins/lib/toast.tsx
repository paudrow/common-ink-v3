import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Icon } from "../../plugin-api.ts";

export interface Toast {
  text: string;
  /** What Undo does. It answers with what to say when it couldn't be done, and with nothing when it was. */
  undo?: () => Promise<string | undefined> | string | undefined;
}

/** How long a toast is shown before it goes away by itself. */
export const TOAST_MS = 8000;

let root: Root | null = null;
let shown = 0;

/**
 * Says something over the foot of the app for a few seconds, with an Undo when there is one, in the
 * look of History's. It is laid over the app from an element of its own at the end of the page, so
 * nothing moves when it comes and goes, and anything can show one: a page, or a chip in a note. One
 * is shown at a time, and a newer one takes its place.
 */
export function showToast(toast: Toast): void {
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  root.render(<Shown key={++shown} toast={toast} />);
}

function Shown({ toast }: { toast: Toast }) {
  const [said, say] = useState<Toast | null>(toast);
  useEffect(() => {
    if (!said) return;
    const timer = setTimeout(() => say(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [said]);
  if (!said) return null;
  const { text, undo } = said;
  return (
    <div className="toast" role="status">
      <span>{text}</span>
      {undo && (
        <button
          type="button"
          className="link"
          onClick={async () => {
            say({ text });
            const problem = await undo();
            say(problem ? { text: problem } : null);
          }}
        >
          Undo
        </button>
      )}
      <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => say(null)}>
        <Icon name="close" />
      </button>
    </div>
  );
}
