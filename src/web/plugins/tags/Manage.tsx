import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { MAX_TAG_DESCRIPTION, nameKey, type App, type ListedTag, type PluginHost } from "../../plugin-api.ts";
import { ManageRow, ManageTable } from "../lib/ManageTable.tsx";
import { tagPath } from "./path.ts";
import { describes, going, type TagRequest, type TagStore } from "./Tags.tsx";

/**
 * Settings' Tags: a table of every tag, in name order, with what it is for and how many notes have
 * it, said for the agents that choose tags and the people resting on one. An admin or an editor says
 * it here, in the description's own cell. A viewer and a guest read it and are given nothing to change.
 */
export function ManageTags({ host, app, store }: { host: PluginHost; app: App; store: TagStore }) {
  const tags = useSyncExternalStore(store.subscribe, store.tags);
  const more = useSyncExternalStore(store.subscribe, store.more);
  const indexing = useSyncExternalStore(store.subscribe, store.indexing);
  const editing = describes(app);
  /** What a tag's menu asked for when it brought the member here. */
  const [asked] = useState(() => store.take());
  return (
    <>
      <p className="soon">
        {editing ? "Say when to use each tag. Agents choose tags by it, and it shows when you rest on a tag." : "What each tag is for. Agents choose tags by it. Admins and editors write it."}
      </p>
      {indexing && (
        <p className="soon" role="status">
          Still indexing notes. Some tags may be missing.
        </p>
      )}
      {tags && !tags.length && <p className="soon">No tags yet. Write #tag anywhere in a note to tag it.</p>}
      {tags && tags.length > 0 && (
        <ManageTable
          label="Tags"
          column="Tag"
          noun="tag"
          rows={tags}
          keyOf={(tag) => nameKey(tag.name)}
          text={(tag) => `#${tag.name}\n${tag.description ?? ""}`}
          actions={editing}
          partial={more !== null}
          row={(tag) => <TagRow host={host} app={app} store={store} tag={tag} editing={editing} opening={editing && asked && nameKey(asked.name) === nameKey(tag.name) ? asked.kind : null} />}
        />
      )}
      {more && (
        <button type="button" className="button small" onClick={more}>
          Show more
        </button>
      )}
    </>
  );
}

function TagRow({ host, app, store, tag, editing, opening }: { host: PluginHost; app: App; store: TagStore; tag: ListedTag; editing: boolean; opening: TagRequest["kind"] | null }) {
  const ids = useId();
  const [draft, setDraft] = useState<string | null>(opening === "describe" ? (tag.description ?? "") : null);
  const field = useRef<HTMLTextAreaElement>(null);
  // Asked for from a tag's menu, the row takes the keyboard once Settings, which takes it as they open, have.
  useEffect(() => {
    if (!opening) return;
    const later = setTimeout(() => field.current?.focus());
    return () => clearTimeout(later);
  }, []);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** What was just saved, shown until the tags are read again with it. */
  const [said, setSaid] = useState<string | undefined>(undefined);
  useEffect(() => setSaid(undefined), [tag.description]);
  const description = said ?? tag.description ?? "";

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (busy || draft === null) return;
    setBusy(true);
    setProblem(null);
    host.perform({ type: "tag.describe", name: tag.name, description: draft }).then(
      (answer) => {
        setBusy(false);
        setDraft(null);
        setSaid(answer.description ?? "");
        store.reload();
      },
      (err: unknown) => {
        setBusy(false);
        setProblem(err instanceof Error ? err.message : "The description wasn't saved. Try again.");
      },
    );
  };

  return (
    <ManageRow
      name={
        <a className="manage-name" {...going(app, tagPath(tag.name))}>
          #{tag.name}
        </a>
      }
      description={
        draft !== null ? (
          <form
            className="tag-description-form"
            onSubmit={save}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.preventDefault();
              e.stopPropagation();
              setDraft(null);
            }}
          >
            <label htmlFor={`${ids}-description`}>When to use #{tag.name}</label>
            <textarea ref={field} id={`${ids}-description`} rows={3} maxLength={MAX_TAG_DESCRIPTION} autoFocus value={draft} aria-describedby={problem ? `${ids}-problem` : undefined} onChange={(e) => setDraft(e.target.value)} />
            {problem && (
              <p id={`${ids}-problem`} role="alert" className="error">
                {problem}
              </p>
            )}
            <div className="tag-description-foot">
              <button type="button" className="button small" onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button type="submit" className="button small primary" aria-disabled={busy || undefined}>
                Save
              </button>
            </div>
          </form>
        ) : description ? (
          <p className="manage-description">{description}</p>
        ) : (
          <p className="manage-none">{editing ? "No description. Add one to help AI use this tag right." : "No description."}</p>
        )
      }
      count={<span aria-label={`${tag.notes} ${tag.notes === 1 ? "note" : "notes"}`}>{tag.notes}</span>}
      actions={
        editing ? (
          draft === null && (
            <button
              type="button"
              className="button small"
              aria-label={`${description ? "Edit" : "Add"} the description of #${tag.name}`}
              onClick={() => {
                setProblem(null);
                setDraft(description);
              }}
            >
              {description ? "Edit" : "Describe"}
            </button>
          )
        ) : undefined
      }
    />
  );
}
