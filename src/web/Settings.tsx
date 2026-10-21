import { EditorView } from "@codemirror/view";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { dismissing } from "./dismiss.ts";
import { Drawn } from "./Drawn.tsx";
import { Icon } from "./icons.tsx";
import { KeyboardShortcuts } from "./KeyboardShortcuts.tsx";
import { SettingRow } from "./SettingRow.tsx";
import type { Folders, Slots } from "./plugin-api.ts";
import type { Host, MemberSettings } from "./pluginHost.ts";
import { SETTINGS_FILE } from "./SettingsFile.tsx";
import {
  ACCOUNT,
  KEYBOARD,
  UNKNOWN,
  filterLayout,
  layoutOf,
} from "./settingsLayout.ts";
import { statusLabel, type SettingsStore } from "./settingsStore.ts";
import type { AccountDeletion, ClipperGrantView, ExportPlan, UploadStorage } from "../core/protocol.ts";
import { formatBytes } from "./plugins/uploads/sizing.ts";
import { clipperTarget } from "./plugins/lib/clipperLink.ts";
import { listClipperGrants, revokeClipperGrant } from "./api.ts";

interface Props {
  host: Host;
  store: SettingsStore;
  mac: boolean;
  /** Where in the settings it is: `/settings`, or under it a category, such as `/settings/keyboard`. */
  path: string;
  /** Goes to an address: one under `/settings` moves the settings, and any other closes them and goes there. */
  go: (path: string, options?: { replace?: boolean }) => void;
  /** How much the workspace's uploads take, asked each time the page opens. */
  storage: () => Promise<UploadStorage>;
  /** The parts an export of what the member can see here comes in, asked each time the page opens. */
  exportPlan: () => Promise<ExportPlan>;
  onClose: () => void;
  /** What is opened over the settings, such as the command palette: inside their dialog, so it is above it and takes the keys. */
  children?: ReactNode;
  account: Account;
  /** The workspace's folders, which a folder setting is picked from, or null while they are read. */
  folders: Folders | null;
}

/** The person signed in, ending every session they have, and deleting their account or the workspace open now. */
export interface Account {
  email: string;
  signOutEverywhere: (agents: boolean) => Promise<void>;
  /** What deleting the account would take with it, asked before the person confirms. */
  deletion: () => Promise<AccountDeletion>;
  deleteAccount: (email: string) => Promise<void>;
  /** The workspace open now, for an admin of it. Null for anyone else, who can't delete it. */
  workspace: { name: string; delete: (name: string) => Promise<void> } | null;
}

export const ROOT = "/settings";

/**
 * Where a member changes their settings by category, as options drawn from the schema and a table
 * of keyboard shortcuts. The JSON itself is a document of its own, opened in a tab like a note
 * (`SettingsFile`), and both show the one document. It belongs to the app, so it is here whatever is
 * turned off. It opens over whatever the member is doing, as a dialog, and Escape closes it: it is
 * never a tab, so it moves nothing of the window under it.
 */
