import type { ReactNode } from "react";

/** What a placeholder will become, and the issue that builds it. */
export function Soon({ issue, children }: { issue: number; children: ReactNode }) {
  return (
    <p className="soon">
      {children}{" "}
      <a href={`https://github.com/paudrow/common-ink-v3/issues/${issue}`} target="_blank" rel="noreferrer">
        #{issue}
      </a>
      .
    </p>
  );
}
