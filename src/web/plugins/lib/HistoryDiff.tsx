import { useMemo, useState, type ReactNode } from "react";
import { Icon, type Author, type Diff } from "../../plugin-api.ts";
import { count, hueOf, initials, pieces, type Piece, type Stretch } from "./historyView.ts";

export function Stat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="change-stat">
      <span className="added">+{added}</span> <span className="removed">−{removed}</span>
    </span>
  );
}

/** Who made a change, as a picture: a person's initials in a circle, an agent's or a plugin's mark in a rounded square of its own hue. */
export function Avatar({ author }: { author: Author }) {
  const agent = author.kind !== "member";
  return (
    <span className={agent ? "avatar agent" : "avatar"} data-kind={author.kind} style={{ "--hue": agent ? hueOf(author.name) : 150 } as React.CSSProperties} title={author.kind === "agent" ? `${author.name}, an agent` : author.kind === "plugin" ? `${author.name}, a plugin` : author.name} aria-hidden="true">
      {agent ? <Icon name={author.kind === "plugin" ? "plugin" : "agent"} /> : initials(author.name)}
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
const NO_MARKS: readonly Marked[] = [];
const markOf = (piece: Piece) => ("mark" in piece ? piece.mark : undefined);

/** Changed lines to mark as a conflict: what to say of them, and what pressing them does. */
export interface Marked extends Stretch {
  says: string;
  onOpen: () => void;
}

interface DiffViewProps {
  diff: Diff;
  /** Stretches of the text the diff leads to whose changed lines are marked. */
  marks?: readonly Marked[];
  /** Reads the text the diff is from, for the unchanged lines it leaves out. Without it they stay folded away. */
  readBefore?: () => Promise<string>;
}

/**
 * A diff as prose: unchanged lines folded to a count that opens, a short rewrite shown once with the
 * words that changed marked, and added and removed lines each with a marker that is part of the line.
 */
export function DiffView({ diff, marks = NO_MARKS, readBefore }: DiffViewProps) {
  const stretches = JSON.stringify(marks.map(({ from, to }) => ({ from, to })));
  const drawn = useMemo(() => pieces(diff, JSON.parse(stretches) as Stretch[]), [diff, stretches]);
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
          <button
            key={at}
            type="button"
            className="diff-fold"
            onClick={(e) => {
              // Inside marked lines, showing the rest of them is not pressing the mark.
              e.stopPropagation();
              setOpen((was) => new Set(was).add(at));
            }}
          >
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
  /** The pieces in order, each run of one mark's as one thing to press. */
  const all: ReactNode[] = [];
  for (let i = 0; i < drawn.length; ) {
    const mark = markOf(drawn[i]!);
    const marked = mark === undefined ? undefined : marks[mark];
    let end = i + 1;
    while (marked && end < drawn.length && markOf(drawn[end]!) === mark) end++;
    if (!marked) all.push(draw(drawn[i]!, i));
    else
      all.push(
        <div
          key={`mark-${i}`}
          className="diff-conflict"
          role="button"
          tabIndex={0}
          aria-label={`${marked.says}. Open the revert to settle it.`}
          title="Open the revert to settle this"
          onClick={marked.onOpen}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
            e.preventDefault();
            marked.onOpen();
          }}
        >
          <span className="diff-conflict-says">{marked.says}</span>
          {drawn.slice(i, end).map((piece, n) => draw(piece, i + n))}
        </div>,
      );
    i = end;
  }
  return (
    <div className="diff">
      {all}
      {diff.omitted > 0 && <p className="diff-none">{count(diff.omitted, "more changed line")} not shown: this change is long. Open the note to read it whole.</p>}
      {failed && <p role="alert" className="error">{failed}</p>}
    </div>
  );
}
