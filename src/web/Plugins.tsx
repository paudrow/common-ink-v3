import { useState, useSyncExternalStore } from "react";
import { Icon } from "./icons.tsx";
import { PluginDetails, type PluginsProps } from "./PluginDetails.tsx";
import { PLUGINS_PATH, listPlugins, matchesPlugin, within } from "./pluginList.ts";

/**
 * Where a member sees every plugin there is, turns each on and off, and opens one to read what it
 * is. It is the only place a plugin is turned on or off, beside the commands that do it. It belongs
 * to the app, so it is here whatever is turned off, and no plugin can do what it does.
 */
export function Plugins(props: PluginsProps) {
  const { host, path, go } = props;
  const contributed = useSyncExternalStore(host.subscribe, host.contributions);
  /** What is typed in the search box. It is kept here so it is still there on the way back from a plugin's details. */
  const [typed, setTyped] = useState("");
  const plugins = listPlugins(contributed.plugins);
  const opened = decodeURIComponent(path.slice(PLUGINS_PATH.length + 1));

  if (opened) {
    const plugin = plugins.find((p) => p.id === opened);
    if (!plugin)
      return (
        <section className="mode-view plugins-page">
          <a className="plugin-back" {...within(go, PLUGINS_PATH)}>
            All plugins
          </a>
          <h1>Plugins</h1>
          <p className="soon">There's no plugin here.</p>
        </section>
      );
    return <PluginDetails key={plugin.id} {...props} plugin={plugin} contributed={contributed} />;
  }

  const found = plugins.filter((p) => matchesPlugin(p, typed));
  return (
    <section className="mode-view plugins-page">
      <h1>Plugins</h1>
      <p className="soon">
        Most of Common Ink is plugins that come built in. Turn one off and what it adds goes away, in this browser, until you turn it back on.
      </p>
      <input type="search" className="filter" aria-label="Search plugins" placeholder={`Search ${plugins.length} plugins`} value={typed} onChange={(e) => setTyped(e.target.value)} />
      {found.length === 0 && <p className="soon">No plugin matches.</p>}
      <ul className="plugin-list" aria-label="Plugins">
        {found.map((plugin) => {
          const { id, name, state } = plugin;
          return (
            <li key={id} aria-label={name} className="plugin-row" data-off={!state.enabled || undefined}>
              <span className="plugin-icon">
                <Icon name={plugin.icon} />
              </span>
              <div className="plugin-text">
                <div className="plugin-line">
                  <a className="plugin-name" {...within(go, `${PLUGINS_PATH}/${encodeURIComponent(id)}`)}>
                    {name}
                  </a>
                  {state.builtIn && <span className="badge">Built-in</span>}
                </div>
                {plugin.description && <p className="plugin-about">{plugin.description}</p>}
                {state.error && (
                  <span role="alert" className="error">
                    Failed: {state.error}
                  </span>
                )}
              </div>
              <input type="checkbox" className="switch" aria-label={name} checked={state.enabled} onChange={(e) => host.setEnabled(id, e.target.checked)} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
