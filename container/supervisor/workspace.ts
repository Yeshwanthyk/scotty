import { Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { codexHome } from "./codex-config.js";
import { processEnv } from "./runtime.js";

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  message: Schema.String,
}) {}
const failure = () => new WorkspaceError({ message: "workspace command failed" });
const run = (args: string[], cwd: string) =>
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
        yield* child.stderr.pipe(Stream.runDrain, Effect.forkScoped);
        const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.runCollect);
        const code = yield* child.exitCode;
        if (code !== ChildProcessSpawner.ExitCode(0)) return yield* failure();
        return output.join("").trim();
      }),
    ).pipe(Effect.mapError(() => failure()));
  });

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

export const prepareWorkspace = (repo: string, base: string, branch: string) =>
  Effect.gen(function* () {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.includes(".."))
      return yield* new WorkspaceError({ message: "invalid repository" });
    if (base.startsWith("-") || branch.startsWith("-"))
      return yield* new WorkspaceError({ message: "invalid branch" });
    const root = workspaceRoot();
    yield* run(["git", "check-ref-format", "--branch", base], root);
    yield* run(["git", "check-ref-format", "--branch", branch], root);
    const dir = `${root}/repo`;
    yield* run(
      ["git", "clone", "--depth", "1", "--branch", base, `https://github.com/${repo}`, dir],
      root,
    );
    yield* run(["git", "checkout", "-b", branch], dir);
    const commit = yield* run(["git", "rev-parse", "HEAD"], dir);
    return { dir, commit };
  });
