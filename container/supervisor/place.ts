import { Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { getgid, getuid } from "node:process";
import { processEnv, runDir } from "./runtime.js";

export const session = () => processEnv("SCOTTY_SESSION");
export const keepsDisk = () => session() !== "";

export const onTmpfs = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const mounts = yield* fs.readFileString("/proc/mounts").pipe(Effect.orElseSucceed(() => ""));
  return mounts.split("\n").some((line) => {
    const [, path, type] = line.split(" ");
    return path === runDir && type === "tmpfs";
  });
});
export const notTmpfs = `${runDir} is not a tmpfs; no token is written`;

export const mountTmpfs = Effect.gen(function* () {
  if (!keepsDisk() || (yield* onTmpfs)) return;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const options = `mode=0700,uid=${getuid?.() ?? 1001},gid=${getgid?.() ?? 1001},size=16m`;
  yield* Effect.scoped(
    spawner
      .spawn(
        ChildProcess.make("sudo", ["-n", "mount", "-t", "tmpfs", "-o", options, "tmpfs", runDir]),
      )
      .pipe(Effect.flatMap((child) => child.exitCode)),
  );
}).pipe(Effect.ignoreCause({ log: "Warn", message: `could not mount a tmpfs at ${runDir}` }));
