import { CODEX_ROLLOUT_RELATIVE_PATH, CODEX_SAVED_STATE_MAX_BYTES } from "./persistence-format";

export interface CodexRolloutFile {
  readonly path: string;
  readonly size: number;
}

// GNU find emits only relative names, byte sizes and link counts. Reject the
// entire listing if a native path cannot belong to the private sessions tree.
export function parseCodexRolloutListing(stdout: string): ReadonlyArray<CodexRolloutFile> | null {
  if (!stdout.endsWith("\n") || stdout.length > 40_000) return null;
  const lines = stdout.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.length > 128) return null;
  const seen = new Set<string>();
  const files: CodexRolloutFile[] = [];
  let total = 0;
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length !== 3) return null;
    const [path, sizeText, links] = fields;
    if (
      path === undefined ||
      path.length > 256 ||
      !CODEX_ROLLOUT_RELATIVE_PATH.test(path) ||
      seen.has(path) ||
      sizeText === undefined ||
      !/^[1-9][0-9]*$/u.test(sizeText) ||
      links !== "1"
    )
      return null;
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size > CODEX_SAVED_STATE_MAX_BYTES - total) return null;
    total += size;
    seen.add(path);
    files.push({ path, size });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