export function Settings({ host, store, mac, path, go, storage, exportPlan, onClose, children, account, folders }: Props) {
  const { settings, views } = useSyncExternalStore(host.subscribe, host.contributions);
  const text = useSyncExternalStore(store.subscribe, store.text);
  const status = useSyncExternalStore(store.subscribe, store.status);
  const draft = useSyncExternalStore(store.subscribe, store.draft);
  const unread = status.kind === "loading" || status.kind === "unread";
  const at = path.slice(ROOT.length + 1);
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const focused = document.activeElement;
    const modal = dialog.current!;
    modal.showModal();
    close.current!.focus();
    return () => {
      // While it is still open as a modal the rest of the page can't take focus.
      modal.close();
      if (focused instanceof HTMLElement && focused.isConnected) {
        const editor = EditorView.findFromDOM(focused);
        if (editor) editor.focus();
        else focused.focus({ preventScroll: true });
      }
    };
  }, []);

  const problemList = settings.problems.length > 0 && (
    <ul aria-label="Problems" className="settings-problems">
      {settings.problems.map((p, i) => (
        <li key={i} data-kind={p.kind}>
          <code>{p.key}</code> {p.reason}
        </li>
      ))}
    </ul>
  );

  return (
    // Its role is said for what looks for a dialog over the window by it, as the inspector and vim's keys do.
    <dialog
      ref={dialog}
      role="dialog"
      aria-label="Settings"
      className="settings-overlay"
      onCancel={(e) => e.preventDefault()}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => {
        // A menu or the palette open over the settings closes first, on the window's own Escape.
        if (e.key !== "Escape" || e.defaultPrevented || dismissing()) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <section className="settings">
        <div className="settings-head">
          <h1>Settings</h1>
          <span role="status" className="save-state">
            {draft === null || unread ? statusLabel(status) : "Not saved until the JSON is fixed"}
          </span>
          {/* The window's own Try again is under the dialog, where nothing can be pressed. */}
          {status.kind === "unread" && (
            <button type="button" className="button small" onClick={() => void store.load()}>
              Try again
            </button>
          )}
          <button type="button" className="button small" onClick={() => go(SETTINGS_FILE)}>
            Open settings (JSON)
          </button>
          <button ref={close} type="button" className="icon-button" aria-label="Close settings" title="Close (Escape)" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <p className="soon">Yours alone, in this workspace. Only what you change from a default is kept.</p>
        <Options settings={settings} locked={unread ? "unread" : draft !== null ? "json" : null} mac={mac} picked={at} go={go} onSet={host.setSetting} account={account} folders={folders} storage={storage} exportPlan={exportPlan} host={host} panes={views.settings} />
        {problemList}
      </section>
      {children}
    </dialog>
  );
}

/** How much the workspace's files take, every member's, those in Trash among them. There is no limit to it: storage is paid by the gigabyte. */
function Storage({ storage }: Pick<Props, "storage">) {
  const [told, setTold] = useState<UploadStorage | "failed" | null>(null);
  useEffect(() => {
    let current = true;
    storage().then(
      (got) => current && setTold(got),
      () => current && setTold("failed"),
    );
    return () => void (current = false);
  }, []);
  return (
    <section aria-label="Storage" className="settings-storage">
      <h3>Storage</h3>
      <p>
        {told === null
          ? "Counting this workspace's files…"
          : told === "failed"
            ? "How much this workspace's files take couldn't be read just now."
            : `This workspace's files take ${formatBytes(told.bytes)}, ${told.files} file${told.files === 1 ? "" : "s"} from every member${told.trashedBytes ? `, ${formatBytes(told.trashedBytes)} of it in Trash` : ""}.${told.pendingBytes ? ` ${formatBytes(told.pendingBytes)} more is on its way.` : ""} There is no limit: a file can be up to 25 GB.`}
      </p>
    </section>
  );
}

