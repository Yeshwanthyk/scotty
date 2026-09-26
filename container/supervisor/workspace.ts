import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
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

export const prepareWorkspace = (repo: string, base: string, branch: string) =>
  Effect.gen(function* () {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.includes(".."))
      return yield* new WorkspaceError({ message: "invalid repository" });
    if (base.startsWith("-") || branch.startsWith("-"))
      return yield* new WorkspaceError({ message: "invalid branch" });
    const root = processEnv("SCOTTY_WORKSPACE_ROOT") || "/workspace";
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
