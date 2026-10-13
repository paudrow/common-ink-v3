import { useMemo, useState, type ReactNode } from "react";
import type { Author, Diff } from "../core/protocol.ts";
import { count, hueOf, initials, pieces, type Piece } from "./historyView.ts";
import { Icon } from "./icons.tsx";

export function Stat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="change-stat">
      <span className="added">+{added}</span> <span className="removed">−{removed}</span>
    </span>
  );
}

/** Who made a change, as a picture: a person's initials in a circle, an agent's mark in a rounded square of its own hue. */
export function Avatar({ author }: { author: Author }) {
  const agent = author.kind === "agent";
  return (
    <span className={agent ? "avatar agent" : "avatar"} style={{ "--hue": agent ? hueOf(author.name) : 150 } as React.CSSProperties} title={agent ? `${author.name}, an agent` : author.name} aria-hidden="true">
      {agent ? <Icon name="agent" /> : initials(author.name)}
    </span>
  );
}

const MARK = { add: "+", del: "−", mod: "~", same: "" } as const;

function Line({ kind, children }: { kind: keyof typeof MARK; children: ReactNode }) {
  const Tag = kind === "add" ? "ins" : kind === "del" ? "del" : "div";
  return (
    <Tag className={`diff-line ${kind}`}>
      <span className="diff-mark" aria-hidden="true">
        {MARK[kind]}
      </span>
      <span className="diff-text">{children}</span>
    </Tag>
  );
}

const shown = (text: string) => text || " ";

interface DiffViewProps {
  diff: Diff;
  /** Reads the text the diff is from, for the unchanged lines it leaves out. Without it they stay folded away. */
  readBefore?: () => Promise<string>;
}

/**
 * A diff as prose: unchanged lines folded to a count that opens, a short rewrite shown once with the
 * words that changed marked, and added and removed lines each with a marker that is part of the line.
 */
export function DiffView({ diff, readBefore }: DiffViewProps) {
  const drawn = useMemo(() => pieces(diff), [diff]);
  const [before, setBefore] = useState<string[] | null>(null);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [failed, setFailed] = useState<string | null>(null);
  if (!diff.hunks.length) return <p className="diff-none">No text changed.</p>;

  const unfold = async (at: number) => {
    setFailed(null);
    try {
      if (!before) setBefore((await readBefore!()).split("\n"));
      setOpen((was) => new Set(was).add(at));
    } catch (err) {
      setFailed((err as Error).message);
    }
  };
  const draw = (piece: Piece, at: number): ReactNode => {
    switch (piece.kind) {
      case "fold": {
        const hidden = piece.to - piece.from;
        if (before && open.has(at)) return before.slice(piece.from, piece.to).map((text, i) => <Line key={`${at}-${i}`} kind="same">{shown(text)}</Line>);
        const says = `⋯ ${count(hidden, "unchanged line")}`;
        return readBefore ? (
          <button key={at} type="button" className="diff-fold" onClick={() => void unfold(at)}>
            {says}
          </button>
        ) : (
          <div key={at} className="diff-fold">
            {says}
          </div>
        );
      }
      case "more":
        if (open.has(at)) return piece.lines.map((text, i) => <Line key={`${at}-${i}`} kind={piece.of}>{shown(text)}</Line>);
        return (
          <button key={at} type="button" className="diff-fold" onClick={() => setOpen((was) => new Set(was).add(at))}>
            ⋯ {piece.lines.length} more {piece.of === "add" ? "added" : "removed"} lines
          </button>
        );
      case "mod":
        return (
          <Line key={at} kind="mod">
            {piece.words.map((word, i) => (word.kind === "add" ? <ins key={i}>{word.text}</ins> : word.kind === "del" ? <del key={i}>{word.text}</del> : word.text))}
          </Line>
        );
      default:
        return (
          <Line key={at} kind={piece.kind}>
            {shown(piece.text)}
          </Line>
        );
    }
  };
  return (
    <div className="diff">
      {drawn.map(draw)}
      {diff.omitted > 0 && <p className="diff-none">{count(diff.omitted, "more changed line")} not shown: this change is long. Open the note to read it whole.</p>}
      {failed && <p role="alert" className="error">{failed}</p>}
    </div>
  );
}
