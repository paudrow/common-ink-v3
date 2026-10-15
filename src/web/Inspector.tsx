import type { Ref } from "react";
import { Drawn } from "./Drawn.tsx";
import { Icon } from "./icons.tsx";
import type { About, App, InspectorView } from "./plugin-api.ts";
import type { Host } from "./pluginHost.ts";

/** What is in front, for the inspector to be about. It is nothing where no note, folder or page that says what it shows is in front. */
export type Subject = About | { kind: "nothing" };

interface BarProps {
  ref: Ref<HTMLElement>;
  /** Every panel there is. The bar is the same whatever is in front. */
  views: readonly InspectorView[];
  app: App;
  /** The id of the panel that shows, or null. */
  shown: string | null;
  /** The id panels are named by for a screen reader, which the one that shows carries. */
  panelId: string;
  onPick: (viewId: string) => void;
}

/** The inspector's bar: an icon for each panel, always there. An icon shows its panel, or closes it if it is the one showing. */
export function InspectorBar({ ref, views, app, shown, panelId, onPick }: BarProps) {
  return (
    <nav ref={ref} className="rail" aria-label="Inspector bar">
      {views.map((v) => {
        const badge = v.badge?.(app) ?? null;
        return (
          // An empty description keeps the tooltip, which says the name again, from being read out as one.
          <button key={v.id} type="button" className="icon-button" aria-label={v.label} title={v.label} aria-description={badge ?? ""} aria-expanded={v.id === shown} aria-controls={v.id === shown ? panelId : undefined} onClick={() => onPick(v.id)}>
            <Icon name={v.icon} />
            {badge && <span className="unseen-dot" />}
          </button>
        );
      })}
    </nav>
  );
}

interface PanelProps {
  ref: Ref<HTMLElement>;
  id: string;
  host: Host;
  view: InspectorView;
  /** Null while what is in front is still loading: the panel keeps its place and shows nothing. */
  subject: Subject | null;
  /** Pinned, it is beside the page. Otherwise it lies over the page until the member goes elsewhere. */
  pinned: boolean;
  onPin: () => void;
}

/** One panel of the inspector, about what is in front. Its one control is the pin. */
export function InspectorPanel({ ref, id, host, view, subject, pinned, onPin }: PanelProps) {
  return (
    <aside ref={ref} id={id} className="inspector" aria-label="Inspector" data-layout={pinned ? "pinned" : "temporary"} tabIndex={-1}>
      <header className="panel-head">
        <h2>{view.label}</h2>
        <button type="button" className="icon-button" aria-label="Pin beside the page" title={pinned ? "Unpin: show it over the page" : "Pin beside the page"} aria-pressed={pinned} onClick={onPin}>
          <Icon name="pin" />
        </button>
      </header>
      <div className="panel inspector-body">
        {subject && (subject.kind !== "nothing" && view.for.includes(subject.kind) ? <Drawn key={view.id} host={host} view={view} about={subject} /> : <p className="inspector-empty">Nothing to show for this view</p>)}
      </div>
    </aside>
  );
}
