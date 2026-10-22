import { completionStatus, startCompletion } from "@codemirror/autocomplete";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { writtenMention, type Contact, type Member, type Plugin, type Source } from "../../plugin-api.ts";
import { editorKey, redraw } from "../lib/live.ts";
import { reask } from "../lib/reasking.ts";
import { mentionDrawing, noteMentions, type OpenPerson } from "./drawing.ts";
import { PERSON_PATH, personPath, whoOn } from "../lib/person.ts";
import { PersonPage } from "./PersonPage.tsx";
import { addingTo, newlyMentioned, offered, type Adding, type People } from "./people.ts";

/** How long the members are taken to be who they were, before `@` reads them again. */
const MEMBERS_FRESH_MS = 60_000;
/** The same for the member's contacts, which are read from where they are kept, every one of them, each time. */
const CONTACTS_FRESH_MS = 10 * 60_000;

/** What is typed after an `@` that the list could be open on, before the cursor, or null where there is none. */
function afterAt(view: EditorView): string | null {
  const { head } = view.state.selection.main;
  const line = view.state.doc.lineAt(head);
  return /(?:^|\s)@([^@[\]]*)$/.exec(line.text.slice(0, head - line.from))?.[1] ?? null;
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
 * of a contact that is picked goes into the note. Where it finds nobody, `@` offers to create a
 * contact of the name typed, in the member's contacts that take changes, and that name alone is sent.
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
    /** Where a contact created from `@` goes: known once the contacts are read whole, so that finding nobody among them means there is nobody. */
    let addTo: Source | null = null;
    /** Whether the members are known, or known to be none this member is told of: until then a member's name would find nobody. */
    let membersKnown = host.workspace.role === "guest";
    /** The contacts created from here, kept until a read of the contacts that holds them, which one already on its way may not. */
    let made: Contact[] = [];
    const focused = () => [...editors.values()].find((view) => view.hasFocus);
    /** The people as they are known, with the member among the members before the list of them is read: `@` alone then offers them first. */
    const known = (): People => {
      const { me } = host.app();
      if (host.workspace.role === "guest" || people.members.has(me.id)) return people;
      const self = { personId: me.id, name: me.name, role: host.workspace.role, ...(host.workspace.role === "admin" && { email: me.email }) };
      return { ...people, members: new Map([[me.id, self], ...people.members]) };
    };

    let membersAt = 0;
    const readMembers = () => {
      membersAt = Date.now();
      // A guest is told nothing of who is in the workspace, and a refusal reads again who they are: every mention is then a name as written.
      if (host.workspace.role === "guest") return;
      host.perform({ type: "member.list" }).then(
        (list) => {
          const was = JSON.stringify([...people.members.values()]);
          people = { ...people, members: new Map(list.map((m) => [m.personId, m])) };
          membersKnown = true;
          if (JSON.stringify(list) === was) return;
          for (const view of editors.values()) view.dispatch({ effects: redraw.of(null) });
          reask();
        },
        // Whoever reads a link's page is told nothing of who is in the workspace either.
        () => void (membersKnown = true),
      );
    };
    readMembers();

    let contactsAt = 0;
    const readContacts = () => {
      contactsAt = Date.now();
      host.perform({ type: "contact.list" }).then(
        ({ contacts, sources, more }) => {
          made = made.filter((m) => !contacts.some((c) => c.sourceId === m.sourceId && c.id === m.id));
          people = { ...people, contacts: [...contacts, ...made] };
          addTo = more ? null : addingTo(sources);
          // The list after an `@` is asked again for the contacts: an open one at once, and one that isn't, where nothing else
          // matched, where it now offers something before or instead of any member: a contact, or to create one.
          const view = focused();
          const typed = view ? afterAt(view) : null;
          if (!view || typed === null) return;
          if (completionStatus(view.state) === "active") return reask();
          const first = offered(typed, known(), host.app().me.id, adding())[0];
          if (first && (first.tone === "muted" || first.kind === "new")) startCompletion(view);
        },
        // A reading that failed is read again by the next asking, not taken to be the contacts until they would be stale.
        () => {
          contactsAt = 0;
          people = { ...people, contacts: people.contacts ?? [] };
        },
      );
    };

    /** Creating a contact makes it once: picked again while it is on its way, the same name is answered by the same creating. */
    const creating = new Map<string, Promise<string | null>>();
    const create = async (into: Source, name: string): Promise<string | null> => {
      try {
        const card = await host.perform({ type: "contact.create", sourceId: into.id, name });
        made = [...made, card];
        people = { ...people, contacts: [...(people.contacts ?? []), card] };
        const app = host.app();
        const { go } = app;
        app.notify({ message: `Created contact ${card.name}`, icon: "check", ...(typeof go === "function" && { action: { label: "Open", run: () => go(personPath(card.name)) } }) });
        return writtenMention({ name: card.name });
      } catch (err) {
        host.app().notify({ message: err instanceof Error ? err.message : "The contact couldn't be created." });
        return null;
      }
    };
    /** Where `@` creates a contact: in `addTo`, once the members and the contacts are known. Each says so with a way to its page, to put a typo right, or says why not. */
    const adding = (): Adding | null => {
      const into = addTo;
      if (!into || !membersKnown) return null;
      return {
        into: into.name,
        create(name) {
          const key = `${into.id} ${name.toLowerCase()}`;
          const pending = creating.get(key) ?? create(into, name).finally(() => creating.delete(key));
          creating.set(key, pending);
          return pending;
        },
      };
    };

    host.completions.register({
      id: "mentions",
      trigger: "@",
      spaces: true,
      items(typed) {
        const now = Date.now();
        if (now - membersAt > MEMBERS_FRESH_MS) readMembers();
        if (now - contactsAt > CONTACTS_FRESH_MS) readContacts();
        return offered(typed, known(), host.app().me.id, adding());
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
