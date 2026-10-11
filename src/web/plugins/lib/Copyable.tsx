import { useRef, useState } from "react";

/** Something to copy out of the app, such as a token or a link, shown in full with a button that copies it. */
export function Copyable({ label, value }: { label: string; value: string }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    field.current?.select();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // A page served over plain http has no clipboard to write to, and can still copy what's selected.
      document.execCommand("copy");
    }
    setCopied(true);
  };
  return (
    <label className="copyable">
      <span>{label}</span>
      <span className="copyable-row">
        <textarea ref={field} readOnly value={value} rows={value.split("\n").length} wrap="off" spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="button small" aria-label={`Copy ${label}`} onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </span>
    </label>
  );
}
