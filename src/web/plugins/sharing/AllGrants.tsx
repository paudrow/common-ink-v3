import { useCallback, useEffect, useState } from "react";
import { ago, useNow, type App, type Grant, type PluginHost } from "../../plugin-api.ts";
import { ACCESS_LABEL, toOf } from "./words.ts";
import { SHARE_OVERLAY } from "./Summary.tsx";

/** Every grant in the workspace, by what it is on, where an admin takes any of them back. */
export function AllGrants({ host, app }: { host: PluginHost; app: App }) {
  const now = useNow();
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => host.sharing.all().then(setGrants), [host]);
  // Read again when the Share dialog closes, which is when the grants may have changed.
  useEffect(() => void load().catch((err: Error) => setError(err.message)), [load, app.overlay]);

  const revoke = async (grant: Grant) => {
    setError(null);
    setSaid(null);
    try {
      await host.sharing.revoke(grant.id);
      setSaid(`${toOf(grant)} no longer has ${grant.on.name || "Untitled"}${grant.to.kind === "link" ? ", and the link opens nothing" : ""}.`);
    } catch (err) {
      setError((err as Error).message);
    }
    await load().catch(() => {});
    app.refresh();
  };

  const items = [...Map.groupBy(grants ?? [], (g) => `${g.on.kind} ${g.on.id}`).values()];

  return (
    <section className="agents sharing" aria-label="Sharing">
      <h1>Sharing</h1>
      <p className="lead">
        Every note and folder in {app.workspace.name} that is shared with a guest, narrowed for a member, or has a link. A private note's sharing is its owner's to see, so it isn't here unless it is
        yours or shared with you.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {said && (
        <p role="status" className="said">
          {said}
        </p>
      )}
      {grants && !grants.length && <p className="empty">Nothing is shared.</p>}
      <ul className="agent-list" aria-label="Shared notes and folders">
        {items.map((of) => {
          const { on } = of[0]!;
          const name = on.name || "Untitled";
          return (
            <li key={`${on.kind} ${on.id}`} className="agent" aria-label={name}>
              <div className="agent-head">
                {on.kind === "note" ? (
                  <a
                    className="agent-name"
                    href={app.notePath(on.id)}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                      e.preventDefault();
                      app.openNote(on.id, { reveal: true });
                    }}
                  >
                    {name}
                  </a>
                ) : (
                  <span className="agent-name">{name}</span>
                )}
                <span className="badge">{on.kind === "note" ? "Note" : "Folder"}</span>
                <span className="member-role">
                  <button type="button" className="button small" aria-label={`Share ${name}`} onClick={() => app.toggleOverlay(SHARE_OVERLAY, on.kind === "note" ? { noteId: on.id } : { folderId: on.id })}>
                    Share
                  </button>
                </span>
              </div>
              <ul className="grant-list" aria-label={`Grants on ${name}`}>
                {of.map((grant) => {
                  const to = toOf(grant);
                  return (
                    <li key={grant.id} className="grant" aria-label={to}>
                      <span className="share-who">
                        <span className="share-name">
                          {to}
                          {grant.to.kind === "person" && grant.to.role && <span className="badge">Member</span>}
                          {grant.to.kind === "person" && grant.to.personId === null && <span className="badge">Waiting</span>}
                        </span>
                        <span className="share-meta">
                          {ACCESS_LABEL[grant.access]}
                          {grant.to.kind === "person" && grant.to.name && grant.to.email ? ` · ${grant.to.email}` : ""} · shared by {grant.grantedBy.name} {ago(grant.createdAt, now)}
                        </span>
                      </span>
                      <button type="button" className="button small" aria-label={`Revoke ${to} on ${name}`} onClick={() => void revoke(grant)}>
                        Revoke
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
