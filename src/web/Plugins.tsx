import type { PluginState } from "./pluginHost.ts";

interface Props {
  plugins: readonly PluginState[];
  onToggle: (id: string, enabled: boolean) => void;
}

/** Where a member turns plugins on and off. It belongs to the app, so it is here whatever is turned off. */
export function Plugins({ plugins, onToggle }: Props) {
  return (
    <section className="mode-view">
      <h1>Plugins</h1>
      <p className="soon">Most of Common Ink is plugins that come built in. Turn one off and what it adds goes away until you turn it back on. The choice is kept in your settings.</p>
      <ul className="plugins" aria-label="Plugins">
        {plugins
          .filter((p) => !p.required)
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
    </section>
  );
}
