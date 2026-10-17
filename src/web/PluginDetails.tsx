import { useState, useSyncExternalStore, type ReactNode } from "react";
import { CAPABILITIES, HTML_EMBEDS, type DraftSummary, type InstalledPlugin, type PluginRecord } from "../core/plugins.ts";
import { Icon } from "./icons.tsx";
import { chordFor, chordLabel } from "./keybindings.ts";
import type { Slots } from "./plugin-api.ts";
import { INSTALLED_EMBED, type Added, type Contributions, type Host } from "./pluginHost.ts";
import { MoreMenu } from "./MoreMenu.tsx";
import { InstallForm } from "./PluginInstall.tsx";
import { PLUGINS_PATH, asksTrust, kindLabel, within, type Listed } from "./pluginList.ts";
import { FullTrustLead, FullTrustReason, FullTrustSwitch } from "./PluginTrust.tsx";
import { byWhom, PermissionRow, sitesIn, useRecordChanges, type RecordChanges } from "./PluginPermissions.tsx";
import { PluginSource } from "./PluginSource.tsx";
import { SettingRow } from "./SettingRow.tsx";
import { statusLabel, type SettingsStore } from "./settingsStore.ts";

export interface PluginsProps {
  host: Host;
  /** Whether the member is an admin of a workspace other than this one, which the warning before full trust says the reach of. */
  adminElsewhere: boolean;
  /** The member's settings as they are kept, for whether they have been read yet. */
  store: SettingsStore;
  workspaceId: string;
  /** The member, to tell their own request from another's. */
  personId: string;
  mac: boolean;
  /** The workspace's record of its plugins. Null until it has been read. */
  record: PluginRecord | null;
  /** Told what the record is now, after a change made here. */
  onRecord: (record: PluginRecord) => void;
  /** The member's own drafts of plugins, as last read. */
  drafts: readonly DraftSummary[];
  /** Told the member's drafts are now these, after one was saved, set running or not, or discarded. */
  onDrafts: (drafts: readonly DraftSummary[]) => void;
  /** The address the app is at: `/plugins`, or `/plugins/<plugin id>` for one plugin's details. */
  path: string;
  go: (path: string) => void;
}

interface Props extends PluginsProps {
  plugin: Listed;
  contributed: Contributions;
}

/** What a view in each slot is, said to someone reading what a plugin adds. */
const SLOT_WORDS: Record<keyof Slots, string> = {
  column: "A column beside the editor",
  section: "A section of the sidebar",
  editor: "The editor area",
  folder: "A folder's list of notes",
  inspector: "An inspector panel",
  page: "A page",
  bar: "The bottom bar",
  overlay: "Something drawn over the app",
  mark: "A mark under a note's title",
  tool: "A button at a note's top right",
  notice: "A banner above a note's text",
};

/** What a third-party plugin adds, as its manifest lists it, which is known whether or not it is on. */
const declaredBy = ({ manifest }: InstalledPlugin): Added => ({
  commands: manifest.commands,
  views: manifest.views,
  embeds: manifest.embeds.map((embed) => ({ name: INSTALLED_EMBED + embed.name, title: embed.title, block: false })),
  completions: [],
  editorExtensions: [],
});

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="plugin-section" aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/**
 * One plugin: what it is, whose it is, what it is permitted, what it adds, its pictures, its
 * options, which are changed here as they are in Settings, its source to read, and its switch. For a third-party plugin
 * an admin decides its permissions here, and updates and uninstalls it.
 */
