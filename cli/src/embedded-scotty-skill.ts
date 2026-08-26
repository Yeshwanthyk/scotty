import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import embeddedSkillPath from "../../skills/scotty/SKILL.md" with { type: "file" };
import { CliError, EXIT } from "./core";

const embeddedSkill = (): Blob | undefined =>
  typeof Bun === "undefined"
    ? undefined
    : Bun.embeddedFiles.find((file) => {
        const name = Reflect.get(file, "name");
        return typeof name === "string" && /^SKILL(?:-[a-z0-9]+)?\.md$/u.test(name);
      });

export const loadEmbeddedScottySkill = Effect.fnUntraced(function* () {
  return yield* Effect.tryPromise({
    try: () => {
      const file = embeddedSkill();
      if (file !== undefined) return file.text();
      const sourcePath = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../..",
        "skills",
        "scotty",
        "SKILL.md",
      );
      void embeddedSkillPath;
      return readFile(sourcePath, "utf8");
    },
    catch: () =>
      new CliError(
        "embedded_skill_unavailable",
        "The embedded Scotty skill is unavailable",
        "Rebuild the Scotty CLI and retry.",
        EXIT.GENERIC,
      ),
  });
});
