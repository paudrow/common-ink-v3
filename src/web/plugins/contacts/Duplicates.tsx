import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { App, Contact, ContactCard, ContactMerge, DuplicatePair, PluginHost, Results, SameBy, Source } from "../../plugin-api.ts";
import { personPath } from "../lib/person.ts";
import { fieldsOf } from "../mentions/fields.ts";

const SAME_WORDS: Record<SameBy, string> = { email: "email", phone: "phone number", name: "name" };

/** Why two contacts look like one person, in words: "Same email", "Same email and name". */
export function sameByWords(sameBy: readonly SameBy[]): string {
  const words = sameBy.map((by) => SAME_WORDS[by]);
  return `Same ${words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0]}`;
}

const failure = (err: unknown, otherwise: string) => (err instanceof Error ? err.message : otherwise);

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
        setProblem(failure(err, "That couldn't be saved."));
      }
    },
    [host],
  );
  return { pairs, problem, dismiss };
}

/** The contacts the member merged that can still be restored, read while `wanted` and again whenever `again` changes. */
export function useMerges(host: PluginHost, wanted: boolean, again: unknown) {
  const [merges, setMerges] = useState<readonly ContactMerge[]>([]);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    host.perform({ type: "contact.merges" }).then(
      (answer) => live && setMerges(answer.merges),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [host, wanted, again]);
  return merges;
}

const isCard = (contact: Contact, card: Pick<Contact, "sourceId" | "id">) => contact.sourceId === card.sourceId && contact.id === card.id;
const pairName = (pair: DuplicatePair) => `${pair.contacts[0].sourceId} ${pair.contacts[0].id} ${pair.contacts[1].id}`;

/** A link to a contact's page, opened in the app. */
function PersonLink({ app, contact }: { app: App; contact: Pick<Contact, "name"> }) {
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

/** What a merge or a restore tells the page holding the pairs. */
export interface Merging {
  host: PluginHost;
  app: App;
  /** The member's data sources, which say whether contacts can be changed, once they are read. */
  sources: readonly Source[] | null;
  onDismiss: (pair: DuplicatePair) => void;
  /** Connects a data source again, asking to change it too. */
  onConnect: (source: Source) => void;
  onMerged: (merged: Results["contact.merge"]) => void;
}

/**
 * Merging two contacts: the member picks which is the main one and sees it as merging would make
 * it, then merges or doesn't. The other is deleted where it is kept, and Common Ink keeps a copy.
 */
function MergePanel({ host, pair, first, source, onConnect, onMerged, onCancel }: Omit<Merging, "app" | "sources" | "onDismiss"> & { pair: DuplicatePair; first: number; source: Source | undefined; onCancel: () => void }) {
  const [main, setMain] = useState(first);
  const [shown, setShown] = useState<Results["contact.combine"] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mainContact, otherContact] = main === 0 ? pair.contacts : [pair.contacts[1], pair.contacts[0]];
  useEffect(() => {
    let live = true;
    setShown(null);
    host.perform({ type: "contact.combine", sourceId: pair.sourceId, mainId: mainContact.id, otherId: otherContact.id }).then(
      (answer) => live && (setShown(answer), setProblem(null)),
      (err: unknown) => live && setProblem(failure(err, "They couldn't be read.")),
    );
    return () => {
      live = false;
    };
  }, [host, pair.sourceId, mainContact.id, otherContact.id]);

  const merge = async () => {
    if (!shown || busy) return;
    setBusy(true);
    try {
      onMerged(await host.perform({ type: "contact.merge", sourceId: pair.sourceId, mainId: shown.main.id, mainEtag: shown.main.etag, otherId: shown.other.id, otherEtag: shown.other.etag }));
    } catch (err) {
      setProblem(failure(err, "They couldn't be merged."));
      setBusy(false);
    }
  };

  const title = `Merge ${pair.contacts[0].name} and ${pair.contacts[1].name}`;
  return (
    <section className="contact-merge" aria-label={title}>
      <fieldset className="contact-merge-main">
        <legend>Keep as the main contact</legend>
        {pair.contacts.map((contact, i) => (
          <label key={contact.id}>
            <input type="radio" name={`main ${pairName(pair)}`} checked={main === i} onChange={() => setMain(i)} />
            {contact.name || "No name"}
          </label>
        ))}
      </fieldset>
      {shown ? <MergedCard card={shown.combined} /> : !problem && <p className="person-whose">Reading them…</p>}
      <p className="person-whose">
        {otherContact.name} is deleted from {source?.name ?? "your contacts"}, and everything it had is kept in {mainContact.name}. Common Ink keeps a copy of {otherContact.name} for 30 days, so you can restore it from the Contacts page.
      </p>
      {problem && (
        <p role="alert" className="said failed">
          {problem}
        </p>
      )}
      <div className="contact-form-foot">
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
        {source?.reconnectToWrite ? (
          <button type="button" className="button primary" onClick={() => onConnect(source)}>
            Connect again to edit contacts
          </button>
        ) : (
          <button type="button" className="button primary" aria-disabled={!shown || busy || undefined} disabled={!source?.writable} onClick={() => void merge()}>
            Merge
          </button>
        )}
      </div>
    </section>
  );
}

