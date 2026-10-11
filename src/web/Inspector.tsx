import { useId, useRef, useState } from "react";
import type { NoteSummary } from "../core/protocol.ts";
import { notePath } from "../core/slug.ts";
import { pathName, type FolderTree } from "./folders.ts";
import type { IconName } from "./icons.tsx";
import { Soon } from "./Soon.tsx";

export const INSPECTOR_TABS = [
  { id: "history", label: "History", icon: "history" },
  { id: "backlinks", label: "Backlinks", icon: "backlinks" },
  { id: "info", label: "Info", icon: "info" },
] as const satisfies readonly { id: string; label: string; icon: IconName }[];

export type InspectorTab = (typeof INSPECTOR_TABS)[number]["id"];

export interface PanelProps {
  note: NoteSummary;
  tree: FolderTree;
  canEdit: boolean;
  onMove: (noteId: string, folderId: string) => Promise<void>;
}

export function Inspector(props: PanelProps) {
  const ids = useId();
  const [tab, setTab] = useState<InspectorTab>("info");
  return (
    <aside className="inspector" aria-label="Inspector">
      <div role="tablist" className="tabs">
        {INSPECTOR_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${ids}-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${ids}-panel`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-${tab}`} className="panel">
        <InspectorPanel tab={tab} {...props} />
      </div>
    </aside>
  );
}

export function InspectorPanel({ tab, ...props }: PanelProps & { tab: InspectorTab }) {
  switch (tab) {
    case "history":
      return <Soon issue={5}>Who changed this note and how arrives with</Soon>;
    case "backlinks":
      return <Soon issue={13}>Notes that link here arrive with</Soon>;
    case "info":
      return <Info {...props} />;
  }
}

function Info({ note, tree, canEdit, onMove }: PanelProps) {
  const url = `${location.origin}${notePath(note)}`;
  const urlField = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targets = [...tree.byId.keys()].map((id) => ({ id, name: pathName(tree, id) })).sort((a, b) => a.name.localeCompare(b.name));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // A preview served over plain http has no Clipboard API.
      urlField.current?.select();
      document.execCommand("copy");
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <dl className="info">
      <dt>Folder</dt>
      <dd>
        <span>{pathName(tree, note.folderId)}</span>
        <select
          aria-label="Move to"
          value={note.folderId}
          disabled={!canEdit}
          onChange={(e) => {
            setError(null);
            onMove(note.id, e.target.value).catch((err: Error) => setError(err.message));
          }}
        >
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        {error && <span role="alert" className="error">{error}</span>}
      </dd>
      <dt>Sharing</dt>
      <dd>
        <span>Everyone in this workspace</span>
        <Soon issue={15}>Sharing with people and links arrives with</Soon>
      </dd>
      <dt>Tags</dt>
      <dd>
        <Soon issue={21}>Tags arrive with</Soon>
      </dd>
      <dt>URL</dt>
      <dd className="url">
        <input ref={urlField} readOnly aria-label="Note URL" value={url} onFocus={(e) => e.target.select()} />
        <button type="button" className="button small" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </dd>
      <dt>Archive</dt>
      <dd>
        <button type="button" className="button small" disabled>
          Archive
        </button>
        <Soon issue={21}>Archiving arrives with</Soon>
      </dd>
    </dl>
  );
}
