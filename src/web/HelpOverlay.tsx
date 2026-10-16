import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./icons.tsx";

interface Props {
  title: string;
  /** Closes it: Escape, its close button, and a press on the page around it call this. */
  onClose: () => void;
  children: ReactNode;
}

/**
 * Help over the page: a modal dialog with a title and a close button, whatever the help is. It
 * takes the keyboard while open, and gives it back on closing to what had it before, such as the
 * button that opened it.
 */
export function HelpOverlay({ title, onClose, children }: Props) {
  const ids = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const focused = document.activeElement;
    const modal = dialog.current!;
    modal.showModal();
    close.current!.focus();
    return () => {
      // While it is still open as a modal the rest of the page can't take focus.
      modal.close();
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
    };
  }, []);

  return (
    // Its role is said for what looks for a dialog over the window by it, as the inspector and vim's keys do.
    <dialog
      ref={dialog}
      role="dialog"
      className="help-overlay"
      aria-labelledby={`${ids}-title`}
      onCancel={(e) => e.preventDefault()}
      // Being modal, it is pressed outside only on its backdrop, which is the dialog itself. A dialog over it, such as the
      // keyboard shortcuts over the query syntax, is pressed in without closing it. The press gives the keyboard to nothing,
      // so it goes back to what opened the help.
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // Whatever it was opened from, such as the Advanced panel, keeps its own Escape for itself.
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="help-overlay-body">
        <header>
          <h2 id={`${ids}-title`}>{title}</h2>
          <button ref={close} type="button" className="icon-button" aria-label="Close" title="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="help-overlay-content">{children}</div>
      </div>
    </dialog>
  );
}
