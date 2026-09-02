import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import embeddedLiveObservabilitySkillPath from "../../skills/scotty-live-observability/SKILL.md" with { type: "file" };
import embeddedScottySkillPath from "../../skills/scotty/SKILL.md" with { type: "file" };
import { CliError, EXIT } from "./core";

export const EMBEDDED_SCOTTY_SKILL_NAMES = ["scotty", "scotty-live-observability"] as const;
export type EmbeddedScottySkillName = (typeof EMBEDDED_SCOTTY_SKILL_NAMES)[number];

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const embeddedSkills = {
  scotty: {
    embeddedPath: embeddedScottySkillPath,
    sourcePath: resolve(sourceRoot, "skills", "scotty", "SKILL.md"),
  },
  "scotty-live-observability": {
    embeddedPath: embeddedLiveObservabilitySkillPath,
    sourcePath: resolve(sourceRoot, "skills", "scotty-live-observability", "SKILL.md"),
  },
} as const satisfies Record<EmbeddedScottySkillName, { embeddedPath: string; sourcePath: string }>;

export const loadEmbeddedScottySkill = Effect.fnUntraced(function* (
  name: EmbeddedScottySkillName = "scotty",
) {
  const source = embeddedSkills[name];
  return yield* Effect.tryPromise({
    try: () =>
      readFile(typeof Bun === "undefined" ? source.sourcePath : source.embeddedPath, "utf8"),
    catch: () =>
      new CliError(
        "embedded_skill_unavailable",
        `The embedded ${name} skill is unavailable`,
        "Rebuild the Scotty CLI and retry.",
        EXIT.GENERIC,
      ),
  });
});
