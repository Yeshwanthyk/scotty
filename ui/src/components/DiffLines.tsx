import { useState } from "react";
import { compact, type DiffLine, type FileDiff } from "../data/diff";
import { Icon } from "./Icon";

// Unchanged runs longer than this fold into a "N hidden lines" row, as in a review.
const foldAfter = 8;

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

export function DiffLines({
  file,
  limit,
  wrap = false,
}: {
  file: FileDiff;
  limit?: number;
  wrap?: boolean;
}) {
  const [all, setAll] = useState(false);
  const shown = limit === undefined || all ? file.lines : file.lines.slice(0, limit);
  return (
    <div
      className="diff-lines"
      data-wrap={wrap}
      role="table"
      aria-label={`Changes to ${file.path}`}
    >
      {shown.map((line, index) => (
        <div className="diff-line" data-kind={line.kind} key={index} role="row">
          <Gutter line={line} />
          <code>
            {line.kind === "hunk" ? line.text.replace(/^@@.*?@@\s?/, "") || "···" : line.text}
          </code>
        </div>
      ))}
      {shown.length < file.lines.length ? (
        <button
          type="button"
          className="diff-line pressable"
          data-kind="hunk"
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

export function DiffFile({
  file,
  open: initial = true,
  wrap = false,
}: {
  file: FileDiff;
  open?: boolean;
  wrap?: boolean;
}) {
  const [open, setOpen] = useState(initial);
  const { dir, name } = split(file.path);
  return (
    <section className="diff-file">
      <button
        type="button"
        className="diff-file-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="chevronRight" size={14} className="chevron" />
        <Icon
          name={file.kind === "add" ? "filePlus" : file.kind === "delete" ? "fileMinus" : "file"}
          size={14}
        />
        {/* The name stays whole; the directory gives way first, losing its start. */}
        <span className="path mono" title={file.path}>
          {dir ? (
            <span className="dir">
              <bdi>{dir}</bdi>
            </span>
          ) : null}
          <b>{name}</b>
        </span>
        <span className="diff-file-stat">
          <DiffStat added={file.added} removed={file.removed} />
        </span>
      </button>
      {open ? <DiffLines file={foldContext(file)} limit={400} wrap={wrap} /> : null}
    </section>
  );
}

// Long unchanged stretches become one hunk row so the eye lands on what changed.
function foldContext(file: FileDiff): FileDiff {
  const lines = file.lines.flatMap((line, index, list) => {
    if (line.kind !== "ctx") return [line];
    let start = index;
    while (start > 0 && list[start - 1]?.kind === "ctx") start--;
    let end = index;
    while (end < list.length - 1 && list[end + 1]?.kind === "ctx") end++;
    const run = end - start + 1;
    if (run <= foldAfter) return [line];
    const keep = 3;
    if (index - start < keep || end - index < keep) return [line];
    return index - start === keep
      ? [{ kind: "hunk" as const, text: `${run - keep * 2} unchanged lines`, old: null, new: null }]
      : [];
  });
  return { ...file, lines };
}
