import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Stream } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Saved, Skill, SkillRemoved, failure } from "../client.js";
import { type Api, dim, green, output, readStdin, usage, withClient } from "./common.js";

const skillHint = "scotty push skill <folder with SKILL.md | skill.zip>";

// A folder is zipped with its contents at the root, leaving out git and dotfiles.
const zipFolder = (folder: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner
      .spawn(
        ChildProcess.make("zip", ["-qr", "-", ".", "-x", ".*", "*/.*"], {
          cwd: folder,
          stdin: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.mapError(() =>
          failure("zip_missing", "zip is not installed", "Install zip, or push a skill.zip", 3),
        ),
      );
    const parts = yield* Stream.runCollect(child.stdout);
    if ((yield* child.exitCode) !== 0)
      return yield* failure("zip_failed", `Could not zip ${folder}`, skillHint, 2);
    const zip = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
    let at = 0;
    for (const part of parts) {
      zip.set(part, at);
      at += part.byteLength;
    }
    return zip;
  }).pipe(Effect.scoped);

const readSkill = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(path);
    if (info.type === "Directory") return yield* zipFolder(path);
    return yield* fs.readFile(path);
  }).pipe(
    Effect.provide(BunServices.layer),
    Effect.catchTag("PlatformError", () =>
      Effect.fail(failure("not_found", `Could not read ${path}`, skillHint, 2)),
    ),
  );

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
    what: Argument.Literals("what", ["skill", "instructions"]),
    paths: Argument.String("path").pipe(Argument.atLeast(1)),
  },
  ({ what, paths }) =>
    Effect.gen(function* () {
      if (what === "instructions") {
        const [path, ...rest] = paths;
        if (path === undefined || rest.length > 0)
          return yield* usage("Give one file, or - for stdin", "push");
        const text = yield* readText(path);
        const api = yield* withClient;
        const saved = yield* api("/api/settings/instructions", Saved, {
          method: "PUT",
          body: { text },
        });
        return yield* output(
          saved,
          text.trim() === ""
            ? `${green("✓")} Cleared the instructions`
            : `${green("✓")} Saved the instructions ${dim("· new sessions and resumes get them")}`,
        );
      }
      const zips = yield* Effect.forEach(paths, readSkill);
      const api = yield* withClient;
      const pushed = yield* Effect.forEach(zips, (zip) =>
        api("/api/skills", Skill, { method: "PUT", body: zip }),
      );
      yield* output(
        pushed,
        [
          ...pushed.map((skill) => `${green("✓")} ${skill.name} ${dim(`· ${skill.description}`)}`),
          dim("New sessions and resumes get these skills."),
        ].join("\n"),
      );
    }),
);

export const removeSkill = (api: Api, name: string) =>
  Effect.gen(function* () {
    const removed = yield* api(`/api/skills/${encodeURIComponent(name)}`, SkillRemoved, {
      method: "DELETE",
    });
    yield* output(removed, `${green("✓")} Removed skill ${removed.name}`);
  });
