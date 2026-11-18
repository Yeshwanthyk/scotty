import { Effect, FileSystem } from "effect";
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
