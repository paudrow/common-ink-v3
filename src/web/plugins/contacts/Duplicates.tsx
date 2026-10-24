import { useCallback, useEffect, useState } from "react";
import type { App, Contact, DuplicatePair, PluginHost, SameBy } from "../../plugin-api.ts";
import { personPath } from "../lib/person.ts";

const SAME_WORDS: Record<SameBy, string> = { email: "email", phone: "phone number", name: "name" };

/** Why two contacts look like one person, in words: "Same email", "Same email and name". */
export function sameByWords(sameBy: readonly SameBy[]): string {
  const words = sameBy.map((by) => SAME_WORDS[by]);
  return `Same ${words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0]}`;
}

/** The member's possible duplicates, read while `wanted` and again whenever `again` changes, and a way to say a pair is not one person. */
export function useDuplicates(host: PluginHost, wanted: boolean, again: unknown) {
  const [pairs, setPairs] = useState<readonly DuplicatePair[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    host.perform({ type: "contact.duplicates" }).then(
      (answer) => live && (setPairs(answer.pairs), setProblem(null)),
      (err: Error) => live && setProblem(err.message),
    );
    return () => {
      live = false;
    };
  }, [host, wanted, again]);
  const dismiss = useCallback(
    async (pair: DuplicatePair) => {
      try {
        await host.perform({ type: "contact.dismiss", sourceId: pair.sourceId, ids: [pair.contacts[0].id, pair.contacts[1].id] });
        setPairs((now) => now?.filter((p) => p !== pair) ?? null);
      } catch (err) {
        setProblem(err instanceof Error ? err.message : "That couldn't be saved.");
      }
    },
    [host],
  );
  return { pairs, problem, dismiss };
}

const isCard = (contact: Contact, card: Pick<Contact, "sourceId" | "id">) => contact.sourceId === card.sourceId && contact.id === card.id;

/** A link to a contact's page, opened in the app. */
function PersonLink({ app, contact }: { app: App; contact: Contact }) {
  const path = personPath(contact.name);
  return (
    <a
      href={path}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        app.go(path);
      }}
    >
      {contact.name || "No name"}
    </a>
  );
}

interface ListProps {
  app: App;
  pairs: readonly DuplicatePair[];
  onDismiss: (pair: DuplicatePair) => void;
}

/** The Contacts page's list of pairs that look like one person, each to look at or say they are not. */
export function DuplicateList({ app, pairs, onDismiss }: ListProps) {
  if (!pairs.length) return null;
  return (
    <section className="contact-duplicates" aria-label="Possible duplicates">
      <h2>Possible duplicates</h2>
      <ul>
        {pairs.map((pair) => (
          <li key={`${pair.sourceId} ${pair.contacts[0].id} ${pair.contacts[1].id}`} aria-label={`${pair.contacts[0].name} and ${pair.contacts[1].name}`}>
            <span className="contact-duplicate-names">
              <PersonLink app={app} contact={pair.contacts[0]} /> and <PersonLink app={app} contact={pair.contacts[1]} />
            </span>
            <span className="contact-duplicate-why">{sameByWords(pair.sameBy)}</span>
            <button type="button" className="button small" onClick={() => onDismiss(pair)}>
              Not the same person
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** On a contact's page: each other contact that looks like the same person, to go to or to say is not. */
export function SameAs({ app, card, pairs, onDismiss }: ListProps & { card: Pick<Contact, "sourceId" | "id"> }) {
  const mine = pairs.filter((pair) => pair.contacts.some((c) => isCard(c, card)));
  if (!mine.length) return null;
  return (
    <ul className="contact-same-as" aria-label="Looks like the same person">
      {mine.map((pair) => {
        const other = pair.contacts.find((c) => !isCard(c, card))!;
        return (
          <li key={`${other.sourceId} ${other.id}`}>
            <span>
              Looks like the same person as <PersonLink app={app} contact={other} />. {sameByWords(pair.sameBy)}.
            </span>
            <button type="button" className="button small" onClick={() => onDismiss(pair)}>
              Not the same person
            </button>
          </li>
        );
      })}
    </ul>
  );
}
