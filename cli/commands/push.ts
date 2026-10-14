import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { Saved, failure } from "../client.js";
import { dim, green, output, readStdin, withClient } from "./common.js";

// `-` reads the text from stdin.
const readText = (path: string) =>
  Effect.gen(function* () {
    if (path === "-") return yield* readStdin;
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(path);
  }).pipe(
    Effect.provide(BunServices.layer),
    Effect.mapError(() =>
      failure("not_found", `Could not read ${path}`, "scotty push instructions <file | ->", 2),
    ),
  );

export const push = Command.make(
  "push",
  {
    what: Argument.Literals("what", ["instructions"]),
    path: Argument.String("path"),
  },
  ({ path }) =>
    Effect.gen(function* () {
      const text = yield* readText(path);
      const api = yield* withClient;
      const saved = yield* api("/api/settings/instructions", Saved, {
        method: "PUT",
        body: { text },
      });
      yield* output(
        saved,
        text.trim() === ""
          ? `${green("✓")} Cleared the instructions`
          : `${green("✓")} Saved the instructions ${dim("· new sessions and resumes get them")}`,
      );
    }),
);
