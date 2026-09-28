import { Clock, Effect, Fiber, FileSystem, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { fixtureRepo } from "../../protocol/supervisor.js";
import { codexHome } from "./codex-config.js";
import { processEnv } from "./runtime.js";

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  message: Schema.String,
}) {}
const failure = () => new WorkspaceError({ message: "workspace command failed" });
class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  stderr: Schema.String,
}) {}
const exec = (args: string[], cwd: string) =>
  Effect.gen(function* () {
    const [command, ...parameters] = args;
    if (command === undefined) return yield* failure();
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(command, parameters, {
            cwd,
            extendEnv: false,
            forceKillAfter: "2 seconds",
            env: {
              PATH: processEnv("PATH"),
              HOME: processEnv("HOME") || "/home/scotty",
              GIT_TERMINAL_PROMPT: "0",
            },
          }),
        );
        const stderr = yield* child.stderr.pipe(
          Stream.decodeText(),
          Stream.mkString,
          Effect.forkScoped,
        );
        const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.runCollect);
        const code = yield* child.exitCode;
        if (code !== ChildProcessSpawner.ExitCode(0))
          return yield* new CommandFailed({ stderr: (yield* Fiber.join(stderr)).slice(-2000) });
        return output.join("").trim();
      }),
    );
  });
// The container holds no GitHub token, so git's last stderr line is safe to report.
const described = (error: unknown) => {
  const line =
    error instanceof CommandFailed
      ? error.stderr.trim().split("\n").at(-1)?.trim()
      : error instanceof Error
        ? error.name
        : undefined;
  return line
    ? new WorkspaceError({ message: `workspace command failed: ${line.slice(0, 300)}` })
    : failure();
};
const run = (args: string[], cwd: string) => exec(args, cwd).pipe(Effect.mapError(described));

// GitHub throttles Cloudflare's shared egress for minutes at a time (429 or 403, Retry-After
// 300), and a proxied transfer can drop. Waiting these out turns a failed start into a slow
// one; a 401 or 404 is a real answer. A retry often succeeds at once, so waits start at 1 s
// and grow to 30 s; the ~5 minutes they cover fit the workspace deadline.
const transient = (error: unknown) =>
  error instanceof CommandFailed &&
  /error: (429|403|5\d\d)|RPC failed|early EOF|Connection reset/.test(error.stderr) &&
  !/error: (401|404)/.test(error.stderr);
const backoff = Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("30 seconds")]);
// Each retried failure is reported in workspace.ready, so a slow start shows why.
const fromGitHub = (args: string[], cwd: string, retried: string[]) =>
  exec(args, cwd).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => {
        if (transient(error)) retried.push(described(error).message);
      }),
    ),
    Effect.retry({ while: transient, schedule: backoff, times: 14 }),
    Effect.mapError(described),
  );

const workspaceRoot = () => processEnv("SCOTTY_WORKSPACE_ROOT") || "/workspace";
const saveFile = () => `${workspaceRoot()}/save.tar`;

// Only what the base commit cannot rebuild: changed and untracked files, deleted paths,
// and the thread's rollout. Ignored files (dependencies, builds) are left out.
const saveScript = `set -e
out="$1"; base="$2"; home="$3"; thread="$4"; s=$(mktemp -d)
git diff -z --name-only --no-renames --diff-filter=D "$base" > "$s/deleted"
{ git diff -z --name-only --no-renames --diff-filter=d "$base"; git ls-files -z --others --exclude-standard; } > "$s/list"
rollout=$(cd "$home" && find sessions -name "rollout-*$thread*.jsonl" | head -n 1)
test -n "$rollout"
tar -cf "$out" -C "$s" deleted
tar -rf "$out" --null -T "$s/list" --transform 's,^,repo/,S'
tar -rf "$out" -C "$home" --transform 's,^,codex/,S' "$rollout"
rm -rf "$s"`;

export const saveWorkspace = (base: string, thread: string) =>
  Effect.gen(function* () {
    const dir = `${workspaceRoot()}/repo`;
    yield* run(["sh", "-c", saveScript, "save", saveFile(), base, codexHome(), thread], dir);
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFile(saveFile()).pipe(Effect.mapError(() => failure()));
  });

const restoreFile = () => `${workspaceRoot()}/restore.tar`;
const restoreScript = `set -e
tarfile="$1"; home="$2"; s=$(mktemp -d)
tar -xf "$tarfile" -C "$s"
if [ -d "$s/repo" ]; then cp -a "$s/repo/." .; fi
xargs -0 -r rm -f -- < "$s/deleted"
mkdir -p "$home" && cp -a "$s/codex/." "$home/"
rm -rf "$s" "$tarfile"`;

export const storeSave = (tar: Uint8Array) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFile(restoreFile(), tar).pipe(Effect.mapError(() => failure()));
  });

export const prepareWorkspace = (
  repo: string,
  base: string,
  branch: string,
  git: { readonly name: string; readonly email: string },
  resume?: { readonly commit: string },
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const retried: string[] = [];
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.includes(".."))
      return yield* new WorkspaceError({ message: "invalid repository" });
    if (base.startsWith("-") || branch.startsWith("-"))
      return yield* new WorkspaceError({ message: "invalid branch" });
    const root = workspaceRoot();
    yield* run(["git", "check-ref-format", "--branch", base], root);
    yield* run(["git", "check-ref-format", "--branch", branch], root);
    const dir = `${root}/repo`;
    // The Session DO routes github.internal to the Worker, which adds the token; git here has none.
    const config = {
      "url.http://github.internal/api/git/.insteadOf": "https://github.com/",
      "user.name": git.name,
      "user.email": git.email,
    };
    for (const [key, value] of Object.entries(config))
      yield* run(["git", "config", "--global", key, value], root);
    yield* fromGitHub(
      [
        "git",
        "clone",
        "--depth",
        "1",
        "--branch",
        base,
        repo === fixtureRepo ? "file:///opt/scotty/fixture.git" : `https://github.com/${repo}`,
        dir,
      ],
      root,
      retried,
    );
    if (resume === undefined) yield* run(["git", "checkout", "-b", branch], dir);
    else {
      yield* fromGitHub(["git", "fetch", "--depth", "1", "origin", resume.commit], dir, retried);
      yield* run(["git", "checkout", "-b", branch, resume.commit], dir);
      yield* run(["sh", "-c", restoreScript, "restore", restoreFile(), codexHome()], dir);
    }
    const commit = yield* run(["git", "rev-parse", "HEAD"], dir);
    const ms = (yield* Clock.currentTimeMillis) - started;
    return { dir, commit, ms, retried };
  });
