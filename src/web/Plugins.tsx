import { useState, type ReactNode } from "react";
import { BUILT_IN_SUBJECTS, CAPABILITIES, HTML_EMBEDS, MAX_PLUGIN_CODE, readManifest, readOrigin, type Capability, type InstalledPlugin, type Manifest, type Permission, type PluginRecord } from "../core/plugins.ts";
import type { OpInput } from "../core/protocol.ts";
import { perform } from "./api.ts";
import type { PluginState } from "./pluginHost.ts";

interface Props {
  workspaceId: string;
  /** The member, to tell their own request from another's. */
  personId: string;
  plugins: readonly PluginState[];
  onToggle: (id: string, enabled: boolean) => void;
  /** The workspace's record of its plugins. Null until it has been read. */
  record: PluginRecord | null;
  /** Told what the record is now, after a change made here. */
  onRecord: (record: PluginRecord) => void;
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

/** The sites written in a field, one to a line or with spaces or commas between them. */
function sitesIn(text: string): { origins: string[] } | { reason: string } {
  const written = text.split(/[\s,]+/).filter(Boolean);
  const wrong = written.find((site) => readOrigin(site) === null);
  if (wrong) return { reason: `${wrong} isn't a site such as https://api.example.com` };
  if (written.length === 0) return { reason: "Name at least one site, such as https://api.example.com" };
  if (written.length > 10) return { reason: "At most 10 sites" };
  return { origins: [...new Set(written)] };
}

/**
 * Where a member turns plugins on and off, and where a workspace's admin installs plugins and says
 * what each may do. It belongs to the app, so it is here whatever is turned off, and no plugin can
 * do what it does. Every word that comes from a plugin's manifest is drawn as text.
 */
export function Plugins({ workspaceId, personId, plugins, onToggle, record, onRecord }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manifestText, setManifestText] = useState("");
  const [code, setCode] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  /** The installed plugin the form is to take the place of, when the admin pressed Update. */
  const [replacing, setReplacing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  /** What the admin has typed in the field for HTML embeds' sites. Null until they type, when it shows the sites allowed. */
  const [sites, setSites] = useState<string | null>(null);

  const admin = record?.canManage ?? false;
  const installed = record?.plugins.filter((p) => p.thirdParty) ?? [];
  const html = record?.plugins.find((p) => p.id === HTML_EMBEDS && !p.thirdParty);
  const stateOf = (id: string) => plugins.find((p) => p.id === id);

  /** Performs one change to the record and shows the record it answers with. A refusal is said, in the server's words. */
  const change = async (op: Extract<OpInput, { type: "plugin.permit" | "plugin.request" | "plugin.uninstall" }>) => {
    setError(null);
    setBusy(true);
    try {
      onRecord(await perform(workspaceId, op));
    } catch (err) {
      setError((err as Error).message);
      // A refusal may mean the record has changed since it was read.
      await perform(workspaceId, { type: "plugin.list" }).then(onRecord, () => {});
    } finally {
      setBusy(false);
    }
  };

  /**
   * Locks or unlocks a permission, or takes its requests away, leaving what is allowed as it is. The
   * operation says what is allowed each time, so the record is read first: what this page last drew
   * may be older than another admin's decision, or than new code that voided this one.
   */
  const keep = async (subject: string, capability: Capability, locked?: boolean) => {
    setError(null);
    setBusy(true);
    try {
      const fresh = await perform(workspaceId, { type: "plugin.list" });
      const plugin = fresh.plugins.find((p) => p.id === subject);
      const now = plugin?.permissions.find((p) => p.capability === capability);
      if (!plugin || !now) return onRecord(fresh);
      const allowed = now.state === "allowed";
      // Saying again that it is allowed names the code just read, as any allowing of a plugin does.
      const restated = allowed && (subject === HTML_EMBEDS ? { origins: now.origins } : plugin.codeHash && { codeHash: plugin.codeHash });
      onRecord(await perform(workspaceId, { type: "plugin.permit", id: subject, capability, allowed, ...(locked !== undefined && { locked }), ...restated }));
    } catch (err) {
      setError((err as Error).message);
      await perform(workspaceId, { type: "plugin.list" }).then(onRecord, () => {});
    } finally {
      setBusy(false);
    }
  };

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
      const made = await perform(workspaceId, { type: "plugin.install", manifest: review.text, code: review.code, ...(replacing && { replaces: replacing }) });
      onRecord(made);
      setReview(null);
      setReplacing(null);
      setManifestText("");
      setCode("");
      const codeHash = made.plugins.find((p) => p.id === made.id)?.codeHash ?? undefined;
      for (const capability of review.allow) onRecord(await perform(workspaceId, { type: "plugin.permit", id: made.id, capability, allowed: true, codeHash }));
    } catch (err) {
      setFormError((err as Error).message);
      await perform(workspaceId, { type: "plugin.list" }).then(onRecord, () => {});
    } finally {
      setBusy(false);
    }
  };

  /**
   * One permission: what it is, why it is wanted, how it stands, and what this member can do about
   * it. `listed` is for HTML embeds, whose sites are an admin's to list and not a manifest's.
   */
  const permissionRow = (subject: InstalledPlugin, permission: Permission, listed?: { origins: () => string[] | null; field: ReactNode }) => {
    const { capability, state, locked } = permission;
    const { title, detail } = CAPABILITIES[capability];
    const of = `${title} for ${subject.manifest.name}`;
    const allowed = state === "allowed";
    const mine = permission.requests.some((r) => r.by.id === personId);
    /** The sites that go with allowing or asking. Null when the field doesn't hold sites, which has been said. */
    const sitesNow = (): { origins?: string[] } | null => {
      if (!listed) return {};
      const origins = listed.origins();
      return origins && { origins };
    };
    /** The code this page showed, so allowing is refused when the plugin has been replaced since. */
    const read = subject.codeHash ? { codeHash: subject.codeHash } : {};
    const allow = () => {
      const sent = sitesNow();
      if (sent) void change({ type: "plugin.permit", id: subject.id, capability, allowed: true, ...sent, ...read });
    };
    const turnOff = (
      <button type="button" className="button small" disabled={busy || locked} title={locked ? "Unlock it first" : undefined} aria-label={`Turn off ${of}`} onClick={() => void change({ type: "plugin.permit", id: subject.id, capability, allowed: false })}>
        Turn off
      </button>
    );
    return (
      <li key={capability} className="permission" aria-label={of}>
        <div className="permission-head">
          <span className="permission-title">{title}</span>
          <span className="badge" data-state={state}>
            {allowed ? "Allowed" : "Off"}
          </span>
          {locked && <span className="badge">Locked</span>}
          {permission.decidedBy && <span className="agent-meta">decided by {permission.decidedBy}</span>}
        </div>
        <p className="permission-detail">{detail}</p>
        <p className="permission-reason">
          {subject.thirdParty && <span className="agent-meta">{subject.manifest.name} says: </span>}
          {permission.reason}
        </p>
        {permission.voided && <p className="permission-detail">It was allowed, and the plugin has changed since. It is off until an admin allows it again.</p>}
        {capability === "network" && permission.origins.length > 0 && (
          <ul className="permission-sites" aria-label={`Sites for ${subject.manifest.name}`}>
            {permission.origins.map((origin) => (
              <li key={origin}>{origin}</li>
            ))}
          </ul>
        )}
        {listed?.field}
        {admin ? (
          <div className="agent-actions">
            {(!allowed || listed) && (
              <button type="button" className="button small" disabled={busy || locked} title={locked ? "Unlock it first" : undefined} aria-label={`Allow ${of}`} onClick={allow}>
                Allow
              </button>
            )}
            {allowed && turnOff}
            <button type="button" className="button small" disabled={busy} aria-label={`${locked ? "Unlock" : "Lock"} ${of}`} onClick={() => void keep(subject.id, capability, !locked)}>
              {locked ? "Unlock" : "Lock"}
            </button>
          </div>
        ) : allowed ? null : locked ? (
          <p className="permission-detail">An admin locked it, so it can't be asked for.</p>
        ) : mine ? (
          <p className="permission-detail" role="status">
            Asked. An admin decides.
          </p>
        ) : (
          <div className="agent-actions">
            <button
              type="button"
              className="button small"
              disabled={busy}
              aria-label={`Ask an admin for ${of}`}
              onClick={() => {
                const sent = sitesNow();
                if (sent) void change({ type: "plugin.request", id: subject.id, capability, ...sent });
              }}
            >
              Ask an admin
            </button>
          </div>
        )}
        {admin &&
          permission.requests.map((request) => (
            <div key={request.by.id} className="confirm" role="group" aria-label={`${request.by.name} asked for ${of}`}>
              <span>
                {request.by.name} asked for this{request.origins.length > 0 && `, for ${request.origins.join(", ")}`}.
              </span>
              <button type="button" className="button small primary" disabled={busy} onClick={() => void change({ type: "plugin.permit", id: subject.id, capability, allowed: true, ...(listed && { origins: request.origins }), ...read })}>
                Approve
              </button>
              {/* Deciding it as it stands is what takes the request away. */}
              <button type="button" className="button small" disabled={busy} onClick={() => void keep(subject.id, capability)}>
                Deny
              </button>
            </div>
          ))}
      </li>
    );
  };

  const htmlPermission = html?.permissions[0];
  const sitesText = sites ?? htmlPermission?.origins.join("\n") ?? "";
  const readSites = () => {
    const read = sitesIn(sitesText);
    if ("reason" in read) setError(read.reason);
    return "origins" in read ? read.origins : null;
  };

  return (
    <section className="mode-view plugins-page">
      <h1>Plugins</h1>
      <p className="soon">Most of Common Ink is plugins that come built in. Turn one off and what it adds goes away until you turn it back on. The choice is kept in your settings.</p>
      <ul className="plugins" aria-label="Plugins">
        {plugins
          .filter((p) => !p.required && !p.installed)
          .map((p) => (
            <li key={p.id}>
              <label>
                <input type="checkbox" checked={p.enabled} onChange={(e) => onToggle(p.id, e.target.checked)} />
                {p.name}
              </label>
              {p.error && (
                <span role="alert" className="error">
                  Failed: {p.error}
                </span>
              )}
            </li>
          ))}
      </ul>

      <h2>Installed plugins</h2>
      <p className="soon">Plugins an admin added to this workspace, written by someone other than Common Ink. Each runs shut off from the app and does only what it is permitted here. One is off for you until you turn it on.</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {record && installed.length === 0 && <p className="soon">None are installed.</p>}
      <ul className="agent-list" aria-label="Installed plugins">
        {installed.map((plugin) => {
          const { name } = plugin.manifest;
          const state = stateOf(plugin.id);
          return (
            <li key={plugin.id} className="agent" aria-label={name}>
              <div className="agent-head">
                <label className="installed-switch">
                  <input type="checkbox" aria-label={`${name}, on for you`} checked={state?.enabled ?? false} onChange={(e) => onToggle(plugin.id, e.target.checked)} />
                  <span className="agent-name">{name}</span>
                </label>
                <span className="agent-meta">version {plugin.manifest.version}</span>
                {plugin.installedBy && <span className="agent-meta">installed by {plugin.installedBy}</span>}
                {admin && (
                  <span className="member-role">
                    <button
                      type="button"
                      className="button small"
                      aria-label={`Update ${name}`}
                      onClick={() => {
                        setReplacing(plugin.id);
                        setReview(null);
                        setFormError(null);
                      }}
                    >
                      Update
                    </button>
                    <button type="button" className="button small danger" aria-label={`Uninstall ${name}`} disabled={busy} onClick={() => setRemoving(plugin.id)}>
                      Uninstall
                    </button>
                  </span>
                )}
              </div>
              {plugin.manifest.description && <p className="agent-meta">{plugin.manifest.description}</p>}
              {state?.error && (
                <p role="alert" className="error">
                  {state.error}
                </p>
              )}
              {removing === plugin.id && (
                <span className="confirm" role="group" aria-label={`Uninstall ${name}?`}>
                  <span>{name} stops for everyone in this workspace, and what it was permitted is forgotten. What it wrote stays, under its name in History.</span>
                  <button
                    type="button"
                    className="button small primary"
                    autoFocus
                    onClick={() => {
                      setRemoving(null);
                      if (replacing === plugin.id) setReplacing(null);
                      void change({ type: "plugin.uninstall", id: plugin.id });
                    }}
                  >
                    Uninstall it
                  </button>
                  <button type="button" className="link" onClick={() => setRemoving(null)}>
                    Cancel
                  </button>
                </span>
              )}
              {plugin.permissions.length === 0 ? (
                <p className="permission-detail">It asks for nothing: it can't read or change anything in the workspace.</p>
              ) : (
                <ul className="permissions" aria-label={`What ${name} may do`}>
                  {plugin.permissions.map((permission) => permissionRow(plugin, permission))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {html && htmlPermission && (
        <>
          <h2>{BUILT_IN_SUBJECTS[HTML_EMBEDS].name}</h2>
          <p className="soon">HTML written in a note runs shut off from the app when whoever is reading presses Run. It reaches no site unless an admin lists the site here.</p>
          <ul className="agent-list" aria-label="HTML embeds">
            <li className="agent">
              <ul className="permissions" aria-label="What HTML embeds may do">
                {permissionRow(html, htmlPermission, {
                  origins: readSites,
                  field: (admin || (htmlPermission.state !== "allowed" && !htmlPermission.locked && !htmlPermission.requests.some((r) => r.by.id === personId))) && (
                    <label className="sites-field">
                      <span>Sites, one to a line</span>
                      <textarea aria-label="Sites HTML embeds may reach" rows={2} spellCheck={false} placeholder="https://api.example.com" value={sitesText} onChange={(e) => setSites(e.target.value)} />
                    </label>
                  ),
                })}
              </ul>
            </li>
          </ul>
        </>
      )}

      {admin && (
        <form
          className="connect install"
          aria-label="Install a plugin"
          onSubmit={(e) => {
            e.preventDefault();
            look();
          }}
        >
          <h2>{replacing ? `Update ${installed.find((p) => p.id === replacing)?.manifest.name ?? "a plugin"}` : "Install a plugin"}</h2>
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
                <button type="button" className="link" onClick={() => setReplacing(null)}>
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
      )}
    </section>
  );
}
