import { useState } from "react";
import { compact, type FileDiff } from "../data/diff";
import { Icon } from "./Icon";

// Unchanged runs longer than this fold into a "N hidden lines" row, as in a review.
const foldAfter = 8;

export function DiffLines({ file, limit }: { file: FileDiff; limit?: number }) {
  const [all, setAll] = useState(false);
  const shown = limit === undefined || all ? file.lines : file.lines.slice(0, limit);
  return (
    <div className="diff-lines" role="table" aria-label={`Changes to ${file.path}`}>
      {shown.map((line, index) => (
        <div className="diff-line" data-kind={line.kind} key={index} role="row">
          <span className="n">{line.old ?? ""}</span>
          <span className="n">{line.new ?? ""}</span>
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
          <span className="n" />
          <span className="n" />
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

export function DiffFile({ file, open: initial = true }: { file: FileDiff; open?: boolean }) {
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
        <span className="path mono">
          <bdi>
            <span>{dir}</span>
            <b>{name}</b>
          </bdi>
        </span>
        <span className="stats">
          <DiffStat added={file.added} removed={file.removed} />
        </span>
      </button>
      {open ? <DiffLines file={foldContext(file)} limit={400} /> : null}
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
