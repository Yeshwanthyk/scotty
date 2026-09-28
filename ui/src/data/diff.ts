import type { Change, Turn } from "../protocol/session/conversation";

export type DiffLine = {
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
  old: number | null;
  new: number | null;
};

export type FileDiff = {
  path: string;
  kind: "add" | "delete" | "update";
  lines: DiffLine[];
  added: number;
  removed: number;
};

const stats = (lines: DiffLine[]) => ({
  added: lines.filter((line) => line.kind === "add").length,
  removed: lines.filter((line) => line.kind === "del").length,
});

// A unified diff body (hunks only, or with ---/+++ headers) as numbered lines.
export function parseHunks(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let old = 0;
  let next = 0;
  for (const raw of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk !== null) {
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      lines.push({ kind: "hunk", text: raw, old: null, new: null });
    } else if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("\\")) {
      continue;
    } else if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1), old: null, new: next++ });
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw.slice(1), old: old++, new: null });
    } else if (raw.startsWith(" ") && lines.length > 0) {
      lines.push({ kind: "ctx", text: raw.slice(1), old: old++, new: next++ });
    }
  }
  return lines;
}

// Codex gives a new file's content as its diff, and an edit as hunks.
export function changeDiff(change: Change): FileDiff {
  const lines =
    change.kind === "add" && !change.diff.includes("\n@@") && !change.diff.startsWith("@@")
      ? change.diff
          .replace(/\n$/, "")
          .split("\n")
          .map((text, index): DiffLine => ({ kind: "add", text, old: null, new: index + 1 }))
      : parseHunks(change.diff);
  return { path: change.path, kind: change.kind, lines, ...stats(lines) };
}

// A turn's cumulative `git diff` split into files.
export function splitDiff(diff: string): FileDiff[] {
  return diff
    .split(/^(?=diff --git )/m)
    .filter((part) => part.startsWith("diff --git "))
    .map((part) => {
      const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part);
      const path = header?.[2] ?? "file";
      const kind = /^new file mode/m.test(part)
        ? ("add" as const)
        : /^deleted file mode/m.test(part)
          ? ("delete" as const)
          : ("update" as const);
      const lines = parseHunks(part);
      return { path, kind, lines, ...stats(lines) };
    });
}

// Files changed across the session. Codex diffs each turn from its start, so a file
// touched in several turns keeps every turn's hunks, oldest first.
export function sessionChanges(turns: ReadonlyArray<Turn>): FileDiff[] {
  const files = new Map<string, FileDiff>();
  for (const turn of turns) {
    const fromDiff = splitDiff(turn.diff);
    const changes =
      fromDiff.length > 0
        ? fromDiff
        : turn.items.flatMap((item) => (item.kind === "tool" ? item.changes.map(changeDiff) : []));
    for (const file of changes) {
      const earlier = files.get(file.path);
      files.delete(file.path);
      if (earlier === undefined || file.kind === "delete") files.set(file.path, file);
      else {
        const lines = [...earlier.lines, ...file.lines];
        files.set(file.path, { ...file, kind: earlier.kind, lines, ...stats(lines) });
      }
    }
  }
  return [...files.values()].reverse();
}

export const compact = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
