import { useEffect, useId, useRef, useState } from "react";
import type { InstalledPlugin, PluginRecord } from "../core/plugins.ts";
import { ApiError, perform } from "./api.ts";
import type { Host } from "./pluginHost.ts";
import { whyNotTrusted } from "./pluginRun.ts";

/** What full trust is, said the same wherever a member is asked to decide it. */
export const FULL_TRUST_WARNING = [
  "It runs inside Common Ink, not shut off from it. Nothing it does there can be held to a list of permissions.",
  "While you have it on, it can do anything you can do in Common Ink: read and change every note you can open, your private notes included, see what you type, change your settings, and send any of it anywhere. That reaches every workspace you belong to, not only this one, because you are signed in to all of them at once.",
  "Some of what it can do keeps working after you turn it off: it can create an agent token in your name, and share your notes by link.",
  "It can't see notes you can't, and it can't run for anyone who hasn't turned it on themself.",
];

/** What that comes to for an admin, who is shown it as well. */
export const FULL_TRUST_ADMIN_WARNING =
  "You are an admin, so with it on it can also invite people, change roles, and install and approve plugins, including approving a new version of itself or another plugin and turning that on for you without this warning. It can't turn anything on for anyone else.";
/** And for someone who is an admin only of another workspace, which their sign-in reaches too. */
export const FULL_TRUST_ADMIN_ELSEWHERE_WARNING =
  "You are an admin of another workspace, and with it on it can do there what an admin can: invite people, change roles, and install and approve plugins, and turn one on for you without this warning.";

interface SwitchProps {
  plugin: InstalledPlugin;
  host: Host;
  workspaceId: string;
  /** Whether the member's own settings have it on, which they do once they have turned it on here. */
  enabled: boolean;
  /** Whether the member is an admin, who is told what that adds. */
  admin: boolean;
  /** Whether they are an admin of another workspace, which code in the page reaches with their sign-in. */
  adminElsewhere: boolean;
  onRecord: (record: PluginRecord) => void;
}

/**
 * The switch of a plugin that asks for full trust: the one control there is for it. Turning it on
 * is the member's own decision to let that exact code into their session, so it is asked plainly
 * first and recorded on the server. It can't be turned on while no admin's grant of the code stands.
 */
export function FullTrustSwitch({ plugin, host, workspaceId, enabled, admin, adminElsewhere, onRecord }: SwitchProps) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { id, manifest, codeHash } = plugin;
  const why = whyNotTrusted(plugin);
  const granted = plugin.fullTrust?.grantedHash != null && plugin.fullTrust.grantedHash === codeHash;
  const on = enabled && why === null;

  const set = async (turnOn: boolean) => {
    setBusy(true);
    setError(null);
    try {
      onRecord(await perform(workspaceId, { type: "plugin.trust", id, on: turnOn, ...(turnOn && { codeHash: codeHash! }) }));
      host.setEnabled(id, turnOn);
      setAsking(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Common Ink can't be reached");
      setAsking(false);
      // Refused because the plugin is no longer what this page showed: show what it is now.
      await perform(workspaceId, { type: "plugin.list" }).then(onRecord, () => {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="trust-switch">
      <label className="plugin-switch">
        <span>{on ? "On" : "Off"}</span>
        <input type="checkbox" className="switch" aria-label={manifest.name} checked={on} disabled={busy || (!on && !granted)} onChange={(e) => (e.target.checked ? setAsking(true) : void set(false))} />
      </label>
      {asking && <Warning name={manifest.name} forAdmins={admin ? FULL_TRUST_ADMIN_WARNING : adminElsewhere ? FULL_TRUST_ADMIN_ELSEWHERE_WARNING : null} busy={busy} onConfirm={() => void set(true)} onCancel={() => setAsking(false)} />}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}

interface WarningProps {
  name: string;
  /** The line for an admin, of this workspace or of another. Null for anyone else. */
  forAdmins: string | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** The warning, over the page, where nothing else can be pressed until it is answered. Cancel has the keyboard first, and Escape cancels. */
function Warning({ name, forAdmins, busy, onConfirm, onCancel }: WarningProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const title = useId();
  useEffect(() => {
    const focused = document.activeElement;
    const modal = dialog.current!;
    modal.showModal();
    cancel.current!.focus();
    return () => {
      modal.close();
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="trust-dialog"
      aria-labelledby={title}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <div className="trust-dialog-body">
        <h2 id={title}>Turn on {name} with full trust?</h2>
        <ul>
          {FULL_TRUST_WARNING.map((line) => (
            <li key={line}>{line}</li>
          ))}
          {forAdmins && <li>{forAdmins}</li>}
        </ul>
        <p>
          An admin granted this exact code, which you can read on this page under Source. If the code changes, it stops for everyone until an admin grants the new code and each member turns it on again. Turning it off loads Common Ink again, so that none of its code is
          left running. Code that means harm can get in the way of that in a window it is already running in: closing the window ends it, and once it is off or no longer granted, Common Ink never runs it when it is next opened.
        </p>
        <div className="trust-actions">
          <button type="button" className="button small danger" disabled={busy} onClick={onConfirm}>
            Turn it on for me
          </button>
          <button ref={cancel} type="button" className="link" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** Why a plugin that asks for full trust isn't running for whoever is looking, in one line. Nothing when it is. */
export function FullTrustReason({ plugin }: { plugin: InstalledPlugin }) {
  const why = whyNotTrusted(plugin);
  return why === null ? null : (
    <p className="trust-reason" role="status">
      {why}
    </p>
  );
}

/** What stands in place of "it runs shut off" for a plugin that asks for full trust, and for an admin who has it on. */
export function FullTrustLead({ plugin }: { plugin: InstalledPlugin }) {
  const by = plugin.fullTrust?.turnedOnBy;
  return (
    <p className="soon">
      It asks for full trust: to run inside Common Ink and not shut off from it. It runs for a member only while an admin's grant of this exact code stands and that member has turned it on for themself. Otherwise none of it runs.
      {by && ` On for: ${by.length ? by.map((who) => who.name).join(", ") : "nobody"}.`}
    </p>
  );
}
