import { useState, useSyncExternalStore } from "react";
import { Icon } from "./icons.tsx";
import { PluginDetails, type PluginsProps } from "./PluginDetails.tsx";
import { InstallForm } from "./PluginInstall.tsx";
import { PLUGINS_PATH, kindLabel, listPlugins, matchesPlugin, waitingOn, within } from "./pluginList.ts";

/**
 * Where a member sees every plugin there is, each a card like a note in a folder's list, turns each
 * on and off, and opens one to read what it is, and where a workspace's admin installs plugins and
 * says what each may do. A card's name is its link, laid over the whole card, so a press anywhere on
 * it opens the plugin and the switch, which lies above the link, still switches. It is the only
 * place a plugin is turned on or off, beside the commands that do it. It belongs to the app, so it
 * is here whatever is turned off, and no plugin can do what it does. Every word that comes from a
 * plugin's manifest is drawn as text.
 */
export function Plugins(props: PluginsProps) {
  const { host, record, drafts, path, go } = props;
  const contributed = useSyncExternalStore(host.subscribe, host.contributions);
  /** What is typed in the search box. It is kept here so it is still there on the way back from a plugin's details. */
  const [typed, setTyped] = useState("");
  const plugins = listPlugins(contributed.plugins, record);
  const opened = decodeURIComponent(path.slice(PLUGINS_PATH.length + 1));

  if (opened) {
    const plugin = plugins.find((p) => p.id === opened);
    // An installed plugin is known only once the record has been read, so until then it isn't said to be missing.
    if (!plugin && !record) return <section className="mode-view plugins-page" aria-busy />;
    if (!plugin)
      return (
        <section className="mode-view plugins-page">
          <a className="plugin-back" {...within(go, PLUGINS_PATH)}>
            All plugins
          </a>
          <h1>Plugins</h1>
          <p className="soon">There's no plugin here. It may have been uninstalled.</p>
        </section>
      );
    return <PluginDetails key={plugin.id} {...props} plugin={plugin} contributed={contributed} />;
  }

  const admin = record?.canManage ?? false;
  const found = plugins.filter((p) => matchesPlugin(p, typed));
  return (
    <section className="mode-view plugins-page">
      <h1>Plugins</h1>
      <p className="soon">
        Most of Common Ink is plugins. Turn one off and what it adds goes away until you turn it back on. One an admin installed is off for you until you turn it on. The choice is yours alone, and is kept in your settings.
      </p>
      <input type="search" className="filter" aria-label="Search plugins" placeholder={`Search ${plugins.length} plugins`} value={typed} onChange={(e) => setTyped(e.target.value)} />
      {found.length === 0 && <p className="soon">No plugin matches.</p>}
      <ul className="plugin-list" aria-label="Plugins">
        {found.map((plugin) => {
          const { id, name, state } = plugin;
          const waiting = admin ? waitingOn(plugin) : 0;
          return (
            <li key={id} aria-label={name} className="plugin-row plugin-card" data-off={!state?.enabled || undefined}>
              <span className="plugin-icon">
                <Icon name={plugin.icon} />
              </span>
              <div className="plugin-text">
                <div className="plugin-line">
                  <a className="plugin-name" {...within(go, `${PLUGINS_PATH}/${encodeURIComponent(id)}`)}>
                    {name}
                  </a>
                  {(plugin.kind === "third-party" || state?.builtIn) && (
                    <span className="badge" data-kind={plugin.kind}>
                      {kindLabel(plugin)}
                    </span>
                  )}
                  {drafts.some((draft) => draft.pluginId === id && draft.running) && (
                    <span className="badge" data-state="draft">
                      Running your draft
                    </span>
                  )}
                  {waiting > 0 && (
                    <span className="badge" data-state="waiting">
                      {waiting} asking
                    </span>
                  )}
                </div>
                {plugin.description && <p className="plugin-about">{plugin.description}</p>}
                {state?.error && (
                  <span role="alert" className="error">
                    {plugin.kind === "built-in" ? `Failed: ${state.error}` : state.error}
                  </span>
                )}
              </div>
              <input type="checkbox" className="switch" aria-label={name} checked={state?.enabled ?? false} disabled={!state} onChange={(e) => host.setEnabled(id, e.target.checked)} />
            </li>
          );
        })}
      </ul>
      {admin && <InstallForm workspaceId={props.workspaceId} onRecord={props.onRecord} />}
    </section>
  );
}
