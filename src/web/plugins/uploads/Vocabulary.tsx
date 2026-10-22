import { useEffect, useId, useState } from "react";
import { MAX_VOCABULARY, type PluginHost } from "../../plugin-api.ts";
import { reasonOf } from "../lib/FoundNote.tsx";

/** Where the vocabulary is read from, saved to, or why it couldn't be. */
type Kept = { kind: "reading" } | { kind: "read"; words: string } | { kind: "saving"; words: string } | { kind: "problem"; words: string | null; reason: string };

/**
 * Settings' Voice section: the workspace's vocabulary, the names and jargon its recordings are
 * transcribed with, one per line or between commas. An admin or an editor changes it for everyone,
 * and it is saved when Save is pressed; anyone else reads it.
 */
export function VocabularySettings({ host }: { host: PluginHost }) {
  const id = useId();
  const [kept, setKept] = useState<Kept>({ kind: "reading" });
  const [draft, setDraft] = useState<string | null>(null);
  const writes = host.workspace.role === "admin" || host.workspace.role === "editor";

  useEffect(() => {
    let live = true;
    host.perform({ type: "vocabulary.read" }).then(
      ({ words }) => live && setKept({ kind: "read", words }),
      (err: unknown) => live && setKept({ kind: "problem", words: null, reason: reasonOf(err) }),
    );
    return () => void (live = false);
  }, [host]);

  const saved = kept.kind === "reading" ? null : kept.words;
  const shown = draft ?? saved ?? "";
  const save = async () => {
    if (draft === null) return;
    setKept({ kind: "saving", words: saved ?? "" });
    try {
      const { words } = await host.perform({ type: "vocabulary.write", words: draft });
      setKept({ kind: "read", words });
      setDraft(null);
    } catch (err) {
      setKept({ kind: "problem", words: saved, reason: reasonOf(err) });
    }
  };

  return (
    <div className="setting vocabulary-setting" data-row>
      <div className="setting-head">
        <label htmlFor={id}>Vocabulary</label>
      </div>
      <p className="setting-about">
        Names and words a recording is transcribed with, spelled the way this workspace spells them, such as Common Ink or jj. One per line, or separated by commas. It is the whole workspace's{writes ? "" : ", and an admin or an editor changes it"}.
      </p>
      <div className="setting-control vocabulary-control">
        <textarea
          id={id}
          rows={5}
          maxLength={MAX_VOCABULARY}
          readOnly={!writes || kept.kind === "reading" || kept.kind === "saving"}
          placeholder={kept.kind === "reading" ? "Reading…" : "Common Ink\njj"}
          spellCheck={false}
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
          }}
        />
        {writes && (
          <button type="button" className="button small primary" disabled={draft === null || draft === saved || kept.kind === "saving"} onClick={() => void save()}>
            {kept.kind === "saving" ? "Saving…" : "Save"}
          </button>
        )}
      </div>
      {kept.kind === "problem" && (
        <p className="error" role="alert">
          {kept.reason}
        </p>
      )}
    </div>
  );
}
