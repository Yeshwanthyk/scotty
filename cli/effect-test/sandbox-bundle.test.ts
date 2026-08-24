import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import type { ScottyConfig } from "../../protocol/sandbox-config";
import { CliError } from "../src/core.ts";
import {
  createDeterministicTarGz,
  encodeUstarArchive,
  gzipDeterministic,
  validateSandboxArchive,
  type TarMember,
} from "../src/sandbox-archive.ts";
import { buildSandboxBundle } from "../src/sandbox-prepare.ts";
import { sha256Bytes } from "../src/sandbox-bundle.ts";

const encoder = new TextEncoder();

const baseConfig = (): ScottyConfig => ({
  schemaVersion: 1,
  installation: { name: "home", cloudflareAccountId: "account-1" },
  pi: {
    defaultProvider: "openai",
    defaultModel: "gpt-5.6-sol",
    defaultThinkingLevel: "medium",
  },
  plugins: [
    {
      id: "cloudflare",
      type: "compute-provider",
      enabled: true,
      source: { kind: "builtin", name: "cloudflare" },
    },
  ],
  sandboxSetup: { piExtensions: [], skills: [], sandboxTools: [] },
});

const withTempDir = <A, E, R>(
  use: (root: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "scotty-plugin-test-"))),
    use,
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  );

const writeSkill = async (root: string, name: string): Promise<void> => {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "SKILL.md"),
    `---\nname: ${name}\ndescription: test\n---\n\n# ${name}\n`,
  );
};

const fileMember = (path: string, content: string): TarMember => ({
  path,
  type: "file",
  modeClass: "regular",
  bytes: encoder.encode(content),
});

const failed = <A>(result: Result.Result<A, CliError>): CliError => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

describe("sandbox archive validation", () => {
  it("round-trips deterministic bytes and rejects path escape", () => {
    const members = [fileMember("manifest.json", '{"schemaVersion":1,"plugins":[]}\n')];
    const first = createDeterministicTarGz(members);
    const second = createDeterministicTarGz([...members].reverse());
    assert.deepStrictEqual(first.archive, second.archive);
    assert.strictEqual(first.digest, second.digest);
    const archiveDigest = sha256Bytes(first.archive);
    const validated = validateSandboxArchive(first.archive, archiveDigest);
    assert.ok(Result.isSuccess(validated));
    assert.strictEqual(
      failed(
        validateSandboxArchive(
          gzipDeterministic(encodeUstarArchive([fileMember("../secret", "x")])),
        ),
      ).code,
      "sandbox_archive_invalid",
    );
  });
});

describe("Plugin bundle preparation", () => {
  it.effect("revises the snapshot without rewriting Plugin bytes for config-only changes", () =>
    Effect.gen(function* () {
      const first = yield* buildSandboxBundle(baseConfig(), 4);
      const changed = yield* buildSandboxBundle(
        { ...baseConfig(), pi: { ...baseConfig().pi, hideThinkingBlock: true } },
        5,
      );
      assert.strictEqual(changed.pluginBundleDigest, first.pluginBundleDigest);
      assert.notStrictEqual(changed.configDigest, first.configDigest);
      assert.notStrictEqual(changed.snapshotDigest, first.snapshotDigest);
      assert.strictEqual(changed.snapshot.revision, 5);
    }),
  );

  it.effect("keeps output deterministic across Plugin declaration order", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const alpha = join(root, "alpha");
        const zeta = join(root, "zeta");
        yield* Effect.promise(() =>
          Promise.all([writeSkill(alpha, "alpha"), writeSkill(zeta, "zeta")]),
        );
        const plugins: ScottyConfig["plugins"] = [
          { id: "zeta", type: "skill", enabled: true, source: { kind: "path", path: zeta } },
          ...baseConfig().plugins,
          { id: "alpha", type: "skill", enabled: true, source: { kind: "path", path: alpha } },
        ];
        const desired: ScottyConfig = {
          ...baseConfig(),
          plugins,
          sandboxSetup: { piExtensions: [], skills: ["zeta", "alpha"], sandboxTools: [] },
        };
        const reordered: ScottyConfig = {
          ...desired,
          plugins: [...plugins].reverse(),
        };
        const first = yield* buildSandboxBundle(desired, 7);
        const second = yield* buildSandboxBundle(reordered, 7);
        assert.strictEqual(first.pluginBundleDigest, second.pluginBundleDigest);
        assert.strictEqual(first.snapshotDigest, second.snapshotDigest);
        assert.deepStrictEqual(first.archive, second.archive);
        assert.deepStrictEqual(first.snapshot.sandboxSetup.skills, ["zeta", "alpha"]);
      }),
    ),
  );

  it.effect("rejects deterministic manifest collisions", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const first = join(root, "first");
        const second = join(root, "second");
        yield* Effect.promise(() =>
          Promise.all([writeSkill(first, "shared"), writeSkill(second, "shared")]),
        );
        const result = yield* Effect.result(
          buildSandboxBundle({
            ...baseConfig(),
            plugins: [
              ...baseConfig().plugins,
              { id: "first", type: "skill", enabled: true, source: { kind: "path", path: first } },
              {
                id: "second",
                type: "skill",
                enabled: true,
                source: { kind: "path", path: second },
              },
            ],
            sandboxSetup: { piExtensions: [], skills: ["first", "second"], sandboxTools: [] },
          }),
        );
        assert.match(failed(result).message, /Skill name collision.*first.*second/u);
      }),
    ),
  );

  it.effect("validates ordered setup references and ignores disabled missing paths", () =>
    Effect.gen(function* () {
      const disabled: ScottyConfig = {
        ...baseConfig(),
        plugins: [
          ...baseConfig().plugins,
          {
            id: "offline",
            type: "skill",
            enabled: false,
            source: { kind: "path", path: "/missing/offline" },
          },
        ],
      };
      const built = yield* buildSandboxBundle(disabled);
      assert.deepStrictEqual(
        built.snapshot.plugins.map((plugin) => plugin.id),
        ["cloudflare"],
      );

      for (const invalid of [
        { ...disabled, sandboxSetup: { piExtensions: [], skills: ["offline"], sandboxTools: [] } },
        {
          ...disabled,
          sandboxSetup: { piExtensions: ["cloudflare"], skills: [], sandboxTools: [] },
        },
        { ...disabled, sandboxSetup: { piExtensions: [], skills: ["missing"], sandboxTools: [] } },
      ]) {
        const result = yield* Effect.result(buildSandboxBundle(invalid));
        assert.strictEqual(failed(result).code, "sandbox_config_invalid");
      }
    }),
  );
});