export function PluginDetails({ plugin, contributed, host, store, workspaceId, personId, adminElsewhere, mac, record, onRecord, drafts, onDrafts, go }: Props) {
  const changes = useRecordChanges(workspaceId, onRecord);
  const [updating, setUpdating] = useState(false);
  const [removing, setRemoving] = useState(false);
  const { id, name, state } = plugin;
  const admin = record?.canManage ?? false;
  const theirs = plugin.kind === "third-party" ? plugin.record : null;
  /** A workspace's plugin that asks to run inside the app, which is turned on with a warning and not by the switch every other has. */
  const trusting = asksTrust(plugin) ? theirs : null;
  const adds = theirs ? declaredBy(theirs) : (state?.adds ?? null);
  const { settings } = contributed;
  const options = settings.declared.filter((d) => d.group.id === id && !d.switch);
  /** Until the member's settings have been read nothing can be set, here as in Settings. */
  const status = useSyncExternalStore(store.subscribe, store.status);
  const unread = status.kind === "loading" || status.kind === "unread";
  const screenshots = state?.screenshots ?? [];

  return (
    <section className="mode-view plugins-page plugin-details">
      <a className="plugin-back" {...within(go, PLUGINS_PATH)}>
        All plugins
      </a>
      <header className="plugin-head">
        <span className="plugin-icon">
          <Icon name={plugin.icon} />
        </span>
        <div className="plugin-text">
          <h1>{name}</h1>
          {(theirs || state?.builtIn) && (
            <p className="plugin-meta">
              <span className="badge" data-kind={plugin.kind} data-trust={asksTrust(plugin) || undefined}>
                {kindLabel(plugin)}
              </span>
              {drafts.some((draft) => draft.pluginId === id && draft.running) && (
                <span className="badge" data-state="draft">
                  Running your draft
                </span>
              )}
              {theirs ? (
                <>
                  <span>version {theirs.manifest.version}</span>
                  {theirs.installedBy && <span>installed by {byWhom(theirs.installedBy, theirs.installedVia)}</span>}
                  {theirs.updatedBy && <span>updated by {byWhom(theirs.updatedBy, theirs.updatedVia)}</span>}
                </>
              ) : (
                <span>Comes with Common Ink</span>
              )}
            </p>
          )}
        </div>
        {theirs && admin && (
          <MoreMenu
            label={`More for ${name}`}
            title="Update or uninstall it"
            items={[
              { label: "Update…", action: () => setUpdating(true) },
              { label: "Uninstall…", action: () => setRemoving(true), disabled: changes.busy, separated: true },
            ]}
          />
        )}
        {trusting ? (
          <FullTrustSwitch plugin={trusting} host={host} workspaceId={workspaceId} enabled={state?.enabled ?? false} admin={admin} adminElsewhere={adminElsewhere} onRecord={onRecord} />
        ) : (
          <label className="plugin-switch">
            <span>{state?.enabled ? "On" : "Off"}</span>
            <input type="checkbox" className="switch" aria-label={name} checked={state?.enabled ?? false} disabled={!state} onChange={(e) => host.setEnabled(id, e.target.checked)} />
          </label>
        )}
      </header>
      {plugin.description && <p className="plugin-lead">{plugin.description}</p>}
      {trusting && <FullTrustReason plugin={trusting} />}
      {state?.error && (
        <p role="alert" className="error">
          {theirs ? state.error : `Failed: ${state.error}`}
        </p>
      )}
      {changes.error && (
        <p role="alert" className="error">
          {changes.error}
        </p>
      )}
      {theirs && removing && (
        <span className="confirm" role="group" aria-label={`Uninstall ${name}?`}>
          <span>{name} stops for everyone in this workspace, and what it was permitted is forgotten. What it wrote stays, under its name in History.</span>
          <button type="button" className="button small primary" autoFocus onClick={() => void changes.change({ type: "plugin.uninstall", id }).then((done) => (done ? go(PLUGINS_PATH) : setRemoving(false)))}>
            Uninstall it
          </button>
          <button type="button" className="link" onClick={() => setRemoving(false)}>
            Cancel
          </button>
        </span>
      )}
      {theirs && updating && <InstallForm workspaceId={workspaceId} replacing={theirs} onRecord={onRecord} onDone={() => setUpdating(false)} />}

      {screenshots.length > 0 && (
        <Section title="Pictures">
          <div className="plugin-shots">
            {screenshots.map((shot) => (
              <figure key={shot.src}>
                <img className={shot.dark ? "shot-light" : undefined} src={shot.src} alt={shot.alt} loading="lazy" />
                {shot.dark && <img className="shot-dark" src={shot.dark} alt={shot.alt} loading="lazy" />}
                <figcaption>{shot.alt}</figcaption>
              </figure>
            ))}
          </div>
        </Section>
      )}

      <Section title="Permissions">
        {theirs ? (
          <>
            {trusting ? <FullTrustLead plugin={trusting} /> : <p className="soon">It runs shut off from the app, and does only what is allowed here. An admin decides each.</p>}
            {theirs.permissions.length === 0 ? (
              <p className="permission-detail">It asks for nothing: it can't read or change anything in the workspace.</p>
            ) : (
              <ul className="permissions" aria-label={`What ${name} may do`}>
                {theirs.permissions.map((permission) => (
                  <PermissionRow key={permission.capability} subject={theirs} permission={permission} admin={admin} personId={personId} changes={changes} />
                ))}
              </ul>
            )}
          </>
        ) : plugin.own ? (
          <>
            <p className="soon">It comes with Common Ink and runs shut off from the app, through the same door a third-party plugin does. It does only what it declares here, and the server holds it to that.</p>
            {plugin.own.capabilities.length === 0 ? (
              <p className="permission-detail">It asks for nothing: it can't read or change anything in the workspace.</p>
            ) : (
              <ul className="permissions" aria-label={`What ${name} may do`}>
                {plugin.own.capabilities.map((declared) => (
                  <li key={declared.name} className="permission" aria-label={`${CAPABILITIES[declared.name].title} for ${name}`}>
                    <div className="permission-head">
                      <span className="permission-title">{CAPABILITIES[declared.name].title}</span>
                      <span className="badge" data-state="allowed">
                        Comes with the app
                      </span>
                    </div>
                    <p className="permission-detail">{CAPABILITIES[declared.name].detail}</p>
                    <p className="permission-reason">{declared.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            <p className="soon">
              {state?.builtIn ? "It comes with Common Ink and runs" : "It runs"} inside the app as you, so it asks for nothing: it can do what you can, and no more.
              {state?.builtIn && " That is full access, which it has because what it does can\u2019t be done shut off from the app."} What it does with that is what it adds, below.
            </p>
            {plugin.record && id === HTML_EMBEDS && <HtmlNetwork subject={plugin.record} admin={admin} personId={personId} changes={changes} />}
          </>
        )}
      </Section>

      <Section title="What it adds">
        {adds ? (
          <Adds adds={adds} options={options.length} off={!state?.enabled} keys={(commandId) => chordFor(commandId, contributed.keybindings)} mac={mac} />
        ) : (
          <p className="soon">It hasn't been on since the app loaded, so what it adds isn't listed yet. Turn it on to see.</p>
        )}
      </Section>

      <Section title="Settings">
        {options.length === 0 ? (
          <p className="soon">It has no settings.</p>
        ) : (
          <>
            {options.some((d) => !d.active) && <p className="soon">{name} is off, so its options change nothing until it is turned on.</p>}
            {/* Said only when there is something to say: that nothing can be set yet, or that a change wasn't kept. */}
            {status.kind !== "saved" && status.kind !== "saving" && (
              <p role="status" className="soon">
                {statusLabel(status)}
              </p>
            )}
            {/* The same rows Settings draws for this plugin, writing the same settings, so the two are always in step. */}
            <fieldset className="plugin-options" disabled={unread} aria-label={`Settings of ${name}`}>
              {options.map((d) => (
                <SettingRow
                  key={d.key}
                  declared={d}
                  value={settings.values[d.key]!}
                  modified={Object.hasOwn(settings.document, d.key)}
                  problems={settings.problems.filter((p) => p.key === d.key)}
                  mac={mac}
                  onSet={(value) => host.setSetting(d.key, value)}
                />
              ))}
            </fieldset>
            <a className="button small" {...within(go, `/settings/plugins/${encodeURIComponent(id)}`)}>
              Open in Settings
            </a>
          </>
        )}
      </Section>

      <Section title="Source">
        <PluginSource plugin={plugin} workspaceId={workspaceId} admin={admin} drafts={drafts} onDrafts={onDrafts} onRecord={onRecord} />
      </Section>
    </section>
  );
}

interface AddsProps {
  adds: Added;
  /** How many options it declares. */
  options: number;
  /** Whether the plugin is off, so this is what it added when it was last on. */
  off: boolean;
  /** The chord that runs a command now, if one does. */
  keys: (commandId: string) => string | undefined;
  mac: boolean;
}

/** What a plugin has registered, kind by kind. It is read from the host's tables, or for a third-party plugin from its manifest, and never written by hand. */
function Adds({ adds, options, off, keys, mac }: AddsProps) {
  const kinds: { title: string; items: { key: string; text: string; code?: string; chord?: string }[] }[] = [
    { title: "Commands", items: adds.commands.map((c) => ({ key: c.id, text: c.title, code: c.id, chord: keys(c.id) })) },
    { title: "Views", items: adds.views.map((v) => ({ key: `${v.slot}.${v.id}`, text: v.label ? `${SLOT_WORDS[v.slot]}: ${v.label}` : SLOT_WORDS[v.slot] })) },
    { title: "Embeds", items: adds.embeds.map((e) => (e.address ? { key: e.name, text: `${e.title}, from its address alone on a line` } : { key: e.name, text: e.title, code: `${e.block ? ":::" : "::"}${e.name}{}` })) },
    { title: "Completions", items: adds.completions.map((c) => ({ key: c.id, text: "A list offered while typing after", code: c.trigger })) },
    { title: "Editor extensions", items: adds.editorExtensions.map((id) => ({ key: id, text: "Added to every note's editor", code: id })) },
  ].filter((kind) => kind.items.length > 0);
  const nothing = kinds.length === 0 && options === 0;

  return (
    <>
      {off && !nothing && <p className="soon">It is off, so none of this is in the app now. This is what it adds when it is on.</p>}
      {nothing && <p className="soon">It adds nothing that is listed: no command, view, embed or setting.</p>}
      <dl className="plugin-adds">
        {kinds.map((kind) => (
          <div key={kind.title} role="group" aria-label={kind.title}>
            <dt>
              {kind.title} <span className="settings-count">{kind.items.length}</span>
            </dt>
            {kind.items.map((item) => (
              <dd key={item.key}>
                <span>{item.text}</span>
                {item.code && <code>{item.code}</code>}
                {item.chord && <kbd>{chordLabel(item.chord, mac)}</kbd>}
              </dd>
            ))}
          </div>
        ))}
        {options > 0 && (
          <div role="group" aria-label="Settings">
            <dt>
              Settings <span className="settings-count">{options}</span>
            </dt>
            <dd>
              <span>Changed below, and in Settings</span>
            </dd>
          </div>
        )}
      </dl>
    </>
  );
}

/** The one permission a built-in has in the workspace's record: the sites HTML written in a note may reach, which an admin lists. */
function HtmlNetwork({ subject, admin, personId, changes }: { subject: InstalledPlugin; admin: boolean; personId: string; changes: RecordChanges }) {
  /** What the admin has typed in the field. Null until they type, when it shows the sites allowed. */
  const [sites, setSites] = useState<string | null>(null);
  const permission = subject.permissions[0];
  if (!permission) return null;
  const text = sites ?? permission.origins.join("\n");
  const origins = () => {
    const read = sitesIn(text);
    if ("reason" in read) changes.say(read.reason);
    return "origins" in read ? read.origins : null;
  };
  const asks = admin || (permission.state !== "allowed" && !permission.locked && !permission.requests.some((r) => r.by.id === personId));
  return (
    <>
      <p className="soon">It has one permission, which is the workspace's: HTML in a note reaches no site unless an admin lists the site here.</p>
      <ul className="permissions" aria-label="What HTML embeds may do">
        <PermissionRow
          subject={subject}
          permission={permission}
          admin={admin}
          personId={personId}
          changes={changes}
          listed={{
            origins,
            field: asks && (
              <label className="sites-field">
                <span>Sites, one to a line</span>
                <textarea aria-label="Sites HTML embeds may reach" rows={2} spellCheck={false} placeholder="https://api.example.com" value={text} onChange={(e) => setSites(e.target.value)} />
              </label>
            ),
          }}
        />
      </ul>
    </>
  );
}
