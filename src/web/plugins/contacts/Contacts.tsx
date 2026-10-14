import { useEffect, useMemo, useState } from "react";
import type { Contact, PluginHost, ViewProps } from "../../plugin-api.ts";
import { personPath } from "../lib/person.ts";
import { Sources, useSources, withFresher } from "../lib/Sources.tsx";
import { matches } from "./matching.ts";

type Listing = { status: "reading" } | { status: "listed"; contacts: readonly Contact[]; more: boolean } | { status: "failed"; message: string };

/** Contacts: the people in the contacts the member connected, to look up and to reference from a note. Nothing here changes them. */
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
          <ul className="contact-list" aria-label="Contacts">
            {found.map((contact) => (
              <li key={`${contact.sourceId} ${contact.id}`} aria-label={contact.name || "No name"}>
                <div className="contact-what">
                  <a
                    className="contact-name"
                    href={personPath(contact.name)}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                      e.preventDefault();
                      app.go(personPath(contact.name));
                    }}
                  >
                    {contact.name || "No name"}
                  </a>
                  {contact.organization && <span className="contact-organization">{contact.organization}</span>}
                  <span className="contact-reach">
                    {contact.emails.map((email) => (
                      <a key={email} href={`mailto:${email}`}>
                        {email}
                      </a>
                    ))}
                    {contact.phones.map((phone) => (
                      <span key={phone}>{phone}</span>
                    ))}
                    {contact.url && /^https?:\/\//.test(contact.url) && (
                      <a href={contact.url} target="_blank" rel="noopener noreferrer">
                        Open in {sources?.find((s) => s.id === contact.sourceId)?.provider ?? "its contacts"}
                      </a>
                    )}
                  </span>
                </div>
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
