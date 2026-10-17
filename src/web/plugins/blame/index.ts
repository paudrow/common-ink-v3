import type { Blame, Plugin } from "../../plugin-api.ts";
import { blameLink } from "../lib/blameLink.ts";
import { blameColumn, blameToggles, stepHunk, type Editors } from "./column.ts";

/** The ids are the ones the mode had as part of History, so keys a member gave its commands keep working. */
const TOGGLE = "history.whoWrote";

export const blame: Plugin = {
  id: "blame",
  name: "Blame",
  description: "Blame mode marks each line of a note with who last wrote it and when, and opens the change that did in History.",
  icon: "members",
  activate(host) {
    const link = blameLink(host.workspace.id);
    const toggles = blameToggles(host.storage, () => link.former);
    const read = new Map<string, Blame>();
    const editors: Editors = new Map();
    const openAt = (noteId: string, revision: number) => {
      link.asked.ask(noteId, revision);
      if (!link.asked.showing.has(noteId) && host.commands.list().some((c) => c.id === "inspector.history")) host.app().togglePanel("history");
    };
    host.editorExtensions.register({ id: "blame", extension: (editor) => (editor.reading ? [] : blameColumn(host, toggles, read, editors, openAt, editor.noteId)) });
    host.commands.register({
      id: TOGGLE,
      title: "Toggle blame mode",
      aliases: ["Who wrote this", "Who changed what"],
      when: () => host.app().noteId !== null,
      run: () => {
        const { noteId } = host.app();
        if (noteId) toggles.toggle(noteId);
      },
    });
    // No keys of their own, as the mode has none: a member who uses them gives them keys in Keyboard shortcuts.
    for (const [id, title, by] of [
      ["history.whoWroteNext", "Next change in blame", 1],
      ["history.whoWrotePrevious", "Previous change in blame", -1],
    ] as const) {
      host.commands.register({
        id,
        title,
        when: () => {
          const { noteId } = host.app();
          return noteId !== null && toggles.has(noteId);
        },
        run: () => {
          const { noteId } = host.app();
          const view = noteId && toggles.has(noteId) ? editors.get(noteId)?.[0] : undefined;
          const revision = view && stepHunk(view, by);
          if (noteId && revision) openAt(noteId, revision);
          view?.focus();
        },
      });
    }
    return link.offer(toggles);
  },
};
