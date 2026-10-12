import { useId } from "react";
import { Drawn } from "./Drawn.tsx";
import { pickView } from "./inspectorPick.ts";
import type { App, Inspected, InspectorView } from "./plugin-api.ts";
import type { Host } from "./pluginHost.ts";

/**
 * What the inspector is about: the thing in front, with what a view for that kind of thing is
 * handed. It is nothing where no note, folder or page is in front, such as at an address nothing is at.
 */
export type Subject = { [K in keyof Inspected]: { kind: K; props: Inspected[K] } }[keyof Inspected] | { kind: "nothing"; props?: undefined };

/** The views plugins have added for what is in front, in order. */
export const viewsFor = (views: readonly InspectorView[], subject: Subject | null) => views.filter((v) => v.for === subject?.kind);

/** Draws a view with what it is for. `viewsFor` saw to it that the view is for what is in front. */
function drawn(host: Host, view: InspectorView, subject: Subject) {
  if (view.for === "note" && subject.kind === "note") return <Drawn key={view.id} host={host} view={view} {...subject.props} />;
  if (view.for === "folder" && subject.kind === "folder") return <Drawn key={view.id} host={host} view={view} {...subject.props} />;
  if (view.for === "page" && subject.kind === "page") return <Drawn key={view.id} host={host} view={view} {...subject.props} />;
  return null;
}

interface Props {
  host: Host;
  /** Every inspector view there is, whatever it is for. */
  views: readonly InspectorView[];
  app: App;
  /** Null while what is in front is still loading: the inspector keeps its place and shows nothing. */
  subject: Subject | null;
  /** The tab the member last picked, whatever was in front then. */
  picked: string | null;
  onPick: (viewId: string) => void;
}

export function Inspector({ host, views: all, app, subject, picked, onPick }: Props) {
  const ids = useId();
  const views = viewsFor(all, subject);
  const shown = pickView(all, views, picked);
  return (
    <aside className="inspector" aria-label="Inspector">
      {subject && shown ? (
        <>
          <div role="tablist" className="tabs">
            {views.map((v) => {
              const badge = v.badge?.(app) ?? null;
              return (
                <button
                  key={v.id}
                  type="button"
                  role="tab"
                  id={`${ids}-${v.id}`}
                  aria-selected={v === shown}
                  aria-controls={`${ids}-panel`}
                  aria-description={badge ?? undefined}
                  onClick={() => onPick(v.id)}
                >
                  {v.label}
                  {badge && <span className="unseen-dot" />}
                </button>
              );
            })}
          </div>
          <div role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-${shown.id}`} className="panel">
            {drawn(host, shown, subject)}
          </div>
        </>
      ) : (
        subject && <p className="inspector-empty">Nothing to show for this view</p>
      )}
    </aside>
  );
}
