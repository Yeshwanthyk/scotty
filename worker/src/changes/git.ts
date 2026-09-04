import { Effect, Predicate } from "effect";
import { SandboxRuntime, SandboxRuntimeFailure, shellQuote } from "../sandbox/runtime";
import {
  CHANGED_FILE_LIMIT,
  PATCH_MAX_BYTES,
  changedFilesFromStatuses,
  parseGitStatus,
  type ChangedFile,
  type ChangedFilePatch,
  type ChangedFiles,
} from "./contracts";

const GIT_TIMEOUT_MILLIS = 15_000;
const PATCH_CAPTURE_BYTES = PATCH_MAX_BYTES + 1;
const LIST_MAX_BYTES = 512 * 1_024;
type GitRuntime = Pick<SandboxRuntime["Service"], "execChecked">;
type StatusFile = ReturnType<typeof parseGitStatus>[number];

const SCOTTY_RUNTIME_DIRECTORIES = [".codex/", ".home/", ".pi-agent/", ".scotty/"];

const isVisibleStatus = (file: StatusFile): boolean =>
  file.status !== "untracked" ||
  !SCOTTY_RUNTIME_DIRECTORIES.some((directory) => file.path.startsWith(directory));

const uniqueStatuses = (files: ReadonlyArray<StatusFile>): ReadonlyArray<StatusFile> => {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = `${file.status}\0${file.oldPath ?? ""}\0${file.path}\0${file.staged}\0${file.unstaged}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const boundedGitReadCommand = (command: string, maxBytes: number): string => {
  const script = [
    `${command} | head -c ${maxBytes + 1} | base64 | tr -d '\\n'`,
    "status=${PIPESTATUS[0]}",
    "((status == 0 || status == 141))",
  ].join("\n");
  return `bash -lc ${shellQuote(script)}`;
};

const decodeGitTransport = (encoded: string): Effect.Effect<string, SandboxRuntimeFailure> =>
  Effect.try({
    try: () => {
      const binary = atob(encoded.trim());
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1)
        bytes[index] = binary.charCodeAt(index);
      return new TextDecoder().decode(bytes);
    },
    catch: () =>
      new SandboxRuntimeFailure({
        reason: "transport",
        message: "Sandbox Git output was not valid base64",
      }),
  });

const INTERNAL_PATHS = [".codex", ".home", ".pi-agent", ".scotty"];
const visiblePathspecs = INTERNAL_PATHS.flatMap((path) => [
  shellQuote(`:(top,exclude)${path}`),
  shellQuote(`:(top,exclude)${path}/**`),
]);
export const GIT_STATUS_COMMAND = boundedGitReadCommand(
  `(${[
    `git --no-optional-locks status --porcelain=v2 -z --untracked-files=all -- . ${visiblePathspecs.join(" ")}`,
    "git --no-optional-locks status --porcelain=v2 -z --untracked-files=no",
  ].join(" && ")})`,
  LIST_MAX_BYTES,
);

const uniquePaths = (files: ReadonlyArray<StatusFile>): ReadonlyArray<string> => [
  ...new Set(files.flatMap((file) => [file.oldPath, file.path]).filter(Predicate.isNotUndefined)),
];

export const gitTrackedNumstatCommand = (files: ReadonlyArray<StatusFile>): string => {
  const paths = uniquePaths(files.filter((file) => file.status !== "untracked"));
  if (paths.length === 0) return "printf ''";
  const command = `git --literal-pathspecs diff --no-ext-diff --no-textconv --numstat -z --no-renames HEAD -- ${paths.map(shellQuote).join(" ")}`;
  return boundedGitReadCommand(command, LIST_MAX_BYTES);
};

const UNTRACKED_NUMSTAT_SCRIPT = [
  "for path do",
  "  additions=''",
  "  deletions=''",
  "  IFS=$'\\t' read -r additions deletions _ < <(git --literal-pathspecs diff --no-index --no-ext-diff --no-textconv --numstat -- /dev/null \"$path\" 2>/dev/null)",
  '  [[ -n "$additions" && -n "$deletions" ]] || continue',
  '  printf \'%s\\t%s\\t%s\\0\' "$additions" "$deletions" "$path"',
  "done",
].join("\n");

export const gitUntrackedNumstatCommand = (files: ReadonlyArray<StatusFile>): string => {
  const paths = files.filter((file) => file.status === "untracked").map((file) => file.path);
  if (paths.length === 0) return boundedGitReadCommand("printf ''", LIST_MAX_BYTES);
  return boundedGitReadCommand(
    `bash -lc ${shellQuote(UNTRACKED_NUMSTAT_SCRIPT)} scotty-paths ${paths.map(shellQuote).join(" ")}`,
    LIST_MAX_BYTES,
  );
};

const execOptions = (root: string) => ({ cwd: root, timeout: GIT_TIMEOUT_MILLIS });

const boundedText = (
  value: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } => {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
  let limit = maxBytes;
  const decoder = new TextDecoder();
  let text = decoder.decode(bytes.slice(0, limit));
  while (encoder.encode(text).byteLength > maxBytes) {
    limit -= 1;
    text = decoder.decode(bytes.slice(0, limit));
  }
  return { text, truncated: true };
};

const readStatus = Effect.fnUntraced(function* (
  runtime: GitRuntime,
  root: string,
): Effect.fn.Return<
  {
    readonly output: string;
    readonly files: ReadonlyArray<StatusFile>;
    readonly truncated: boolean;
  },
  SandboxRuntimeFailure
> {
  const result = yield* runtime.execChecked(GIT_STATUS_COMMAND, execOptions(root));
  const decoded = yield* decodeGitTransport(result.stdout);
  const bounded = boundedText(decoded, LIST_MAX_BYTES);
  const output = bounded.truncated
    ? bounded.text.slice(0, Math.max(0, bounded.text.lastIndexOf("\0") + 1))
    : bounded.text;
  const parsed = uniqueStatuses(parseGitStatus(output).filter(isVisibleStatus));
  return {
    output,
    files: parsed.slice(0, CHANGED_FILE_LIMIT),
    truncated: bounded.truncated || parsed.length > CHANGED_FILE_LIMIT,
  };
});

const readStats = Effect.fnUntraced(function* (
  runtime: GitRuntime,
  root: string,
  files: ReadonlyArray<StatusFile>,
): Effect.fn.Return<
  { readonly tracked: string; readonly untracked: string },
  SandboxRuntimeFailure
> {
  const tracked = yield* runtime.execChecked(gitTrackedNumstatCommand(files), execOptions(root));
  const untracked = yield* runtime.execChecked(
    gitUntrackedNumstatCommand(files),
    execOptions(root),
  );
  return {
    tracked: boundedText(yield* decodeGitTransport(tracked.stdout), LIST_MAX_BYTES).text,
    untracked: boundedText(yield* decodeGitTransport(untracked.stdout), LIST_MAX_BYTES).text,
  };
});

export const listGitWorktreeChanges = Effect.fnUntraced(function* (
  runtime: GitRuntime,
  root: string,
): Effect.fn.Return<ChangedFiles, SandboxRuntimeFailure> {
  const status = yield* readStatus(runtime, root);
  const stats = yield* readStats(runtime, root, status.files);
  return changedFilesFromStatuses(status.files, stats.tracked, stats.untracked, status.truncated);
});

export const findGitWorktreeChange = Effect.fnUntraced(function* (
  runtime: GitRuntime,
  root: string,
  path: string,
): Effect.fn.Return<ChangedFile | undefined, SandboxRuntimeFailure> {
  const status = yield* readStatus(runtime, root);
  const candidate = status.files.find((file) => file.path === path);
  if (candidate === undefined) return undefined;
  const stats = yield* readStats(runtime, root, [candidate]);
  return changedFilesFromStatuses(
    [candidate],
    stats.tracked,
    stats.untracked,
    status.truncated,
  ).files.find((file) => file.path === path);
});

export const gitPatchCommand = (file: Pick<ChangedFile, "oldPath" | "path" | "status">): string => {
  const path = shellQuote(file.path);
  const trackedPaths = [file.oldPath, file.path]
    .filter(Predicate.isNotUndefined)
    .map(shellQuote)
    .join(" ");
  const diff =
    file.status === "untracked"
      ? `git --literal-pathspecs diff --no-index --no-ext-diff --no-textconv --no-color --unified=3 -- /dev/null ${path}`
      : `git --literal-pathspecs diff --no-ext-diff --no-textconv --no-color --unified=3 HEAD -- ${trackedPaths}`;
  const acceptedStatuses =
    file.status === "untracked" ? "0 || status == 1 || status == 141" : "0 || status == 141";
  const script = [
    `${diff} | head -c ${PATCH_CAPTURE_BYTES}`,
    "status=${PIPESTATUS[0]}",
    `((status == ${acceptedStatuses}))`,
  ].join("\n");
  return `bash -lc ${shellQuote(script)}`;
};

export const readGitWorktreePatch = Effect.fnUntraced(function* (
  runtime: GitRuntime,
  root: string,
  file: ChangedFile,
): Effect.fn.Return<ChangedFilePatch, SandboxRuntimeFailure> {
  if (!file.patchable) return { ...file, patch: null, truncated: false };
  const result = yield* runtime.execChecked(gitPatchCommand(file), execOptions(root));
  const bounded = boundedText(result.stdout, PATCH_MAX_BYTES);
  return { ...file, patch: bounded.text, truncated: bounded.truncated };
});
