import { ViewPlugin } from "@codemirror/view";
import { blank } from "../core/text.ts";
import { perform } from "./api.ts";

/**
 * This page, as it names itself to the server when it holds a note open. It is kept for the tab's
 * session, so a reload is the same page and not another that left a hold behind it. A tab duplicated
 * with its session is told apart by `openInAnotherTab`.
 */
export const PAGE: string = (() => {
  const made = `page:${crypto.randomUUID()}`;
  try {
    const kept = sessionStorage.getItem("ink.page");
    if (kept) return kept;
    sessionStorage.setItem("ink.page", made);
  } catch {
    // Storage refused: this load is a page of its own.
  }
  return made;
})();

/** How often an open editor of a blank note says it still has it, well inside the ten minutes a hold lasts, so one that is late lets nothing go. */
const AGAIN_MS = 240_000;

/**
 * The editor extension that holds its note open on the server while the note is blank, so someone
 * else leaving it, in another browser or another tab, doesn't discard it from under this one. Once
 * the note has words it can't be discarded, and the editor stops saying so.
 */
export const holdingOpen = (workspaceId: string, noteId: string) =>
  ViewPlugin.define((view) => {
    const hold = () => void perform(workspaceId, { type: "note.hold", id: noteId, holder: PAGE }).catch(() => {});
    let again = blank(view.state.doc.toString()) ? (hold(), setInterval(hold, AGAIN_MS)) : undefined;
    // A tab the browser froze or a laptop that slept missed its turns, and its hold may have lapsed.
    const woke = () => again !== undefined && document.visibilityState === "visible" && hold();
    document.addEventListener("visibilitychange", woke);
    return {
      update(update) {
        if (again === undefined || !update.docChanged || blank(update.state.doc.toString())) return;
        clearInterval(again);
        again = undefined;
      },
      destroy() {
        clearInterval(again);
        document.removeEventListener("visibilitychange", woke);
      },
    };
  });
