import { useState } from "react";
import { CAPABILITIES, MAX_PLUGIN_CODE, readManifest, type Capability, type InstalledPlugin, type Manifest, type PluginRecord } from "../core/plugins.ts";
import { perform } from "./api.ts";

interface Props {
  workspaceId: string;
  /** The installed plugin the form is to take the place of, when the admin pressed Update. */
  replacing?: InstalledPlugin;
  onRecord: (record: PluginRecord) => void;
  /** Called once the plugin is installed, or when an update is given up. */
  onDone?: () => void;
}

/** A plugin's manifest and code as an admin pasted them, read and waiting for the admin to say what it may do. */
interface Review {
  manifest: Manifest;
  text: string;
  code: string;
  /** The capabilities the admin ticked. None are to begin with. */
  allow: ReadonlySet<Capability>;
}

const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** Where an admin pastes a plugin's manifest and code, reads what it asks for, and installs it or puts it in the place of one installed. */
export function InstallForm({ workspaceId, replacing, onRecord, onDone }: Props) {
  const [busy, setBusy] = useState(false);
  const [manifestText, setManifestText] = useState("");
  const [code, setCode] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);

  const look = () => {
    setFormError(null);
    const read = readManifest(manifestText);
    if ("reason" in read) return setFormError(read.reason);
    if (!code.trim()) return setFormError("Paste the plugin's code");
    if (code.length > MAX_PLUGIN_CODE) return setFormError(`A plugin's code is at most ${MAX_PLUGIN_CODE} characters`);
    setReview({ manifest: read.manifest, text: manifestText, code, allow: new Set() });
  };

  const install = async () => {
    if (!review) return;
    setFormError(null);
    setBusy(true);
    try {
      const made = await perform(workspaceId, { type: "plugin.install", manifest: review.text, code: review.code, ...(replacing && { replaces: replacing.id }) });
      onRecord(made);
      setReview(null);
      setManifestText("");
      setCode("");
      const codeHash = made.plugins.find((p) => p.id === made.id)?.codeHash ?? undefined;
      for (const capability of review.allow) onRecord(await perform(workspaceId, { type: "plugin.permit", id: made.id, capability, allowed: true, codeHash }));
      onDone?.();
    } catch (err) {
      setFormError((err as Error).message);
      await perform(workspaceId, { type: "plugin.list" }).then(onRecord, () => {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="connect install"
      aria-label={replacing ? `Update ${replacing.manifest.name}` : "Install a plugin"}
      onSubmit={(e) => {
        e.preventDefault();
        look();
      }}
    >
      <h2>{replacing ? `Update ${replacing.manifest.name}` : "Install a plugin"}</h2>
      <p className="soon">
        {replacing
          ? "Paste the new manifest and code. It keeps its place in the workspace and its name in History. Everything it was permitted is off again until you allow it for the new code."
          : "Paste a plugin's manifest and its code. Nothing is fetched from anywhere: what you paste is what runs. Installing permits nothing."}
      </p>
      <label>
        <span>Manifest (JSON)</span>
        <textarea aria-label="Manifest" rows={6} spellCheck={false} value={manifestText} disabled={!!review} onChange={(e) => setManifestText(e.target.value)} />
      </label>
      <label>
        <span>Code (JavaScript)</span>
        <textarea aria-label="Code" rows={6} spellCheck={false} value={code} disabled={!!review} onChange={(e) => setCode(e.target.value)} />
      </label>
      {formError && (
        <p role="alert" className="error">
          {formError}
        </p>
      )}
      {!review && (
        <div className="agent-actions">
          <button type="submit" className="button primary">
            Review
          </button>
          {replacing && (
            <button type="button" className="link" onClick={onDone}>
              Cancel
            </button>
          )}
        </div>
      )}
      {review && (
        <div className="new-token review" role="group" aria-label={`Review ${review.manifest.name}`}>
          <h2>
            {review.manifest.name} <span className="agent-meta">version {review.manifest.version}</span>
          </h2>
          {review.manifest.description && <p className="agent-meta">{review.manifest.description}</p>}
          <p className="agent-meta">
            {review.code.length.toLocaleString()} characters of code. It adds {count(review.manifest.commands.length, "command")}, {count(review.manifest.views.length, "view")} and {count(review.manifest.embeds.length, "embed")}.
          </p>
          {review.manifest.embeds.length > 0 && (
            <p className="permission-detail">
              Its embeds run as soon as a note that writes one is opened, for every member who has turned the plugin on, with what it is allowed here. What an embed is handed is written in the note, by anyone who can change that note.
            </p>
          )}
          {review.manifest.capabilities.length === 0 ? (
            <p className="permission-detail">It asks for nothing: it can't read or change anything in the workspace.</p>
          ) : (
            <>
              <p className="permission-detail">Tick what it may do. What you leave unticked stays off, and you can change any of it later.</p>
              <ul className="permissions" aria-label={`What ${review.manifest.name} asks for`}>
                {review.manifest.capabilities.map((declared) => (
                  <li key={declared.name} className="permission" aria-label={CAPABILITIES[declared.name].title}>
                    <label className="check">
                      <input
                        type="checkbox"
                        aria-label={`Allow ${CAPABILITIES[declared.name].title}`}
                        checked={review.allow.has(declared.name)}
                        onChange={(e) => {
                          const allow = new Set(review.allow);
                          if (e.target.checked) allow.add(declared.name);
                          else allow.delete(declared.name);
                          setReview({ ...review, allow });
                        }}
                      />
                      <span className="permission-title">{CAPABILITIES[declared.name].title}</span>
                    </label>
                    <p className="permission-detail">{CAPABILITIES[declared.name].detail}</p>
                    <p className="permission-reason">
                      <span className="agent-meta">{review.manifest.name} says: </span>
                      {declared.reason}
                    </p>
                    {declared.origins && (
                      <ul className="permission-sites" aria-label="Sites it asks for">
                        {declared.origins.map((origin) => (
                          <li key={origin}>{origin}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="permission-warning">
            A plugin can send whatever it is allowed to read to another computer, with or without the network permission: its frame can open a WebRTC connection, and no browser lets Common Ink block that. Allow reading only for a plugin you would trust
            with what it reads.
          </p>
          <div className="agent-actions">
            <button type="button" className="button primary" disabled={busy} onClick={() => void install()}>
              {replacing ? "Update" : "Install"}
            </button>
            <button type="button" className="link" onClick={() => setReview(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
