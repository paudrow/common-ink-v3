import type { ReactNode } from "react";
import { Icon } from "./icons.tsx";
import { chordFor, chordLabel } from "./keybindings.ts";
import type { Slots } from "./plugin-api.ts";
import type { Added, Contributions, Host } from "./pluginHost.ts";
import { PLUGINS_PATH, within, type Listed } from "./pluginList.ts";

export interface PluginsProps {
  host: Host;
  mac: boolean;
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
  inspector: "An inspector tab",
  page: "A page",
  bar: "The bottom bar",
  overlay: "Something drawn over the app",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="plugin-section" aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/** One plugin: what it is, what it adds, its pictures and its options, and its switch. */
export function PluginDetails({ plugin, contributed, host, mac, go }: Props) {
  const { id, name, state } = plugin;
  const adds = state.adds;
  const options = contributed.settings.declared.filter((d) => d.group.id === id && !d.switch);

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
          {state.builtIn && (
            <p className="plugin-meta">
              <span className="badge">Built-in</span>
              <span>Comes with Common Ink</span>
            </p>
          )}
        </div>
        <label className="plugin-switch">
          <span>{state.enabled ? "On" : "Off"}</span>
          <input type="checkbox" className="switch" aria-label={name} checked={state.enabled} onChange={(e) => host.setEnabled(id, e.target.checked)} />
        </label>
      </header>
      {plugin.description && <p className="plugin-lead">{plugin.description}</p>}
      {state.error && (
        <p role="alert" className="error">
          Failed: {state.error}
        </p>
      )}

      {state.screenshots.length > 0 && (
        <Section title="Pictures">
          <div className="plugin-shots">
            {state.screenshots.map((shot) => (
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
        <p className="soon">{state.builtIn ? "It comes with Common Ink and runs" : "It runs"} inside the app as you, so it asks for nothing: it can do what you can, and no more. What it does with that is what it adds, below.</p>
      </Section>

      <Section title="What it adds">
        {adds ? (
          <Adds adds={adds} options={options.length} off={!state.enabled} keys={(commandId) => chordFor(commandId, contributed.keybindings)} mac={mac} />
        ) : (
          <p className="soon">It hasn't been on since the app loaded, so what it adds isn't listed yet. Turn it on to see.</p>
        )}
      </Section>

      <Section title="Settings">
        {options.length === 0 ? (
          <p className="soon">It has no settings.</p>
        ) : (
          <>
            <ul className="plugin-options" aria-label={`Settings of ${name}`}>
              {options.map((d) => (
                <li key={d.key}>
                  <span className="plugin-option">{d.setting.title}</span>
                  {d.setting.description && <span className="plugin-about">{d.setting.description}</span>}
                </li>
              ))}
            </ul>
            <a className="button small" {...within(go, `/settings/plugins/${encodeURIComponent(id)}`)}>
              Open in Settings
            </a>
          </>
        )}
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

/** What a plugin has registered, kind by kind. It is read from the host's tables, and never written by hand. */
function Adds({ adds, options, off, keys, mac }: AddsProps) {
  const kinds: { title: string; items: { key: string; text: string; code?: string; chord?: string }[] }[] = [
    { title: "Commands", items: adds.commands.map((c) => ({ key: c.id, text: c.title, code: c.id, chord: keys(c.id) })) },
    { title: "Views", items: adds.views.map((v) => ({ key: `${v.slot}.${v.id}`, text: v.label ? `${SLOT_WORDS[v.slot]}: ${v.label}` : SLOT_WORDS[v.slot] })) },
    { title: "Embeds", items: adds.embeds.map((e) => ({ key: e.name, text: e.title, code: `::${e.name}{}` })) },
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
              <span>Listed below, and changed in Settings</span>
            </dd>
          </div>
        )}
      </dl>
    </>
  );
}
