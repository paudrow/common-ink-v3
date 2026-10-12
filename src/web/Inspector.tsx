import { useId } from "react";
import { Drawn } from "./Drawn.tsx";
import { UNPICKED, type App, type Inspected, type InspectorView } from "./plugin-api.ts";
import type { Host } from "./pluginHost.ts";

/**
 * What the inspector is about: the thing in front, with what a view for that kind of thing is
 * handed. It is nothing where no note, folder or page is in front, such as at an address nothing is at.
 */
export type Subject = { [K in keyof Inspected]: { kind: K; props: Inspected[K] } }[keyof Inspected] | { kind: "nothing"; props?: undefined };

/** The views plugins have added for what is in front, in order. */
export const viewsFor = (views: readonly InspectorView[], subject: Subject | null) => views.filter((v) => v.for === subject?.kind);

/**
 * The tab that shows: the one the member last picked, or the one of the same name where what is in
 * front has its own, as a folder has its own Info. Where it has neither, the first of the tabs it
 * does have shows, and the pick is as it was for the next thing that has it.
 */
export const shownView = (all: readonly InspectorView[], views: readonly InspectorView[], picked: string | null) => {
  const id = picked ?? UNPICKED;
  const label = all.find((v) => v.id === id)?.label;
  return views.find((v) => v.id === id) ?? views.find((v) => v.label === label) ?? views[0];
};

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
  const shown = shownView(all, views, picked);
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
            {/* A view is handed what it is for, which `viewsFor` saw to and the types can't follow. */}
            <Drawn key={shown.id} host={host} view={shown as never} {...subject.props} />
          </div>
        </>
      ) : (
        subject && <p className="inspector-empty">Nothing to show for this view</p>
      )}
    </aside>
  );
}
