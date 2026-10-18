import { useState } from "react";
import { compact, type DiffLine, type FileDiff } from "../data/diff";
import { Icon } from "./Icon";

// Unchanged runs longer than `after` lines fold to `keep` lines either side of the changes, as in
// a review. A phone folds tighter, so there is less to scroll past, though never to hide one line.
export type Fold = { after: number; keep: number };
export const wideFold: Fold = { after: 8, keep: 3 };
export const narrowFold: Fold = { after: 7, keep: 3 };

type Row = { kind: "line"; line: DiffLine } | { kind: "fold"; at: number; lines: DiffLine[] };

function rows(lines: ReadonlyArray<DiffLine>, fold: Fold | undefined): Row[] {
  const out: Row[] = [];
  for (let at = 0; at < lines.length;) {
    let end = at;
    while (lines[end]?.kind === "ctx") end++;
    const run = lines.slice(at, end);
    if (fold !== undefined && run.length > fold.after) {
      const hidden = run.slice(fold.keep, run.length - fold.keep);
      for (const line of run.slice(0, fold.keep)) out.push({ kind: "line", line });
      out.push({ kind: "fold", at: at + fold.keep, lines: hidden });
      for (const line of run.slice(run.length - fold.keep)) out.push({ kind: "line", line });
    } else for (const line of run) out.push({ kind: "line", line });
    const line = lines[end];
    if (line !== undefined) out.push({ kind: "line", line });
    at = end + 1;
  }
  return out;
}

// The gutter holds both line numbers and the +/- marker; a phone shows one number (CSS picks it).
// It stays put when a long line wraps or the rows scroll sideways.
function Gutter({ line }: { line?: DiffLine }) {
  return (
    <span className="gutter">
      <span className="n" data-side="old">
        {line?.old ?? ""}
      </span>
      <span className="n" data-side="new">
        {line?.new ?? ""}
      </span>
      <span className="mark" />
    </span>
  );
}

function Line({ line }: { line: DiffLine }) {
  return (
    <div className="diff-line" data-kind={line.kind} role="row">
      <Gutter line={line} />
      <code>
        {line.kind === "hunk" ? line.text.replace(/^@@.*?@@\s?/, "") || "···" : line.text}
      </code>
    </div>
  );
}

export function DiffLines({
  file,
  limit,
  wrap = false,
  fold,
}: {
  file: FileDiff;
  limit?: number;
  wrap?: boolean;
  fold?: Fold;
}) {
  const [all, setAll] = useState(false);
  // Folds the reader opened, by the index of their first hidden line.
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
  const shown = limit === undefined || all ? file.lines : file.lines.slice(0, limit);
  return (
    <div
      className="diff-lines"
      data-wrap={wrap}
      role="table"
      aria-label={`Changes to ${file.path}`}
    >
      {rows(shown, fold).map((row, index) =>
        row.kind === "line" ? (
          <Line key={index} line={row.line} />
        ) : opened.has(row.at) ? (
          row.lines.map((line, at) => <Line key={`${index}:${at}`} line={line} />)
        ) : (
          <button
            key={index}
            type="button"
            className="diff-line pressable"
            data-kind="fold"
            onClick={() => setOpened((set) => new Set(set).add(row.at))}
          >
            <Gutter />
            <code>
              {row.lines.length} unchanged {row.lines.length === 1 ? "line" : "lines"}
            </code>
          </button>
        ),
      )}
      {shown.length < file.lines.length ? (
        <button
          type="button"
          className="diff-line pressable"
          data-kind="fold"
          onClick={() => setAll(true)}
        >
          <Gutter />
          <code>{file.lines.length - shown.length} more lines</code>
        </button>
      ) : null}
    </div>
  );
}

export function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="tabular mono" style={{ display: "inline-flex", gap: 6 }}>
      {added > 0 ? <span className="stat-add">+{compact(added)}</span> : null}
      {removed > 0 ? <span className="stat-del">−{compact(removed)}</span> : null}
    </span>
  );
}

const split = (path: string) => {
  const at = path.lastIndexOf("/");
  return { dir: at < 0 ? "" : path.slice(0, at + 1), name: path.slice(at + 1) };
};

export const fileIcon = (file: FileDiff) =>
  file.kind === "add" ? "filePlus" : file.kind === "delete" ? "fileMinus" : "file";

// The name stays whole; the directory gives way first, losing its start.
export function DiffPath({ path }: { path: string }) {
  const { dir, name } = split(path);
  return (
    <span className="path mono" title={path}>
      {dir ? (
        <span className="dir">
          <bdi>{dir}</bdi>
        </span>
      ) : null}
      <b>{name}</b>
    </span>
  );
}

export function DiffFile({
  file,
  open,
  onToggle,
  onView,
  wrap = false,
  fold,
}: {
  file: FileDiff;
  open: boolean;
  onToggle: () => void;
  onView: () => void;
  wrap?: boolean;
  fold?: Fold;
}) {
  return (
    <section className="diff-file" data-path={file.path}>
      <div className="diff-file-head">
        <button type="button" className="diff-file-toggle" aria-expanded={open} onClick={onToggle}>
          <Icon name="chevronRight" size={14} className="chevron" />
          <Icon name={fileIcon(file)} size={14} />
          <DiffPath path={file.path} />
          <span className="diff-file-stat">
            <DiffStat added={file.added} removed={file.removed} />
          </span>
        </button>
        <button
          type="button"
          className="icon-button pressable diff-file-view"
          aria-label={`View ${file.path} full screen`}
          onClick={onView}
        >
          <Icon name="expand" size={14} />
        </button>
      </div>
      {open ? <DiffLines file={file} limit={400} wrap={wrap} fold={fold} /> : null}
    </section>
  );
}
