import { useEffect, useRef, useState } from "react";
import type { Listed } from "./pluginList.ts";
import { sourceOf, type SourceFile } from "./pluginSource.ts";
import type { Shown, codeView } from "./pluginSourceView.ts";

export interface SourceProps {
  plugin: Listed;
  workspaceId: string;
}

type CodeView = typeof codeView;

/** A plugin's source as far as it has been fetched. */
type Load = { at: "loading" } | { at: "failed"; message: string } | { at: "ready"; files: SourceFile[]; codeView: CodeView };

export function PluginSource(props: SourceProps) {
  return <Source key={props.plugin.id} {...props} />;
}

/** A plugin's source to read. Nothing of it is fetched, the editor it is shown in included, until the section is scrolled near. */
function Source({ plugin, workspaceId }: SourceProps) {
  const root = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const [load, setLoad] = useState<Load>({ at: "loading" });
  const [tries, setTries] = useState(0);
  const now = useRef(plugin);
  now.current = plugin;
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
    Promise.all([import("./pluginSourceView.ts"), sourceOf(now.current, workspaceId)]).then(
      ([view, files]) => stale || setLoad({ at: "ready", files, codeView: view.codeView }),
      (err) => stale || setLoad({ at: "failed", message: (err as Error).message }),
    );
    return () => void (stale = true);
  }, [seen, id, kept, workspaceId, tries]);

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
        ) : (
          <>
            <p className="soon">{plugin.kind === "third-party" ? `The manifest and the code of ${name}, as this workspace has them.` : `The code of ${name}, as it was built into this version of Common Ink.`}</p>
            <Files files={load.files} codeView={load.codeView} />
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
}

function Code({ codeView, path, text, label }: CodeProps) {
  const parent = useRef<HTMLDivElement>(null);
  const shown = useRef<Shown | null>(null);
  const first = useRef(text);

  useEffect(() => {
    const made = (shown.current = codeView(parent.current!, { path, label, text: first.current }));
    return () => {
      shown.current = null;
      made.destroy();
    };
  }, [codeView, path, label]);

  useEffect(() => shown.current?.set(text), [text]);

  return <div className="source-code" ref={parent} />;
}

/** One file at a time, picked from one list however many files there are. */
function Files({ files, codeView }: { files: SourceFile[]; codeView: CodeView }) {
  const [open, setOpen] = useState(files[0]!.path);
  const file = files.find((f) => f.path === open) ?? files[0]!;
  return (
    <>
      <label className="source-file">
        <span>File</span>
        <select aria-label="Source file" value={file.path} onChange={(e) => setOpen(e.target.value)}>
          {files.map((f) => (
            <option key={f.path}>{f.path}</option>
          ))}
        </select>
        <span className="source-count">
          {files.indexOf(file) + 1} of {files.length}
        </span>
      </label>
      <Code key={file.path} codeView={codeView} path={file.path} text={file.text} label={`Source of ${file.path}`} />
    </>
  );
}
