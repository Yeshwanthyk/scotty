import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  decodeSandboxConfigText,
  encodeSandboxConfigJson,
  emptySandboxConfig,
} from "../src/sandbox-config.ts";
import { parseSkillFrontmatterName } from "../src/sandbox-sources.ts";

describe("sandbox configuration schema", () => {
  it("encodes the empty v1 document", () => {
    expect(JSON.parse(encodeSandboxConfigJson(emptySandboxConfig()))).toEqual({
      schemaVersion: 1,
      skills: [],
      piPackages: [],
    });
  });

  it("rejects excess properties and invalid commits", () => {
    expect(
      Result.isFailure(
        decodeSandboxConfigText('{"schemaVersion":1,"skills":[],"piPackages":[],"extra":true}'),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decodeSandboxConfigText(
          JSON.stringify({
            schemaVersion: 1,
            skills: [],
            piPackages: [
              {
                name: "pi-review-tools",
                repository: "https://github.com/acme/pi-review-tools.git",
                commit: "main",
                requestedRef: "main",
              },
            ],
          }),
        ),
      ),
    ).toBe(true);
  });

  it("sorts entries by name", () => {
    expect(
      decodeSandboxConfigText(
        JSON.stringify({
          schemaVersion: 1,
          skills: [
            { name: "zeta", path: "/tmp/zeta" },
            { name: "alpha", path: "/tmp/alpha" },
          ],
          piPackages: [],
        }),
      ),
    ).toEqual(
      Result.succeed({
        schemaVersion: 1,
        skills: [
          { name: "alpha", path: "/tmp/alpha" },
          { name: "zeta", path: "/tmp/zeta" },
        ],
        piPackages: [],
      }),
    );
  });
});

describe("skill frontmatter", () => {
  it("reads a quoted or bare name", () => {
    expect(parseSkillFrontmatterName("---\nname: release-notes\n---\n\n# Skill\n")).toEqual(
      Result.succeed("release-notes"),
    );
    expect(parseSkillFrontmatterName('---\nname: "release-notes"\n---\n\n# Skill\n')).toEqual(
      Result.succeed("release-notes"),
    );
    expect(Result.isFailure(parseSkillFrontmatterName("# no frontmatter\n"))).toBe(true);
  });
});
