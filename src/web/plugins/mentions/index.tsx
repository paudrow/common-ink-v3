import { completionStatus, startCompletion } from "@codemirror/autocomplete";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { Member, Plugin } from "../../plugin-api.ts";
import { editorKey, redraw } from "../lib/live.ts";
import { mentionDrawing, noteMentions, type OpenPerson } from "./drawing.ts";
import { PERSON_PATH, personPath, whoOn } from "../lib/person.ts";
import { PersonPage } from "./PersonPage.tsx";
import { newlyMentioned, offered, type People } from "./people.ts";

/** How long the members are taken to be who they were, before `@` reads them again. */
const MEMBERS_FRESH_MS = 60_000;
/** The same for the member's contacts, which are read from where they are kept, every one of them, each time. */
const CONTACTS_FRESH_MS = 10 * 60_000;

/** Whether the cursor is after an `@` that the list could be open on. */
function afterAt(view: EditorView): boolean {
  const { head } = view.state.selection.main;
  const line = view.state.doc.lineAt(head);
  return /(^|\s)@[^@[\]]*$/.test(line.text.slice(0, head - line.from));
}

const named = (members: readonly Member[]) => new Intl.ListFormat(undefined, { type: "conjunction" }).format(members.map((m) => m.name || "Someone"));

/**
 * Mentions. `@` lists the workspace's members and the member's own contacts, and picking one writes
 * a mention: of a member by their id, drawn as their name is now in the theme colour, and of anyone
 * else by name alone, drawn in gray. On a todo a mention is who it is assigned to. A mention gives
 * nobody access: mentioning a member in a private note of one's own offers to share it with them.
 * A click on a mention opens the person's page.
 *
 * The contacts are read once, when `@` is first typed, and kept in this browser's memory for the
 * list to narrow as the member types. Nothing typed after `@` is sent anywhere, and only the name
 * of a contact that is picked goes into the note.
 */
