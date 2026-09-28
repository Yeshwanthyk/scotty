import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Schema, Stream } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { failure } from "../client.js";
import { output, url, withClient } from "./common.js";

const Skill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  sha256: Schema.String,
  size: Schema.Number,
});
const Settings = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      enabled: Schema.Boolean,
      size: Schema.Number,
    }),
  ),
});

const hint = "scotty skill add <folder with SKILL.md | skill.zip>";

// A folder is zipped with its contents at the root, leaving out git and dotfiles.
const zipFolder = (folder: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("zip", ["-qr", "-", ".", "-x", ".*", "*/.*"], {
        cwd: folder,
        stdin: "ignore",
        stderr: "ignore",
      }),
    );
    const parts = yield* Stream.runCollect(child.stdout);
    if ((yield* child.exitCode) !== 0) return yield* failure("zip_failed", "zip failed", hint, 2);
    const zip = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
    let at = 0;
    for (const part of parts) {
      zip.set(part, at);
      at += part.byteLength;
    }
    return zip;
  }).pipe(Effect.scoped);

const read = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(path);
    if (info.type === "Directory") return yield* zipFolder(path);
    return yield* fs.readFile(path);
  }).pipe(
    Effect.provide(BunServices.layer),
    Effect.catchTag("PlatformError", () =>
      Effect.fail(failure("not_found", `Could not read ${path}`, hint, 2)),
    ),
  );

const add = Command.make("add", { url, path: Argument.String("path") }, ({ url: target, path }) =>
  Effect.gen(function* () {
    const zip = yield* read(path);
    const api = yield* withClient(target);
    return yield* output(yield* api("/api/skills", Skill, { method: "PUT", body: zip }));
  }),
).pipe(Command.withDescription("Upload a skill, replacing one with the same name"));

const ls = Command.make("ls", { url }, ({ url: target }) =>
  Effect.gen(function* () {
    const api = yield* withClient(target);
    return yield* output((yield* api("/api/settings", Settings)).skills);
  }),
).pipe(Command.withDescription("List skills"));

export const skill = Command.make("skill").pipe(Command.withSubcommands([add, ls]));
