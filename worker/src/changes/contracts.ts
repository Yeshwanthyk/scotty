export const CHANGED_FILE_LIMIT = 100;
export const CHANGED_PATH_MAX_LENGTH = 4_096;
export const PATCH_MAX_BYTES = 256 * 1_024;

export type ChangedFileStatus =
  | "added"
  | "copied"
  | "deleted"
  | "modified"
  | "renamed"
  | "type_changed"
  | "unmerged"
  | "untracked";

export interface ChangedFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: ChangedFileStatus;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly additions?: number;
  readonly deletions?: number;
  readonly binary: boolean;
  readonly patchable: boolean;
}

export interface ChangedFiles {
  readonly files: ReadonlyArray<ChangedFile>;
  readonly truncated: boolean;
}

export interface ChangedFilePatch extends ChangedFile {
  readonly patch: string | null;
  readonly truncated: boolean;
}

export interface ParsedStatus {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: ChangedFileStatus;
  readonly staged: boolean;
  readonly unstaged: boolean;
}

export interface GitNumstat {
  readonly additions?: number;
  readonly deletions?: number;
  readonly binary: boolean;
}

const splitFixedFields = (
  value: string,
  fieldCount: number,
): { readonly fields: ReadonlyArray<string>; readonly remainder: string } | undefined => {
  const fields: string[] = [];
  let offset = 0;
  for (let index = 0; index < fieldCount; index += 1) {
    const separator = value.indexOf(" ", offset);
    if (separator === -1) return undefined;
    fields.push(value.slice(offset, separator));
    offset = separator + 1;
  }
  if (offset >= value.length) return undefined;
  return { fields, remainder: value.slice(offset) };
};

const statusFromCode = (kind: string, code: string): ChangedFileStatus => {
  if (kind === "?") return "untracked";
  if (kind === "u" || code.includes("U")) return "unmerged";
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  if (code.includes("T")) return "type_changed";
  return "modified";
};

const trackedStatus = (
  record: string,
  fieldCount: number,
  oldPath?: string,
): ParsedStatus | undefined => {
  const parsed = splitFixedFields(record, fieldCount);
  const kind = record.slice(0, 1);
  const code = parsed?.fields[1];
  if (parsed === undefined || code === undefined || code.length !== 2) return undefined;
  const first = code.slice(0, 1);
  const second = code.slice(1, 2);
  return {
    path: parsed.remainder,
    ...(oldPath === undefined ? {} : { oldPath }),
    status: statusFromCode(kind, code),
    staged: first !== ".",
    unstaged: second !== ".",
  };
};

export function parseGitStatus(output: string): ReadonlyArray<ParsedStatus> {
  const records = output.split("\0");
  const files: ParsedStatus[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const kind = record.slice(0, 1);
    if (kind === "?") {
      const path = record.slice(2);
      if (path)
        files.push({
          path,
          status: "untracked",
          staged: false,
          unstaged: true,
        });
      continue;
    }
    if (kind === "2") {
      const oldPath = records[index + 1];
      const parsed = trackedStatus(record, 9, oldPath || undefined);
      if (parsed !== undefined) files.push(parsed);
      index += 1;
      continue;
    }
    const parsed = trackedStatus(record, kind === "u" ? 10 : 8);
    if (parsed !== undefined) files.push(parsed);
  }
  return files;
}

export function parseGitNumstat(output: string): ReadonlyMap<string, GitNumstat> {
  const stats = new Map<string, GitNumstat>();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) continue;
    const additions = record.slice(0, firstTab);
    const deletions = record.slice(firstTab + 1, secondTab);
    const path = record.slice(secondTab + 1);
    if (!path) continue;
    const binary = additions === "-" || deletions === "-";
    stats.set(path, {
      ...(binary ? {} : { additions: Number(additions), deletions: Number(deletions) }),
      binary,
    });
  }
  return stats;
}

const combinedStats = (
  file: ParsedStatus,
  tracked: ReadonlyMap<string, GitNumstat>,
  untracked: ReadonlyMap<string, GitNumstat>,
): GitNumstat | undefined => {
  if (file.status === "untracked") return untracked.get(file.path);
  const current = tracked.get(file.path);
  const previous = file.oldPath === undefined ? undefined : tracked.get(file.oldPath);
  if (current === undefined && previous === undefined) return undefined;
  if (current?.binary === true || previous?.binary === true) return { binary: true };
  return {
    additions: (current?.additions ?? 0) + (previous?.additions ?? 0),
    deletions: (current?.deletions ?? 0) + (previous?.deletions ?? 0),
    binary: false,
  };
};

export function changedFilesFromGit(
  statusOutput: string,
  trackedNumstatOutput: string,
  untrackedNumstatOutput: string,
  forcedTruncated = false,
): ChangedFiles {
  const statuses = parseGitStatus(statusOutput);
  return changedFilesFromStatuses(
    statuses,
    trackedNumstatOutput,
    untrackedNumstatOutput,
    forcedTruncated,
  );
}

export function changedFilesFromStatuses(
  statuses: ReadonlyArray<ParsedStatus>,
  trackedNumstatOutput: string,
  untrackedNumstatOutput: string,
  forcedTruncated = false,
): ChangedFiles {
  const tracked = parseGitNumstat(trackedNumstatOutput);
  const untracked = parseGitNumstat(untrackedNumstatOutput);
  const files = statuses.slice(0, CHANGED_FILE_LIMIT).map((file): ChangedFile => {
    const stats = combinedStats(file, tracked, untracked);
    const binary = stats?.binary ?? false;
    const patchable = !binary && file.status !== "unmerged";
    return {
      ...file,
      ...(stats?.additions === undefined ? {} : { additions: stats.additions }),
      ...(stats?.deletions === undefined ? {} : { deletions: stats.deletions }),
      binary,
      patchable,
    };
  });
  return { files, truncated: forcedTruncated || statuses.length > CHANGED_FILE_LIMIT };
}

export function parseChangedPath(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > CHANGED_PATH_MAX_LENGTH ||
    value.includes("\0")
  )
    return undefined;
  return value;
}
