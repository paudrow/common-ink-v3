import { useEffect, useState, type FormEvent } from "react";
import { DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS, type ListedFolder, type MeHere } from "../core/protocol.ts";
import { ApiError, perform } from "./api.ts";

const EXPIRIES = [30, DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS];

/** The page `/oauth/authorize` sends a member to, so they can allow an app or send it away. */
export function Connect({ me }: { me: MeHere }) {
  const requestId = new URLSearchParams(location.search).get("request") ?? "";
  const [asking, setAsking] = useState<{ clientName: string; redirectHost: string } | null>(null);
  const [error, setError] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [folders, setFolders] = useState<ListedFolder[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!requestId) return;
    void fetch(`/api/oauth/request?request=${encodeURIComponent(requestId)}`, { credentials: "same-origin" })
      .then(async (res) => {
        const body = (await res.json()) as { clientName?: string; redirectHost?: string; message?: string };
        if (!res.ok || !body.clientName || !body.redirectHost) throw new Error(body.message ?? "This request can't be answered.");
        setAsking({ clientName: body.clientName, redirectHost: body.redirectHost });
      })
      .catch((err: Error) => setError(err.message));
  }, [requestId]);

  useEffect(() => {
    if (!workspaceId) return;
    void perform(workspaceId, { type: "folder.list" }).then(
      (listed) => setFolders(listed.folders),
      () => setFolders(null),
    );
  }, [workspaceId]);

  const answer = async (path: string, body: unknown) => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const sent = (await res.json()) as { redirect?: string; message?: string };
      if (!res.ok || !sent.redirect) throw new ApiError(res.status, "unknown", sent.message ?? "Common Ink couldn't answer this.");
      location.assign(sent.redirect);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Common Ink couldn't answer this.");
    }
  };

  const allow = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const expires = data.get("expires");
    const chosen = data.getAll("folder").filter((id): id is string => typeof id === "string");
    void answer("/api/oauth/consent", {
      requestId,
      name: data.get("name"),
      readOnly: data.has("readOnly"),
      expiresInDays: expires === "never" ? "never" : Number(expires),
      ...(workspaceId ? { workspaceId } : {}),
      ...(chosen.length ? { folderIds: chosen } : {}),
    });
  };

  if (!requestId) return <p className="notice">This page answers an app that asked to connect. Open it from that app.</p>;
  if (error && !asking) return <p className="notice">{error}</p>;
  if (!asking) return null;

  return (
    <main className="connect">
      <h1>An app at {asking.redirectHost} wants to connect</h1>
      <p>
        It calls itself &ldquo;{asking.clientName}&rdquo;, a name it chose and Common Ink has not checked. It will be able to do what you allow here, as you. After you answer, Common Ink sends you back to {asking.redirectHost}. You can disconnect it later from Agents.
      </p>
      <form onSubmit={allow}>
        <label>
          <span>Name on Agents</span>
          <input name="name" defaultValue={asking.clientName} maxLength={60} required />
        </label>
        <label>
          <span>Reaches</span>
          <select name="workspace" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
            <option value="">Every workspace I'm in</option>
            {me.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                Only {w.name}
              </option>
            ))}
          </select>
        </label>
        {workspaceId && folders && folders.length > 0 && (
          <fieldset>
            <legend>Folders, or leave these clear for every note in that workspace</legend>
            {folders.map((folder) => (
              <label key={folder.id} className="check">
                <input type="checkbox" name="folder" value={folder.id} />
                <span>{folder.path}</span>
              </label>
            ))}
          </fieldset>
        )}
        <label>
          <span>Expires</span>
          <select name="expires" defaultValue={DEFAULT_EXPIRY_DAYS}>
            {EXPIRIES.map((days) => (
              <option key={days} value={days}>
                In {days} days
              </option>
            ))}
            <option value="never">Never</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" name="readOnly" />
          <span>Read only: it can read and can't change anything</span>
        </label>
        {error && <p className="error">{error}</p>}
        <div className="connect-actions">
          <button type="submit" className="button primary" disabled={busy}>
            Allow
          </button>
          <button type="button" className="button" disabled={busy} onClick={() => void answer("/api/oauth/deny", { requestId })}>
            Don't allow
          </button>
        </div>
      </form>
    </main>
  );
}
