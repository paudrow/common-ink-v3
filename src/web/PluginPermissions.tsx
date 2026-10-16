import { useState, type ReactNode } from "react";
import { CAPABILITIES, HTML_EMBEDS, readOrigin, type Capability, type InstalledPlugin, type Permission, type PluginRecord } from "../core/plugins.ts";
import type { OpInput } from "../core/protocol.ts";
import { perform } from "./api.ts";

type Change = Extract<OpInput, { type: "plugin.permit" | "plugin.request" | "plugin.uninstall" }>;

/** The changes a page makes to the workspace's record of its plugins, with whether one is under way and what the last refusal said. */
export interface RecordChanges {
  busy: boolean;
  error: string | null;
  say: (error: string | null) => void;
  /** Performs one change to the record and shows the record it answers with. A refusal is said, in the server's words, and answers false. */
  change: (op: Change) => Promise<boolean>;
  /**
   * Locks or unlocks a permission, or takes its requests away, leaving what is allowed as it is. The
   * operation says what is allowed each time, so the record is read first: what this page last drew
   * may be older than another admin's decision, or than new code that voided this one.
   */
  keep: (subject: string, capability: Capability, locked?: boolean) => Promise<boolean>;
}

export function useRecordChanges(workspaceId: string, onRecord: (record: PluginRecord) => void): RecordChanges {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const attempt = async (act: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await act();
      return true;
    } catch (err) {
      setError((err as Error).message);
      // A refusal may mean the record has changed since it was read.
      await perform(workspaceId, { type: "plugin.list" }).then(onRecord, () => {});
      return false;
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,
    error,
    say: setError,
    change: (op) => attempt(async () => onRecord(await perform(workspaceId, op))),
    keep: (subject, capability, locked) =>
      attempt(async () => {
        const fresh = await perform(workspaceId, { type: "plugin.list" });
        const plugin = fresh.plugins.find((p) => p.id === subject);
        const now = plugin?.permissions.find((p) => p.capability === capability);
        if (!plugin || !now) return onRecord(fresh);
        const allowed = now.state === "allowed";
        // Saying again that it is allowed names the code just read, as any allowing of a plugin does.
        const restated = allowed && (subject === HTML_EMBEDS ? { origins: now.origins } : plugin.codeHash && { codeHash: plugin.codeHash });
        onRecord(await perform(workspaceId, { type: "plugin.permit", id: subject, capability, allowed, ...(locked !== undefined && { locked }), ...restated }));
      }),
  };
}

/** The sites written in a field, one to a line or with spaces or commas between them. */
export function sitesIn(text: string): { origins: string[] } | { reason: string } {
  const written = text.split(/[\s,]+/).filter(Boolean);
  const wrong = written.find((site) => readOrigin(site) === null);
  if (wrong) return { reason: `${wrong} isn't a site such as https://api.example.com` };
  if (written.length === 0) return { reason: "Name at least one site, such as https://api.example.com" };
  if (written.length > 10) return { reason: "At most 10 sites" };
  return { origins: [...new Set(written)] };
}

interface RowProps {
  subject: InstalledPlugin;
  permission: Permission;
  /** Whether whoever is looking decides, as an admin does. */
  admin: boolean;
  /** The member, to tell their own request from another's. */
  personId: string;
  changes: RecordChanges;
  /** For HTML embeds, whose sites are an admin's to list and not a manifest's. */
  listed?: { origins: () => string[] | null; field: ReactNode };
}

/** One permission: what it is, why it is wanted, how it stands, and what this member can do about it. */
export function PermissionRow({ subject, permission, admin, personId, changes: { busy, change, keep }, listed }: RowProps) {
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
  /** Full trust granted again after the code changed is granted to code nobody has granted: the admin types the plugin's name to say they mean it. */
  const retype = capability === "full-trust" && permission.voided;
  /** What the admin has typed of the plugin's name, while they are asked to. */
  const [typed, setTyped] = useState<string | null>(null);
  const name = subject.manifest.name;
  return (
    <li className="permission" aria-label={of}>
      <div className="permission-head">
        <span className="permission-title">{title}</span>
        <span className="badge" data-state={state}>
          {allowed ? "Allowed" : "Off"}
        </span>
        {locked && <span className="badge">Locked</span>}
        {permission.decidedBy && <span className="agent-meta">decided by {byWhom(permission.decidedBy, permission.decidedVia)}</span>}
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
            <button type="button" className="button small" disabled={busy || locked} title={locked ? "Unlock it first" : undefined} aria-label={`Allow ${of}`} onClick={() => (retype ? setTyped("") : allow())}>
              Allow
            </button>
          )}
          {allowed && (
            <button type="button" className="button small" disabled={busy || locked} title={locked ? "Unlock it first" : undefined} aria-label={`Turn off ${of}`} onClick={() => void change({ type: "plugin.permit", id: subject.id, capability, allowed: false })}>
              Turn off
            </button>
          )}
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
      {admin && typed !== null && (
        <form
          className="confirm retype"
          aria-label={`Grant full trust to the new code of ${name}?`}
          onSubmit={(e) => {
            e.preventDefault();
            if (typed !== name) return;
            setTyped(null);
            allow();
          }}
        >
          <span>
            The code of {name} has changed since it was granted, and none of it has been granted. Read it under Source, then type <strong>{name}</strong> to grant this code.
          </span>
          <input type="text" aria-label={`Type ${name} to grant it`} autoFocus spellCheck={false} autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          <button type="submit" className="button small primary" disabled={busy || typed !== name}>
            Grant it
          </button>
          <button type="button" className="link" onClick={() => setTyped(null)}>
            Cancel
          </button>
        </form>
      )}
      {admin &&
        permission.requests.map((request) => (
          <div key={request.by.id} className="confirm" role="group" aria-label={`${request.by.name} asked for ${of}`}>
            <span>
              {request.by.name} asked for this{request.origins.length > 0 && `, for ${request.origins.join(", ")}`}.
            </span>
            <button type="button" className="button small primary" disabled={busy} onClick={() => (retype ? setTyped("") : void change({ type: "plugin.permit", id: subject.id, capability, allowed: true, ...(listed && { origins: request.origins }), ...read }))}>
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
}

/** Who did something, and the agent that did it for them when one did: "Claude for Ada Lovelace". */
export const byWhom = (member: string, agent: string | null): string => (agent ? `${agent} for ${member}` : member);
