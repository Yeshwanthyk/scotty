import { Effect, FileSystem } from "effect";
import { processEnv, runDir } from "./runtime.js";

// The session this container belongs to, given by a place that keeps its disk. Cloudflare gives
// none, so there the container keeps no marker, needs no key, and writes files where it always did.
export const session = () => processEnv("SCOTTY_SESSION");
export const keepsDisk = () => session() !== "";

// Whether runDir is a tmpfs, so a token written there never rests on a paused disk. A place that
// keeps its disk must mount one; a container without it writes no token.
export const onTmpfs = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const mounts = yield* fs.readFileString("/proc/mounts").pipe(Effect.orElseSucceed(() => ""));
  return mounts.split("\n").some((line) => {
    const [, path, type] = line.split(" ");
    return path === runDir && type === "tmpfs";
  });
});
export const notTmpfs = `${runDir} is not a tmpfs; no token is written`;
