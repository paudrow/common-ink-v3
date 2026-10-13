import { useEffect, useRef, useState } from "react";
import { lineDiff } from "../core/diff.ts";
import type { Draft, DraftSummary, PluginRecord } from "../core/plugins.ts";
import { changesBetween } from "../core/text.ts";
import { perform } from "./api.ts";
import type { Listed } from "./pluginList.ts";
import { CODE_FILE, MANIFEST_FILE, editableOf, sourceOf, type Editable, type SourceFile } from "./pluginSource.ts";
import type { Shown, codeView } from "./pluginSourceView.ts";

export interface SourceProps {
  plugin: Listed;
  workspaceId: string;
  /** Whether the member is an admin, who alone publishes a draft to the workspace. */
  admin: boolean;
  /** The member's own drafts of plugins, as last read. */
  drafts: readonly DraftSummary[];
  /** Told the member's drafts are now these. */
  onDrafts: (drafts: readonly DraftSummary[]) => void;
  /** Told what the workspace's record is now, after a draft was published. */
  onRecord: (record: PluginRecord) => void;
}

type CodeView = typeof codeView;

/** A plugin's source as far as it has been fetched. `original` is it as the two files a copy starts from, or null for one compiled into the app. */
type Load = { at: "loading" } | { at: "failed"; message: string } | { at: "ready"; files: SourceFile[]; original: Editable | null; codeView: CodeView };

/** The two files of a draft, as they are in its editors. */
type Texts = Pick<Editable, "manifest" | "code">;
const DRAFT_FILES = [
  { path: MANIFEST_FILE, of: "manifest" },
  { path: CODE_FILE, of: "code" },
] as const;
/** What the list of a draft's files offers after them: what the draft changes, file by file. */
const CHANGES = "What I changed";

const withDraft = (drafts: readonly DraftSummary[], draft: DraftSummary) => [...drafts.filter((d) => d.pluginId !== draft.pluginId), draft];
const sameDrafts = (a: readonly DraftSummary[], b: readonly DraftSummary[]) => a.length === b.length && a.every((d) => b.some((o) => o.pluginId === d.pluginId && o.updatedAt === d.updatedAt && o.running === d.running));

export function PluginSource(props: SourceProps) {
  return <Source key={props.plugin.id} {...props} />;
}

/**
 * A plugin's source to read, and for an installed one the member's own draft of it to change, run
 * and publish. Nothing of it is fetched, the editor it is shown in included, until the section is
 * scrolled near.
 */