/** A copy of everything the member can see here, to keep: one zip, or for a workspace with many files one zip a part. */
function Export({ exportPlan }: Pick<Props, "exportPlan">) {
  const [plan, setPlan] = useState<ExportPlan | "failed" | null>(null);
  useEffect(() => {
    let current = true;
    exportPlan().then(
      (got) => current && setPlan(got),
      () => current && setPlan("failed"),
    );
    return () => void (current = false);
  }, []);
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return (
    <section aria-label="Export" className="settings-storage">
      <h3>Export</h3>
      <p>
        {plan === null
          ? "Counting what there is to export…"
          : plan === "failed"
            ? "What there is to export couldn't be read just now."
            : `Every note and file you can see in this workspace, archived ones too, as Markdown and files in their folders: ${count(plan.notes, "note")} and ${count(plan.uploads, "file")}.${plan.parts.length > 1 ? ` That is more than one download takes, so it comes in ${plan.parts.length} parts, each a zip of its own.` : ""}`}
      </p>
      {plan !== null && plan !== "failed" && (
        <ul aria-label="Downloads" className="settings-export">
          {plan.parts.map((part) => (
            <li key={part.number}>
              <a className="button small" href={part.address} download>
                {plan.parts.length === 1 ? "Download" : `Part ${part.number} of ${plan.parts.length}`}
              </a>{" "}
              {plan.parts.length === 1 ? formatBytes(part.bytes) : [part.notes ? count(part.notes, "note") : "", part.uploads ? count(part.uploads, "file") : "", formatBytes(part.bytes)].filter(Boolean).join(", ")}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface OptionsProps {
  settings: MemberSettings;
  /** Why nothing can be changed here: the JSON can't be read, or the stored settings haven't been. */
  locked: "json" | "unread" | null;
  mac: boolean;
  /** The category the address names. One that isn't there reads as the first. */
  picked: string;
  go: Props["go"];
  onSet: Host["setSetting"];
  account: Account;
  folders: Props["folders"];
  storage: Props["storage"];
  exportPlan: Props["exportPlan"];
  host: Host;
  /** The sections plugins add, which hold no setting. */
  panes: readonly Slots["settings"][];
}

/** One entry of the list of categories: where it goes, and how much of what is searched for it holds. */
interface Entry {
  id: string;
  name: string;
  /** Null when nothing is searched for. */
  found: number | null;
}

function Options({
  settings,
  locked,
  mac,
  picked,
  go,
  onSet,
  account,
  folders,
  storage,
  exportPlan,
  host,
  panes: offered,
}: OptionsProps) {
  const [typed, setTyped] = useState("");
  const [modified, setModified] = useState(false);
  /** Whether the member picked one category out of what a search found. Searching again shows them all. */
  const [narrowed, setNarrowed] = useState(false);
  const needle = typed.trim().toLowerCase();
  const filtering = needle !== "" || modified;

  const whole = layoutOf(settings);
  // A plugin's section never takes the place of one of the app's own.
  const panes = offered.filter((pane) => ![KEYBOARD.id, ACCOUNT.id, UNKNOWN.id, ...whole.categories.map((c) => c.id)].includes(pane.id));
  const found = filtering
    ? filterLayout(whole, { needle, modified }, settings.document, mac)
    : whole;
  const unknown = filtering
    ? []
    : settings.problems.filter((p) => p.kind === "unknown");
  const count = (id: string) =>
    id === KEYBOARD.id
      ? found.shortcuts.length
      : (found.categories.find((c) => c.id === id)?.rows.length ?? 0);
  const entry = ({ id, name }: { id: string; name: string }): Entry => ({
    id,
    name,
    found: filtering ? count(id) : null,
  });
  const listed = (plugins: boolean) =>
    found.categories
      .filter((c) => (c.pluginId !== null) === plugins)
      .map(entry);
  // Account and a plugin's section hold no setting, so a search never finds them.
  const own = [
    ...listed(false),
    ...(found.shortcuts.length > 0 ? [entry(KEYBOARD)] : []),
    ...(filtering ? [] : [...panes.map((pane) => entry({ id: pane.id, name: pane.label })), entry(ACCOUNT)]),
  ];
  const plugins = listed(true);
  const rest = unknown.length > 0 ? [entry(UNKNOWN)] : [];
  const entries = [...own, ...plugins, ...rest];
  const all = filtering && !narrowed;
  const current = all
    ? null
    : (entries.find((e) => e.id === picked) ?? entries[0] ?? null);
  const shown = (id: string) => all || current?.id === id;
  const total =
    found.categories.reduce((sum, c) => sum + c.rows.length, 0) +
    found.shortcuts.length;

  const pick = (id: string | null) => {
    setNarrowed(id !== null);
    if (id !== null) go(`${ROOT}/${id}`, { replace: true });
  };
  const search = (next: { typed?: string; modified?: boolean }) => {
    if (next.typed !== undefined) setTyped(next.typed);
    if (next.modified !== undefined) setModified(next.modified);
    setNarrowed(false);
  };
  const link = ({ id, name, found: n }: Entry) => (
    <a
      key={id}
      href={`${ROOT}/${id}`}
      aria-current={current?.id === id ? "page" : undefined}
      aria-label={n === null ? name : `${name}, ${n} found`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        pick(id);
      }}
    >
      <span>{name}</span>
      {n !== null && <span className="settings-count">{n}</span>}
    </a>
  );
  const option = ({ id, name, found: n }: Entry) => (
    <option key={id} value={id}>
      {n === null ? name : `${name} (${n})`}
    </option>
  );

  return (
    <>
      {locked === "json" && (
        <p role="alert" className="settings-locked">
          The JSON has a mistake in it, so nothing can be changed here until it
          is fixed.{" "}
          <button
            type="button"
            className="button small"
            onClick={() => go(SETTINGS_FILE)}
          >
            Show the JSON
          </button>
        </p>
      )}
      <div className="settings-tools">
        <input
          type="search"
          className="filter"
          aria-label="Search settings"
          placeholder="Search settings and keyboard shortcuts"
          value={typed}
          onChange={(e) => search({ typed: e.target.value })}
        />
        <button
          type="button"
          className="button small"
          aria-pressed={modified}
          title="Show only what you changed from its default"
          onClick={() => search({ modified: !modified })}
        >
          Modified
        </button>
      </div>
      <div className="settings-body">
        <nav aria-label="Categories" className="settings-nav">
          {filtering && (
            <a
              href={ROOT}
              aria-current={all ? "page" : undefined}
              aria-label={`All results, ${total} found`}
              onClick={(e) => {
                e.preventDefault();
                pick(null);
              }}
            >
              <span>All results</span>
              <span className="settings-count">{total}</span>
            </a>
          )}
          {own.map(link)}
          {plugins.length > 0 && <h2>Plugins</h2>}
          {plugins.map(link)}
          {rest.map(link)}
        </nav>
        {/* The same list for a window too narrow to keep it beside the settings. Only one of the two is ever shown. */}
        <select
          className="settings-pick"
          aria-label="Category"
          value={current?.id ?? ""}
          onChange={(e) => pick(e.target.value || null)}
        >
          {filtering && <option value="">All results ({total})</option>}
          {own.map(option)}
          {plugins.length > 0 && (
            <optgroup label="Plugins">{plugins.map(option)}</optgroup>
          )}
          {rest.map(option)}
        </select>
        {current?.id === ACCOUNT.id ? (
          <div className="settings-pane">
            <AccountSection account={account} storage={storage} exportPlan={exportPlan} />
          </div>
        ) : panes.some((pane) => pane.id === current?.id) ? (
          <div className="settings-pane">
            {panes
              .filter((pane) => pane.id === current?.id)
              .map((pane) => (
                <section key={pane.id} aria-label={pane.label} className="settings-group">
                  <h2>{pane.label}</h2>
                  <Drawn host={host} view={pane} />
                </section>
              ))}
          </div>
        ) : (
          <fieldset
            disabled={locked !== null}
            className="settings-pane"
            data-list
          >
            {filtering && total === 0 && (
              <p className="soon">
                {modified && !needle
                  ? "You haven't changed anything from its default."
                  : "No setting or keyboard shortcut matches."}
              </p>
            )}
            {found.categories
              .filter((c) => shown(c.id))
              .map((category) => (
                <section
                  key={category.id}
                  aria-label={category.name}
                  className="settings-group"
                >
                  <h2>
                    {category.name}
                    {category.pluginId !== null && (
                      <a
                        href={`/plugins/${category.pluginId}`}
                        className="settings-about-plugin"
                        onClick={(e) => {
                          e.preventDefault();
                          go(`/plugins/${category.pluginId}`);
                        }}
                      >
                        About this plugin
                      </a>
                    )}
                  </h2>
                  {category.rows.some((d) => !d.active) && (
                    <p className="soon">
                      {category.name} is off, so its options change nothing
                      until it is turned on on the Plugins page.
                    </p>
                  )}
                  {category.rows.map((d) => (
                    <SettingRow
                      key={d.key}
                      declared={d}
                      value={settings.values[d.key]!}
                      modified={Object.hasOwn(settings.document, d.key)}
                      problems={settings.problems.filter(
                        (p) => p.key === d.key,
                      )}
                      mac={mac}
                      folders={folders}
                      onSet={(value) => onSet(d.key, value)}
                    />
                  ))}
                </section>
              ))}
            {shown(KEYBOARD.id) && found.shortcuts.length > 0 && (
              <section aria-label={KEYBOARD.name} className="settings-group">
                <h2>{KEYBOARD.name}</h2>
                <p className="soon">
                  Record a key for a command by pressing it. A key you choose is
                  taken from a command that only had it by default.
                </p>
                <KeyboardShortcuts
                  shortcuts={found.shortcuts}
                  all={whole.shortcuts}
                  mac={mac}
                  onSet={onSet}
                />
              </section>
            )}
            {shown(UNKNOWN.id) && unknown.length > 0 && (
              <section aria-label={UNKNOWN.name} className="settings-group">
                <h2>{UNKNOWN.name}</h2>
                <p className="soon">
                  These are in your JSON and do nothing. They are kept until you
                  remove them.
                </p>
                {unknown.map((p) => (
                  <div key={p.key} className="setting" data-row>
                    <div className="setting-head">
                      <code>{p.key}</code>
                      <button
                        type="button"
                        className="button small"
                        aria-label={`Remove ${p.key}`}
                        onClick={() => onSet(p.key, undefined)}
                      >
                        Remove
                      </button>
                    </div>
                    <p className="error">{p.reason}</p>
                  </div>
                ))}
              </section>
            )}
          </fieldset>
        )}
      </div>
    </>
  );
}

/**
 * Kept apart from the settings, so JSON that can't be read never stands between a person and signing out everywhere. What the
 * workspace's files take and an export of it are here too, before what deletes the account or the workspace.
 */
function AccountSection({ account, storage, exportPlan }: { account: Account } & Pick<Props, "storage" | "exportPlan">) {
  const [asked, ask] = useState(false);
  const [agents, setAgents] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const signOut = async () => {
    setError(null);
    try {
      await account.signOutEverywhere(agents);
    } catch (err) {
      ask(false);
      setError((err as Error).message);
    }
  };
  return (
    <section aria-label={ACCOUNT.name} className="settings-group">
      <h2>{ACCOUNT.name}</h2>
      <p className="soon">Signed in as {account.email}, with Google.</p>
      <div className="setting" data-row>
        <div className="setting-head">
          <span>Sign out everywhere</span>
        </div>
        <p className="setting-about">
          Signs you out of Common Ink in every browser you are signed in on,
          this one too, in every workspace. Use it after signing in on a
          computer that isn't yours, or losing one. It signs your clipper out
          too, and disconnects your agents unless you say otherwise: connect
          again the ones you still trust.
        </p>
        <div className="setting-control">
          {asked ? (
            <span
              className="confirm"
              role="group"
              aria-label="Sign out everywhere"
            >
              <span>Every browser, this one too, is signed out at once.</span>
              <label className="check">
                <input
                  type="checkbox"
                  checked={agents}
                  onChange={(e) => setAgents(e.target.checked)}
                />
                <span>Also disconnect my agents</span>
              </label>
              <button
                type="button"
                className="button small primary"
                autoFocus
                onClick={() => void signOut()}
              >
                Sign out everywhere
              </button>
              <button type="button" className="link" onClick={() => ask(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="button small"
              onClick={() => ask(true)}
            >
              Sign out everywhere…
            </button>
          )}
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
      <ClipperRow />
      <Storage storage={storage} />
      <Export exportPlan={exportPlan} />
      {account.workspace && <DeleteWorkspaceRow workspace={account.workspace} />}
      <DeleteAccountRow account={account} />
    </section>
  );
}

const BACKUPS = "Backups of Common Ink keep it for up to 30 days more, and then it is gone from them too.";

/** Asks for `expected` to be typed before `run` is let go: the last step of something nothing undoes. */
function Retyped({ label, expected, prompt, action, run, onCancel }: { label: string; expected: string; prompt: ReactNode; action: string; run: (typed: string) => Promise<void>; onCancel: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim().toLowerCase() === expected.trim().toLowerCase();
  return (
    <form
      className="confirm retype"
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        if (!matches || busy) return;
        setBusy(true);
        setError(null);
        run(typed).catch((err: Error) => {
          setBusy(false);
          setError(err.message);
        });
      }}
    >
      <span>{prompt}</span>
      <input type="text" aria-label={`Type ${expected} to confirm`} autoFocus spellCheck={false} autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
      <button type="submit" className="button small danger" disabled={!matches || busy}>
        {busy ? "Deleting…" : action}
      </button>
      <button type="button" className="link" onClick={onCancel}>
        Cancel
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}

/** Deleting the workspace open now, for an admin of it. */
function DeleteWorkspaceRow({ workspace }: { workspace: NonNullable<Account["workspace"]> }) {
  const [asked, ask] = useState(false);
  return (
    <div className="setting" data-row>
      <div className="setting-head">
        <span>Delete workspace</span>
      </div>
      <p className="setting-about">
        Deletes {workspace.name} for everyone in it: every note, folder, file and change, its plugins, and its links and invites. Its members lose it at once, and
        their own workspaces and accounts are left as they are. Nothing brings it back. {BACKUPS}
      </p>
      <div className="setting-control">
        {asked ? (
          <Retyped
            label="Delete workspace"
            expected={workspace.name}
            prompt={
              <>
                Type <strong>{workspace.name}</strong> to delete it and everything in it.
              </>
            }
            action="Delete workspace"
            run={workspace.delete}
            onCancel={() => ask(false)}
          />
        ) : (
          <button type="button" className="button small danger" onClick={() => ask(true)}>
            Delete workspace…
          </button>
        )}
      </div>
    </div>
  );
}

/** Deleting the person's own account, which says first what goes with it and what waits on them. */
function DeleteAccountRow({ account }: { account: Account }) {
  const [plan, setPlan] = useState<AccountDeletion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = () => {
    setError(null);
    account.deletion().then(setPlan, (err: Error) => setError(err.message));
  };
  const names = (workspaces: AccountDeletion["deletes"]) => workspaces.map((w) => w.name).join(", ");
  return (
    <div className="setting" data-row>
      <div className="setting-head">
        <span>Delete account</span>
      </div>
      <p className="setting-about">
        Deletes your account, and with it everything that was yours alone: your private notes and files, your daily notes that are private, your settings, agents,
        clipper and data sources, and every workspace you are the only member of. In workspaces you share, what you wrote stays, said to be by a former member, and
        what you shared stays shared. You are signed out everywhere at once. Nothing brings it back. {BACKUPS}
      </p>
      <div className="setting-control">
        {plan === null ? (
          <button type="button" className="button small danger" onClick={open}>
            Delete account…
          </button>
        ) : plan.blocking.length ? (
          <span className="confirm" role="group" aria-label="Delete account">
            <span>
              You are the only admin of {names(plan.blocking)}, where others are members. Make someone else an admin on Members, or delete the workspace, first.
            </span>
            <button type="button" className="link" onClick={() => setPlan(null)}>
              Close
            </button>
          </span>
        ) : (
          <Retyped
            label="Delete account"
            expected={plan.email}
            prompt={
              <>
                {plan.deletes.length > 0 && <>{names(plan.deletes)} {plan.deletes.length === 1 ? "is" : "are"} deleted with it, since nobody else is in {plan.deletes.length === 1 ? "it" : "them"}. </>}
                Type <strong>{plan.email}</strong> to delete your account.
              </>
            }
            action="Delete my account"
            run={account.deleteAccount}
            onCancel={() => setPlan(null)}
          />
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

const shortDate = (time: number) =>
  new Date(time).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/** The Chrome clipper this member allowed, if any, and revoking it from here. */
function ClipperRow() {
  const target = clipperTarget();
  const zip = target?.kind === "zip" ? target : null;
  const [grants, setGrants] = useState<readonly ClipperGrantView[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    listClipperGrants().then(
      (list) => live && setGrants(list),
      (err: Error) => live && setError(err.message),
    );
    return () => void (live = false);
  }, []);
  const revoke = async (id: string) => {
    setError(null);
    try {
      await revokeClipperGrant(id);
      setGrants((list) => list?.filter((grant) => grant.id !== id) ?? null);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="setting" data-row aria-label="Clipper">
      <div className="setting-head">
        <span>Clipper</span>
      </div>
      <p className="setting-about">
        The Chrome clipper you allowed can create notes and upload what it
        clips, as you. Revoke it to sign it out.
      </p>
      {grants?.length === 0 && (
        <p className="soon">No clipper is signed in.</p>
      )}
      {grants?.map((grant) => (
        <div className="setting-control" key={grant.id}>
          <span>
            Extension <code>{grant.extensionId}</code>, allowed{" "}
            {shortDate(grant.createdAt)}, until {shortDate(grant.expiresAt)}
          </span>
          <button
            type="button"
            className="button small"
            onClick={() => void revoke(grant.id)}
          >
            Revoke
          </button>
        </div>
      ))}
      {zip && (
        <div className="setting-control">
          <span>
            This build of the clipper, to try before it is in the Chrome Web
            Store. Unzip it, open <code>chrome://extensions</code>, turn on
            Developer mode, choose Load unpacked, and pick the unzipped folder.
            For a newer build, unzip it over that folder and press the
            clipper&rsquo;s reload button there.
          </span>
          <a className="button small" href={zip.url} download>
            Download
          </a>
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
