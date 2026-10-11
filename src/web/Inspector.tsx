import { useId, useState } from "react";
import { Drawn } from "./Drawn.tsx";
import type { App, NoteSummary, Slots } from "./plugin-api.ts";
import type { Host } from "./pluginHost.ts";

interface Props {
  host: Host;
  tabs: readonly Slots["inspector"][];
  /** The tab shown until the member picks one. */
  opensOn: Slots["inspector"] | undefined;
  app: App;
  note: NoteSummary;
}

/** The tabs plugins have added about the open note. */
export function Inspector({ host, tabs, opensOn, app, note }: Props) {
  const ids = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const tab = tabs.find((t) => t.id === chosen) ?? opensOn;
  if (tabs.length === 0) return null;
  return (
    <aside className="inspector" aria-label="Inspector">
      <div role="tablist" className="tabs">
        {tabs.map((t) => {
          const badge = t.badge?.(app) ?? null;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`${ids}-${t.id}`}
              aria-selected={tab === t}
              aria-controls={`${ids}-panel`}
              aria-description={badge ?? undefined}
              onClick={() => setChosen(t.id)}
            >
              {t.label}
              {badge && <span className="unseen-dot" />}
            </button>
          );
        })}
      </div>
      {/* With no tab of the app's own to open on, it waits to be told which. */}
      {tab && (
        <div role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-${tab.id}`} className="panel">
          <Drawn key={tab.id} host={host} view={tab} note={note} />
        </div>
      )}
    </aside>
  );
}
