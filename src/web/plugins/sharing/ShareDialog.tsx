import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Icon, useDismiss, type App, type GrantAccess, type PluginHost, type SharedItem, type Sharing } from "../../plugin-api.ts";
import { Copyable } from "../lib/Copyable.tsx";
import { ACCESS, ACCESS_LABEL, LINK_CHOICES, LINK_LABEL, isPerson, linkAddress, linkOf, toOf, whoOf, type LinkChoice } from "./words.ts";

const ROLE_LABEL = { admin: "Admin", editor: "Editor", viewer: "Viewer" } as const;

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

interface Props {
  host: PluginHost;
  app: App;
  on: SharedItem;
  /** What an upload is called. A note and a folder are named by the app. */
  name?: string;
  close: () => void;
}

/** Who a note, a folder or an upload is shared with, where a member who may share it changes that. */
export function ShareDialog({ host, app, on, name, close }: Props) {
  const ids = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [sharing, setSharing] = useState<Sharing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useDismiss(close, ref);

  const isNote = "noteId" in on;
  const isUpload = "uploadId" in on;
  const itemId = "noteId" in on ? on.noteId : "folderId" in on ? on.folderId : on.uploadId;
  const what = isNote ? "note" : isUpload ? "file" : "folder";
  const title = isNote ? app.notes?.find((n) => n.id === itemId)?.title || "Untitled" : isUpload ? (name ?? "this file") : (app.folders?.byId.get(itemId)?.name ?? "this folder");
  const workspace = app.workspace.name;

  /** How many grants and links went when the note was last made private here. */
  const [removed, setRemoved] = useState(0);
  const others = (sharing?.grants ?? []).filter((g) => g.grantedBy.personId !== app.me.id).length;
  const counted = (n: number) => (n === 1 ? "1 grant or link" : `${n} grants and links`);
  const load = useCallback(() => host.sharing.of(isNote ? { noteId: itemId } : isUpload ? { uploadId: itemId } : { folderId: itemId }).then(setSharing), [host, isNote, isUpload, itemId]);
  useEffect(() => void load().catch((err: Error) => setError(err.message)), [load]);

  /** Does one thing and reads the sharing again, whether or not it worked: a refusal may mean it has changed. */
  const change = async (doing: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    let done = true;
    try {
      await doing();
    } catch (err) {
      done = false;
      setError((err as Error).message);
    }
    await load().catch(() => {});
    setBusy(false);
    // A lock in the note list, and what the member may do with the note, follow from what changed here.
    app.refresh();
    return done;
  };

  const add = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    void change(() => host.sharing.grant(on, (data.get("email") as string).trim(), data.get("access") as GrantAccess)).then((done) => done && form.reset());
  };

  const note = sharing?.note ?? null;
  const link = sharing && linkOf(sharing);
  const people = sharing?.grants.filter(isPerson) ?? [];

  return (
    <div ref={ref} className="share-dialog" role="dialog" aria-label={`Share ${title}`}>
      <header className="share-head">
        <h2>Share “{title}”</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={close}>
          <Icon name="close" />
        </button>
      </header>
      <div className="share-body">
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {!sharing && !error && <p className="hint">Loading…</p>}

        {note && (note.canSetPrivate || note.private || note.released) && (
          <section className="share-section" aria-label="Private">
            {note.canSetPrivate ? (
              <label className="check">
                <input
                  type="checkbox"
                  checked={note.private}
                  disabled={busy}
                  onChange={(e) => {
                    setRemoved(0);
                    void change(() => host.sharing.setPrivate(itemId, e.target.checked).then((done) => setRemoved(done.removed)));
                  }}
                />
                <span>Private</span>
              </label>
            ) : (
              note.private && (
                <p className="share-line">
                  <Icon name="lock" /> Private
                </p>
              )
            )}
            {(note.canSetPrivate || note.private) && (
              <p className="hint">
                {note.private
                  ? `This note is private to ${note.owner?.personId === app.me.id ? "you" : (note.owner?.name ?? "its owner")}. It is hidden from every other member of ${workspace}, admins too, except the people it is shared with below.`
                  : `A private note is hidden from every other member of ${workspace}, admins too. Only you and the people you share it with below can open it.`}
              </p>
            )}
            {note.canSetPrivate && !note.private && others > 0 && (
              <p className="hint">
                Making it private takes away {counted(others)} that other people put on this note. Share it again yourself with anyone who should keep it.
              </p>
            )}
            {removed > 0 && (
              <p className="hint" role="status">
                Took away {counted(removed)} that other people had put on this note.
              </p>
            )}
            {note.released && (
              <p className="hint">
                Was private to {note.released.from} until {note.released.by} removed them on {day(note.released.at)}.
              </p>
            )}
          </section>
        )}

        {sharing && !sharing.canShare && <p className="hint">Only a member who can change this {what} can share it.</p>}

        {sharing?.canShare && (
          <>
            <form className="share-add" aria-label="Add a person" onSubmit={add}>
              <input name="email" type="email" required maxLength={254} placeholder="Add a person by email" aria-label="Email" autoComplete="off" autoFocus />
              <select name="access" aria-label="Access" defaultValue="view">
                {ACCESS.map((access) => (
                  <option key={access} value={access}>
                    {ACCESS_LABEL[access]}
                  </option>
                ))}
              </select>
              <button type="submit" className="button primary" disabled={busy}>
                Share
              </button>
            </form>

            <section className="share-section" aria-labelledby={`${ids}-people`}>
              <h3 id={`${ids}-people`}>Who can open it</h3>
              <ul className="share-list" aria-labelledby={`${ids}-people`}>
                <li className="share-row">
                  <span className="share-who">
                    <span className="share-name">{note?.private ? `Only ${note.owner?.personId === app.me.id ? "you" : (note.owner?.name ?? "its owner")}` : `Everyone in ${workspace}`}</span>
                    <span className="share-meta">{note?.private ? "and the people here" : "as their role allows"}</span>
                  </span>
                </li>
                {people.map((grant) => {
                  const who = whoOf(grant.to);
                  // A member let in to one's own private note is named by who they are, and their email was never told.
                  const changeable = grant.to.email !== null || (grant.to.role !== null && note?.private === true);
                  return (
                    <li key={grant.id} className="share-row" aria-label={who}>
                      <span className="share-who">
                        <span className="share-name">
                          {who}
                          {grant.to.role && <span className="badge">{ROLE_LABEL[grant.to.role]}</span>}
                        </span>
                        <span className="share-meta">
                          {grant.to.personId === null ? `Waiting for ${grant.to.email} to sign in` : grant.to.role ? (note?.private ? "A member, let in to this private note" : `A member, narrowed here`) : (grant.to.email ?? "Guest")}
                        </span>
                      </span>
                      <select
                        aria-label={`Access of ${who}`}
                        value={grant.access}
                        // A grant is changed by its email, or for a member by who they are. The email of a guest is kept from an editor who didn't make the grant.
                        disabled={busy || !changeable}
                        title={changeable ? undefined : "Remove them and add them again to change this"}
                        onChange={(e) => void change(() => host.sharing.grant(on, grant.to.email ?? { memberId: grant.to.personId! }, e.target.value as GrantAccess))}
                      >
                        {ACCESS.map((access) => (
                          <option key={access} value={access}>
                            {ACCESS_LABEL[access]}
                          </option>
                        ))}
                      </select>
                      <button type="button" className="button small" aria-label={`Remove ${who}`} disabled={busy} onClick={() => void change(() => host.sharing.revoke(grant.id))}>
                        Remove
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>

            {sharing.inherited.length > 0 && (
              <section className="share-section" aria-labelledby={`${ids}-inherited`}>
                <h3 id={`${ids}-inherited`}>From the folders above</h3>
                <ul className="share-list" aria-labelledby={`${ids}-inherited`}>
                  {sharing.inherited.map((grant) => (
                    <li key={grant.id} className="share-row">
                      <span className="share-who">
                        <span className="share-name">{toOf(grant)}</span>
                        <span className="share-meta">
                          {ACCESS_LABEL[grant.access]}, from the folder {grant.on.name}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="hint">These are changed on the folder. Sharing this {what} with the same person here takes their place.</p>
              </section>
            )}

            {isUpload && <p className="hint">A file has no link of its own. A link on the folder it is in opens it, for whoever holds that link.</p>}

            {!isUpload && (
              <section className="share-section" aria-labelledby={`${ids}-link`}>
                <h3 id={`${ids}-link`}>Link</h3>
                <select
                  aria-labelledby={`${ids}-link`}
                  value={link?.link ?? "off"}
                  disabled={busy}
                  onChange={(e) => {
                    const choice = e.target.value as LinkChoice;
                    void change(() => host.sharing.link(on, choice === "off" ? null : choice));
                  }}
                >
                  {LINK_CHOICES.map((choice) => (
                    <option key={choice} value={choice}>
                      {LINK_LABEL[choice]}
                    </option>
                  ))}
                </select>
                {link ? (
                  <>
                    {link.token && <Copyable label="Link address" value={linkAddress(location.origin, link.token)} />}
                    <p className="hint">
                      {link.link === "public" ? "Anyone who has this address can read" : "Anyone who has this address and signs in to Common Ink can read"} {isNote ? "this note" : "the notes in this folder"}, and can't change{" "}
                      {isNote ? "it" : "them"}. Turning the link off stops it at once.
                    </p>
                  </>
                ) : (
                  <p className="hint">A link lets people read without being added here.</p>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
