import { useState } from "react";
import type { PluginHost } from "../../plugin-api.ts";
import { Copyable } from "./Copyable.tsx";

type Copied = { is: "idle" } | { is: "copied"; text: string } | { is: "shown"; text: string } | { is: "failed"; message: string };

/** Copies what a note writes to reference an event or a contact, to be pasted into a note. */
export function CopyReference({ host, sourceId, id }: { host: PluginHost; sourceId: string; id: string }) {
  const [copied, setCopied] = useState<Copied>({ is: "idle" });
  const copy = async () => {
    try {
      const { text } = await host.perform({ type: "record.refer", sourceId, id });
      try {
        await navigator.clipboard.writeText(text);
        setCopied({ is: "copied", text });
      } catch {
        // A page served over plain http has no clipboard to write to, so the reference is shown to be copied by hand.
        setCopied({ is: "shown", text });
      }
    } catch (err) {
      setCopied({ is: "failed", message: (err as Error).message });
    }
  };
  return (
    <span className="copy-reference">
      <button type="button" className="button small" onClick={() => void copy()}>
        Copy reference
      </button>
      {copied.is === "copied" && (
        <span role="status" className="said">
          Copied <code>{copied.text}</code>. Paste it into a note.
        </span>
      )}
      {copied.is === "shown" && <Copyable label="Reference" value={copied.text} />}
      {copied.is === "failed" && (
        <span role="alert" className="said failed">
          {copied.message}
        </span>
      )}
    </span>
  );
}
