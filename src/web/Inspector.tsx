import { useId, useState } from "react";
import { Drawn } from "./Drawn.tsx";
import type { App, NoteSummary, Slots } from "./plugin-api.ts";
import type { Host } from "./pluginHost.ts";

interface Props {
  host: Host;
  tabs: readonly Slots["inspector"][];
  app: App;
  note: NoteSummary;
}

/** The tabs plugins have added about the open note. It opens on the last one. */
export function Inspector({ host, tabs, app, note }: Props) {
  const ids = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const tab = tabs.find((t) => t.id === chosen) ?? tabs.at(-1);
  if (!tab) return null;
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
      <div role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-${tab.id}`} className="panel">
        <Drawn key={tab.id} host={host} view={tab} note={note} />
      </div>
    </aside>
  );
}