function Source({ plugin, workspaceId, admin, drafts, onDrafts, onRecord }: SourceProps) {
  const root = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const [load, setLoad] = useState<Load>({ at: "loading" });
  const [tries, setTries] = useState(0);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useRef({ plugin, drafts, onDrafts });
  now.current = { plugin, drafts, onDrafts };
  const summary = drafts.find((d) => d.pluginId === plugin.id);
  const { id, name } = plugin;
  /** What the workspace has of it now: its code by name, and its manifest, which an update can change alone. */
  const kept = plugin.record ? `${plugin.record.codeHash} ${JSON.stringify(plugin.record.manifest)}` : null;

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "200px" });
    observer.observe(root.current!);
    return () => observer.disconnect();
  }, []);

  // Read again when the workspace's code for it changes, so what is shown is what runs.
  useEffect(() => {
    if (!seen) return;
    let stale = false;
    setLoad((was) => (was.at === "failed" ? { at: "loading" } : was));
    (async () => {
      const [view, original] = await Promise.all([import("./pluginSourceView.ts"), editableOf(now.current.plugin, workspaceId)]);
      const files = await sourceOf(now.current.plugin, original);
      if (original) {
        // Another window of theirs may have made, changed or discarded a draft since the app read them.
        const mine = (await perform(workspaceId, { type: "draft.list" })).drafts;
        if (!stale && !sameDrafts(mine, now.current.drafts)) now.current.onDrafts(mine);
      }
      if (!stale) setLoad({ at: "ready", files, original, codeView: view.codeView });
    })().catch((err) => stale || setLoad({ at: "failed", message: (err as Error).message }));
    return () => void (stale = true);
  }, [seen, id, kept, workspaceId, tries]);

  const copy = async (original: Editable) => {
    setError(null);
    setCopying(true);
    try {
      onDrafts(withDraft(drafts, await perform(workspaceId, { type: "draft.save", id, manifest: original.manifest, code: original.code, baseHash: original.codeHash, running: false })));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCopying(false);
    }
  };

  return (
    <div className="plugin-source" ref={root}>
      {load.at === "loading" && <p className="soon">Loading</p>}
      {load.at === "failed" && (
        <p role="alert" className="error">
          Its source couldn't be loaded: {load.message}{" "}
          <button type="button" className="link" onClick={() => setTries(tries + 1)}>
            Try again
          </button>
        </p>
      )}
      {load.at === "ready" &&
        (load.files.length === 0 ? (
          <p className="soon">{name} has no source here to show.</p>
        ) : load.original && summary ? (
          <DraftEditor plugin={plugin} workspaceId={workspaceId} admin={admin} original={load.original} summary={summary} drafts={drafts} onDrafts={onDrafts} onRecord={onRecord} codeView={load.codeView} />
        ) : (
          <>
            <p className="soon">{load.original ? `The manifest and the code of ${name}, as ${plugin.own ? "they were built into this version of Common Ink" : "this workspace has them"}.` : `The code of ${name}, as it was built into this version of Common Ink.`}</p>
            <Files files={load.files} codeView={load.codeView} />
            {load.original && (
              <>
                <p className="soon">To change what it does, edit a copy of it. The copy is yours alone, and {name} stays as it is for everyone else.</p>
                <button type="button" className="button small" disabled={copying} onClick={() => void copy(load.original!)}>
                  Edit a copy
                </button>
              </>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
          </>
        ))}
    </div>
  );
}

interface CodeProps {
  codeView: CodeView;
  path: string;
  text: string;
  label: string;
  hidden?: boolean;
  onChange?: (text: string) => void;
  onSave?: () => void;
}

function Code({ codeView, path, text, label, hidden, onChange, onSave }: CodeProps) {
  const parent = useRef<HTMLDivElement>(null);
  const shown = useRef<Shown | null>(null);
  const now = useRef({ text, onChange, onSave });
  now.current = { text, onChange, onSave };
  const editable = !!onChange;

  useEffect(() => {
    const made = (shown.current = codeView(parent.current!, { path, label, text: now.current.text, ...(editable && { onChange: (next) => now.current.onChange?.(next), onSave: () => now.current.onSave?.() }) }));
    return () => {
      shown.current = null;
      made.destroy();
    };
  }, [codeView, path, label, editable]);

  useEffect(() => shown.current?.set(text), [text]);

  return <div className="source-code" data-editable={editable || undefined} hidden={hidden} ref={parent} />;
}

interface PickerProps {
  label: string;
  options: readonly string[];
  open: string;
  onOpen: (option: string) => void;
}

/** One list of what can be shown, however long it is. */
function Picker({ label, options, open, onOpen }: PickerProps) {
  return (
    <label className="source-file">
      <span>File</span>
      <select aria-label={label} value={open} onChange={(e) => onOpen(e.target.value)}>
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
      <span className="source-count">
        {options.indexOf(open) + 1} of {options.length}
      </span>
    </label>
  );
}

/** One file at a time, picked from one list however many files there are. */
function Files({ files, codeView }: { files: SourceFile[]; codeView: CodeView }) {
  const [open, setOpen] = useState(files[0]!.path);
  const file = files.find((f) => f.path === open) ?? files[0]!;
  return (
    <>
      <Picker label="Source file" options={files.map((f) => f.path)} open={file.path} onOpen={setOpen} />
      <Code key={file.path} codeView={codeView} path={file.path} text={file.text} label={`Source of ${file.path}`} />
    </>
  );
}

function Changes({ path, before, after }: { path: string; before: string; after: string }) {
  const diff = lineDiff(before, changesBetween(before, after));
  return (
    <div className="source-changes" role="group" aria-label={`Changes to ${path}`}>
      <h3>{path}</h3>
      {diff.hunks.length === 0 ? (
        <p className="diff-none">No changes</p>
      ) : (
        <div className="diff">
          {diff.hunks.map((hunk) => (
            <div key={hunk.oldStart} className="hunk">
              <div className="hunk-head">
                @@ −{hunk.oldStart} +{hunk.newStart} @@
              </div>
              {hunk.lines.map((line, i) => {
                const Line = line.kind === "add" ? "ins" : line.kind === "del" ? "del" : "span";
                return (
                  <Line key={i} className="diff-line">
                    {line.text || " "}
                  </Line>
                );
              })}
            </div>
          ))}
          {diff.omitted > 0 && <p className="diff-none">{diff.omitted} more changed or nearby lines</p>}
        </div>
      )}
    </div>
  );
}

interface DraftProps extends SourceProps {
  original: Editable;
  /** The member's draft of this plugin, as the list of their drafts has it. */
  summary: DraftSummary;
  codeView: CodeView;
}

function DraftEditor({ plugin, workspaceId, admin, original, summary, drafts, onDrafts, onRecord, codeView }: DraftProps) {
  /** The draft as it was last saved. Null until it has been read. */
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState<Texts | null>(null);
  /** The same text, as of the last key pressed: a save asked for from the keyboard comes before the next render. */
  const typed = useRef<Texts | null>(null);
  /** What the switch was just set to, shown until the server has answered. */
  const [turning, setTurning] = useState<boolean | null>(null);
  const [open, setOpen] = useState<string>(MANIFEST_FILE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [asking, setAsking] = useState<"discard" | "publish" | null>(null);
  const { id, name } = plugin;
  const savedAt = draft?.updatedAt;
  /** What leaving the page keeps: the draft as saved, and whether it is still there to keep. */
  const leaving = useRef<{ saved: Draft | null; gone: boolean }>({ saved: null, gone: false });
  leaving.current.saved = draft;

  useEffect(() => {
    if (savedAt === summary.updatedAt) return;
    let stale = false;
    perform(workspaceId, { type: "draft.read", id }).then(
      (read) => {
        if (stale) return;
        setDraft(read);
        setText((typed.current = { manifest: read.manifest, code: read.code }));
      },
      (err) => stale || setError((err as Error).message),
    );
    return () => void (stale = true);
  }, [workspaceId, id, summary.updatedAt, savedAt]);

  // What was typed and not saved is kept when the page is left, as text. A draft that is running keeps running only if the server takes it as it is.
  useEffect(
    () => () => {
      const { saved, gone } = leaving.current;
      const kept = typed.current;
      if (!saved || !kept || gone || (kept.manifest === saved.manifest && kept.code === saved.code)) return;
      const keep = (running: boolean) => perform(workspaceId, { type: "draft.save", id, ...kept, baseHash: saved.baseHash, running });
      void keep(saved.running)
        .catch(() => keep(false))
        .catch(() => {});
    },
    [workspaceId, id],
  );

  if (!draft || !text)
    return error ? (
      <p role="alert" className="error">
        {error}
      </p>
    ) : (
      <p className="soon">Loading</p>
    );

  const changed = text.manifest !== draft.manifest || text.code !== draft.code;

  const save = async (running = draft.running, baseHash = draft.baseHash) => {
    try {
      const kept = typed.current!;
      const made = await perform(workspaceId, { type: "draft.save", id, ...kept, baseHash, running });
      setDraft({ ...made, code: kept.code });
      onDrafts(withDraft(drafts, made));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const during = async (work: () => Promise<void>) => {
    setError(null);
    setSaid(null);
    setAsking(null);
    setBusy(true);
    await work().finally(() => setBusy(false));
  };

  const discard = async () => {
    try {
      const left = (await perform(workspaceId, { type: "draft.discard", id })).drafts;
      leaving.current.gone = true;
      onDrafts(left);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const publish = async () => {
    try {
      const made = await perform(workspaceId, { type: "plugin.install", ...typed.current!, replaces: id });
      onRecord(made);
      setSaid(`Published. This is ${name} for everyone in the workspace now, and everything it was permitted has to be approved again.`);
      // The draft is now a copy of what was published, so it isn't said to be behind it.
      await save(draft.running, made.plugins.find((p) => p.id === made.id)?.codeHash ?? draft.baseHash);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <p className="soon">
        This is your copy of {name}, and yours alone: nobody else can see it, admins included. When you run it, it runs only for you, in {name}&rsquo;s place, shut off from the app, with what {name} is already permitted and never more.
      </p>
      {draft.baseHash !== original.codeHash && (
        <p className="source-behind">
          {name} has changed since you made this copy. &ldquo;{CHANGES}&rdquo; compares your draft with {name} as it is now.
        </p>
      )}
      <Picker label="Draft file" options={[...DRAFT_FILES.map((f) => f.path), CHANGES]} open={open} onOpen={setOpen} />
      {DRAFT_FILES.map(({ path, of }) => (
        <Code key={path} codeView={codeView} path={path} text={text[of]} label={`Draft of ${path}`} hidden={path !== open} onChange={(next) => setText((typed.current = { ...typed.current!, [of]: next }))} onSave={() => void during(() => save())} />
      ))}
      {open === CHANGES && (
        <>
          <Changes path={MANIFEST_FILE} before={original.manifest} after={text.manifest} />
          <Changes path={CODE_FILE} before={original.code} after={text.code} />
        </>
      )}
      <div className="agent-actions">
        <button type="button" className="button small primary" disabled={busy || !changed} onClick={() => void during(() => save())}>
          Save draft
        </button>
        <label className="plugin-switch">
          <input type="checkbox" className="switch" checked={turning ?? draft.running} disabled={busy} onChange={(e) => (setTurning(e.target.checked), void during(() => save(e.target.checked)).finally(() => setTurning(null)))} />
          <span>Run my draft</span>
        </label>
        <button type="button" className="button small danger" disabled={busy} onClick={() => setAsking("discard")}>
          Discard draft
        </button>
        {admin && !plugin.own && (
          <button type="button" className="button small" disabled={busy} onClick={() => setAsking("publish")}>
            Publish to the workspace
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {said && (
        <p role="status" className="said">
          {said}
        </p>
      )}
      {asking === "discard" && (
        <span className="confirm" role="group" aria-label={`Discard your draft of ${name}?`}>
          <span>Your copy and every change in it is gone for good. {name} itself stays as it is.</span>
          <button type="button" className="button small primary" autoFocus onClick={() => void during(discard)}>
            Discard it
          </button>
          <button type="button" className="link" onClick={() => setAsking(null)}>
            Cancel
          </button>
        </span>
      )}
      {asking === "publish" && (
        <span className="confirm" role="group" aria-label={`Publish your draft of ${name}?`}>
          <span>Your draft takes the place of {name} for everyone in this workspace. Everything it was permitted has to be approved again for the new code.</span>
          <button type="button" className="button small primary" autoFocus onClick={() => void during(publish)}>
            Publish it
          </button>
          <button type="button" className="link" onClick={() => setAsking(null)}>
            Cancel
          </button>
        </span>
      )}
      {plugin.own ? (
        <p className="soon">{name} comes with Common Ink, so a copy of it is never published over it: yours runs for you, and an admin can install its two files as a plugin of the workspace&rsquo;s own, under another name.</p>
      ) : (
        !admin && <p className="soon">Only an admin installs a plugin for the workspace. To share this, show an admin your draft or send them its two files.</p>
      )}
    </>
  );
}