/** The main contact as merging would make it: its name and every field, as its page lists them. */
function MergedCard({ card }: { card: ContactCard }) {
  return (
    <dl className="person-fields contact-merged" aria-label="Merged contact">
      {[{ label: "Name", values: [card.name] }, ...fieldsOf(card)].map((field, i) => (
        <div key={i} className="person-field">
          <dt>{field.label}</dt>
          <dd>
            {field.values.map((value) => (
              <div key={value}>{value}</div>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A pair's actions, Merge… and Not the same person, and the merge itself once it is opened. `first` is which contact is offered as the main one. */
function PairActions({ pair, first, ...merging }: Omit<Merging, "app"> & { pair: DuplicatePair; first: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <li aria-label={`${pair.contacts[0].name} and ${pair.contacts[1].name}`}>
      <div className="contact-duplicate">
        {merging.children}
        <button type="button" className="button small" aria-expanded={open} onClick={() => setOpen(true)}>
          Merge…
        </button>
        <button type="button" className="button small" onClick={() => merging.onDismiss(pair)}>
          Not the same person
        </button>
      </div>
      {open && <MergePanel {...merging} pair={pair} first={first} source={merging.sources?.find((s) => s.id === pair.sourceId)} onCancel={() => setOpen(false)} />}
    </li>
  );
}

/** Which of a pair holds more, offered as the main contact: the first where they hold as much. */
const fuller = (pair: DuplicatePair) => {
  const [a, b] = pair.contacts.map((c) => c.emails.length + c.phones.length + Number(c.organization !== null));
  return b! > a! ? 1 : 0;
};

/** The Contacts page's list of pairs that look like one person, each to merge or to say they are not. */
export function DuplicateList({ pairs, ...merging }: Merging & { pairs: readonly DuplicatePair[] }) {
  if (!pairs.length) return null;
  return (
    <section className="contact-duplicates" aria-label="Possible duplicates">
      <h2>Possible duplicates</h2>
      <ul>
        {pairs.map((pair) => (
          <PairActions key={pairName(pair)} {...merging} pair={pair} first={fuller(pair)}>
            <span className="contact-duplicate-names">
              <PersonLink app={merging.app} contact={pair.contacts[0]} /> and <PersonLink app={merging.app} contact={pair.contacts[1]} />
            </span>
            <span className="contact-duplicate-why">{sameByWords(pair.sameBy)}</span>
          </PairActions>
        ))}
      </ul>
    </section>
  );
}

/** On a contact's page: each other contact that looks like the same person, to merge with this one, to go to, or to say is not. */
export function SameAs({ card, pairs, ...merging }: Merging & { pairs: readonly DuplicatePair[]; card: Pick<Contact, "sourceId" | "id"> }) {
  const mine = pairs.filter((pair) => pair.contacts.some((c) => isCard(c, card)));
  if (!mine.length) return null;
  return (
    <ul className="contact-duplicates contact-same-as" aria-label="Looks like the same person">
      {mine.map((pair) => {
        const at = pair.contacts.findIndex((c) => isCard(c, card));
        return (
          <PairActions key={pairName(pair)} {...merging} pair={pair} first={at}>
            <span className="contact-duplicate-names">
              Looks like the same person as <PersonLink app={merging.app} contact={pair.contacts[1 - at]!} />. {sameByWords(pair.sameBy)}.
            </span>
          </PairActions>
        );
      })}
    </ul>
  );
}

/** Says a merge was made, with a way to take it back. */
export function Merged({ host, merge, onRestored }: { host: PluginHost; merge: ContactMerge; onRestored: () => void }) {
  return (
    <p role="status" className="contact-merged-said">
      Merged {merge.name} into {merge.into}. <RestoreButton host={host} merge={merge} onRestored={onRestored} />
    </p>
  );
}

function RestoreButton({ host, merge, onRestored }: { host: PluginHost; merge: ContactMerge; onRestored: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const restore = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await host.perform({ type: "contact.restore", id: merge.id });
      onRestored();
    } catch (err) {
      setProblem(failure(err, "It couldn't be restored."));
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="button small" aria-label={`Restore ${merge.name}`} aria-disabled={busy || undefined} onClick={() => void restore()}>
        Restore
      </button>
      {problem && (
        <span role="alert" className="said failed">
          {problem}
        </span>
      )}
    </>
  );
}

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** The Contacts page's list of contacts merged into others in the last 30 days, each to restore. */
export function RecentlyMerged({ host, merges, onRestored }: { host: PluginHost; merges: readonly ContactMerge[]; onRestored: () => void }) {
  if (!merges.length) return null;
  return (
    <section className="contact-duplicates" aria-label="Recently merged">
      <h2>Recently merged</h2>
      <ul>
        {merges.map((merge) => (
          <li key={merge.id} aria-label={merge.name}>
            <div className="contact-duplicate">
              <span className="contact-duplicate-names">
                {merge.name}, merged into {merge.into}
              </span>
              <span className="contact-duplicate-why">Can be restored until {day(merge.until)}</span>
              <RestoreButton host={host} merge={merge} onRestored={onRestored} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