export const mentions: Plugin = {
  id: "mentions",
  name: "Mentions",
  description: "Mentions a person in a note with @: a member of the workspace, one of your contacts, or a name. A click opens their page. On a todo's line it assigns the todo.",
  icon: "at",
  settings: {
    offerToShare: {
      type: "boolean",
      default: true,
      title: "Offer to share a private note with a member you mention in it",
      description: "Mentioning someone never shares a note with them. With this on, mentioning a member in a private note of yours asks whether to let them read it.",
    },
  },
  activate(host) {
    const editors = new Map<string, EditorView>();
    let people: People = { members: new Map(), contacts: null };
    const focused = () => [...editors.values()].find((view) => view.hasFocus);

    let membersAt = 0;
    const readMembers = () => {
      membersAt = Date.now();
      host.perform({ type: "member.list" }).then(
        (list) => {
          const was = JSON.stringify([...people.members.values()]);
          people = { ...people, members: new Map(list.map((m) => [m.personId, m])) };
          if (JSON.stringify(list) !== was) for (const view of editors.values()) view.dispatch({ effects: redraw.of(null) });
        },
        // A guest, and whoever reads a link's page, is told nothing of who is in the workspace: every mention is then a name as written.
        () => {},
      );
    };
    readMembers();

    let contactsAt = 0;
    const readContacts = () => {
      contactsAt = Date.now();
      host.perform({ type: "contact.list" }).then(
        ({ contacts }) => {
          people = { ...people, contacts };
          // Where no member matched what was typed, the list isn't open, and is opened now on the contacts. An open
          // list is left alone until the next key: asked again, it would take no Enter for a moment, and break the line.
          const view = focused();
          if (view && afterAt(view) && completionStatus(view.state) === null) startCompletion(view);
        },
        () => void (people = { ...people, contacts: people.contacts ?? [] }),
      );
    };

    host.completions.register({
      id: "mentions",
      trigger: "@",
      spaces: true,
      items(typed) {
        const now = Date.now();
        if (now - membersAt > MEMBERS_FRESH_MS) readMembers();
        if (now - contactsAt > CONTACTS_FRESH_MS) readContacts();
        return offered(typed, people, host.app().me.id);
      },
    });

    /** Who the member has been asked about in each note, so the same mention typed, cut and pasted asks once. */
    const asked = new Set<string>();
    async function offer(noteId: string, mentioned: readonly Member[]) {
      const app = host.app();
      if (!host.settings.get<boolean>("offerToShare") || !app.notes?.find((note) => note.id === noteId)?.private) return;
      const others = mentioned.filter((m) => m.personId !== app.me.id && !asked.has(`${noteId}/${m.personId}`));
      if (!others.length) return;
      const sharing = await host.sharing.of({ noteId }).catch(() => null);
      if (!sharing?.canShare || sharing.note?.owner?.personId !== app.me.id) return;
      const letIn = new Set(sharing.grants.flatMap((grant) => (grant.to.kind === "person" && grant.to.personId ? [grant.to.personId] : [])));
      const out = others.filter((m) => !letIn.has(m.personId));
      if (!out.length) return;
      for (const m of out) asked.add(`${noteId}/${m.personId}`);
      const names = named(out);
      app.notify({
        message: `${names} can't see this private note.`,
        stays: true,
        action: {
          label: `Share with ${names}`,
          // What came of it is said in the card's place.
          run: () =>
            Promise.all(out.map((m) => host.sharing.grant({ noteId }, { memberId: m.personId }, "view"))).then(
              () => ({ message: `${names} can now read this note.`, icon: "check" as const }),
              (err: unknown) => ({ message: err instanceof Error ? err.message : "The note couldn't be shared." }),
            ),
        },
      });
    }

    /** Where a page asked a note to open, to put the cursor at the end of that line once its editor is there. */
    let going: { noteId: string; line: number } | null = null;
    const arrive = (view: EditorView, noteId: string) => {
      if (going?.noteId !== noteId) return;
      const { doc } = view.state;
      const at = doc.line(Math.min(going.line + 1, doc.lines));
      going = null;
      view.dispatch({ selection: { anchor: at.to }, effects: EditorView.scrollIntoView(at.from, { y: "center" }) });
    };
    const opened = new Map<EditorView, string>();
    const openAt = (noteId: string, line: number) => {
      going = { noteId, line };
      host.app().openNote(noteId, { focus: true });
      for (const [view, id] of opened) if (id === noteId) arrive(view, noteId);
    };
    // A link's page has nowhere to go: there a click on a mention is for the cursor.
    const open = (): OpenPerson => {
      const { go } = host.app();
      return typeof go === "function" ? (target) => go(personPath(target)) : null;
    };
    const drawing = mentionDrawing(() => people, open);

    host.views.register("page", {
      id: "person",
      path: PERSON_PATH,
      label: "Person",
      icon: "at",
      component: ({ app }) => {
        const who = whoOn(app.path);
        return who ? <PersonPage key={who} host={host} app={app} who={who} openAt={openAt} /> : null;
      },
    });

    host.editorExtensions.register({
      id: "mentions",
      extension: (editor) => [
        drawing.extension,
        ViewPlugin.define((view) => {
          const key = editorKey(editor);
          editors.set(key, view);
          opened.set(view, editor.noteId);
          queueMicrotask(() => arrive(view, editor.noteId));
          return {
            destroy: () => {
              opened.delete(view);
              if (editors.get(key) === view) editors.delete(key);
            },
          };
        }),
        // Only what the member writes here asks: a mention an agent or someone else wrote arrives as no input of theirs.
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || !update.transactions.some((tr) => tr.isUserEvent("input"))) return;
          const found = newlyMentioned(update.startState.field(noteMentions).values(), update.state.field(noteMentions).values(), people.members);
          if (found.length) void offer(editor.noteId, found);
        }),
      ],
    });

    // The cursor passes a drawn mention whole, so going into one to change it is asked for: by a click, or by this.
    host.commands.register({
      id: "mentions.edit",
      title: "Edit the mention at the cursor",
      keys: ["alt+enter"],
      when: () => {
        const view = focused();
        return !!view && drawing.canEdit(view);
      },
      run: () => {
        const view = focused();
        if (view) drawing.edit(view);
      },
    });
  },
};
