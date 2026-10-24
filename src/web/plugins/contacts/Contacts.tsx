import { useEffect, useMemo, useState } from "react";
import type { Contact, PluginHost, ViewProps } from "../../plugin-api.ts";
import { personPath } from "../lib/person.ts";
import { initialsOf } from "../mentions/fields.ts";
import { Sources, useSources, withFresher } from "../lib/Sources.tsx";
import { DuplicateList, useDuplicates } from "./Duplicates.tsx";
import { matches } from "./matching.ts";

type Listing = { status: "reading" } | { status: "listed"; contacts: readonly Contact[]; more: boolean } | { status: "failed"; message: string };

/** Contacts: the people in the contacts the member connected, each a card that opens their page, where they are edited. */
export function ContactsPage({ host, app }: ViewProps & { host: PluginHost }) {
  const [listing, setListing] = useState<Listing>({ status: "reading" });
  const [asked, setAsked] = useState(0);
  const [typed, setTyped] = useState("");
  const { sources, setSources, problem } = useSources(host);

  useEffect(() => {
    let live = true;
    host.perform({ type: "contact.list" }).then(
      (answer) => {
        if (!live) return;
        setListing({ status: "listed", contacts: answer.contacts, more: answer.more });
        setSources((known) => withFresher(known, answer.sources));
      },
      (err: Error) => live && setListing({ status: "failed", message: err.message }),
    );
    return () => {
      live = false;
    };
  }, [host, asked, setSources]);

  const connected = (sources ?? []).some((s) => s.kind === "contacts" && s.state === "connected");
  const duplicates = useDuplicates(host, connected, asked);
  const all = listing.status === "listed" ? listing.contacts : null;
  const found = useMemo(() => (all ?? []).filter((contact) => matches(contact, typed)), [all, typed]);

  return (
    <section className="contacts-page" aria-label="Contacts">
      <h1>Contacts</h1>
      {problem && (
        <p role="alert" className="said failed">
          {problem}
        </p>
      )}
      {connected && (
        <>
          {duplicates.problem && (
            <p role="alert" className="said failed">
              {duplicates.problem}
            </p>
          )}
          {duplicates.pairs && <DuplicateList app={app} pairs={duplicates.pairs} onDismiss={(pair) => void duplicates.dismiss(pair)} />}
          <input type="search" className="contacts-search" aria-label="Search contacts" placeholder="Search by name, email or organization" value={typed} onChange={(e) => setTyped(e.target.value)} />
          {listing.status === "failed" && (
            <p role="alert" className="said failed">
              {listing.message}
            </p>
          )}
          {all && (
            <p role="status" className="contacts-count">
              {found.length === all.length ? `${all.length} ${all.length === 1 ? "contact" : "contacts"}` : `${found.length} of ${all.length} contacts`}
              {listing.status === "listed" && listing.more ? ". There are more than are listed here." : ""}
            </p>
          )}
          <ul className="cards contact-cards" aria-label="Contacts">
            {found.map((contact) => (
              <li key={`${contact.sourceId} ${contact.id}`} aria-label={contact.name || "No name"}>
                {/* The card's one action is the person's page, where everything they hold is, to read and to edit. */}
                <a
                  className="card contact-card"
                  href={personPath(contact.name)}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    e.preventDefault();
                    app.go(personPath(contact.name));
                  }}
                >
                  <span className="contact-avatar" data-initials={initialsOf(contact.name)} aria-hidden="true" />
                  <span className="contact-what">
                    <span className="contact-name">{contact.name || "No name"}</span>
                    {contact.organization && <span className="contact-organization">{contact.organization}</span>}
                    {(contact.emails.length > 0 || contact.phones.length > 0) && (
                      <span className="contact-reach">
                        {[...contact.emails, ...contact.phones].map(({ value: said }) => (
                          <span key={said}>{said}</span>
                        ))}
                      </span>
                    )}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
      <Sources
        host={host}
        app={app}
        kind="contacts"
        sources={sources}
        onChange={(next) => {
          setSources(next);
          setListing({ status: "reading" });
          setAsked((n) => n + 1);
        }}
      />
    </section>
  );
}
