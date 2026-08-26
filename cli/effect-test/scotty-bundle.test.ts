import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { CliError } from "../src/core";
import {
  gunzipSandboxArchive,
  parseSandboxTar,
  validateSandboxArchive,
} from "../src/sandbox-archive";
import { buildScottyTomlBundle, bundleItemSummaries } from "../src/scotty-bundle";
import { isSensitiveBundlePath } from "../src/sandbox-bundle";
import { PI_PACKAGE_NPM_CI_ARGS } from "../src/pi-package-prepare";
import type { LoadedScottyTomlConfig } from "../src/scotty-config";

const withTempDirectory = <A, E, R>(
  use: (path: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.scoped(
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "scotty-toml-bundle-test-"))),
      use,
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    ),
  );

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert.ok(Result.isSuccess(result));
  return result.success;
};

const fixture = Effect.fnUntraced(function* (root: string) {
  const skills = join(root, "skills");
  const localPackage = join(root, "packages", "codex-compaction");
  const tools = join(root, "tools");
  const extensions = join(root, "extensions");
  yield* Effect.promise(() => mkdir(join(skills, "release-notes"), { recursive: true }));
  yield* Effect.promise(() => mkdir(join(extensions, "review"), { recursive: true }));
  yield* Effect.promise(() =>
    mkdir(join(localPackage, "node_modules", "local-development-only"), { recursive: true }),
  );
  yield* Effect.promise(() => mkdir(join(localPackage, ".git"), { recursive: true }));
  yield* Effect.promise(() => writeFile(join(localPackage, ".git", "config"), "local-only\n"));
  yield* Effect.promise(() => mkdir(tools, { recursive: true }));
  yield* Effect.promise(() =>
    writeFile(
      join(skills, "release-notes", "SKILL.md"),
      "---\nname: release-notes\ndescription: Test\n---\n\n# Release notes\n",
    ),
  );
  const tool = join(tools, "hello");
  yield* Effect.promise(() => writeFile(tool, "#!/bin/sh\necho hello\n"));
  yield* Effect.promise(() => chmod(tool, 0o755));
  yield* Effect.promise(() =>
    writeFile(join(extensions, "review", "index.ts"), "export default () => {}\n"),
  );
  yield* Effect.promise(() =>
    writeFile(
      join(localPackage, "package.json"),
      `${JSON.stringify({
        name: "@ogulcancelik/pi-codex-compaction",
        scripts: { install: "touch install-hook-ran" },
        dependencies: { "runtime-dependency": "1.0.0" },
        pi: { extensions: ["./index.ts"] },
      })}\n`,
    ),
  );
  yield* Effect.promise(() =>
    writeFile(
      join(localPackage, "package-lock.json"),
      `${JSON.stringify({
        name: "@ogulcancelik/pi-codex-compaction",
        version: "0.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "@ogulcancelik/pi-codex-compaction",
            version: "0.0.0",
            dependencies: { "runtime-dependency": "1.0.0" },
          },
        },
      })}\n`,
    ),
  );
  yield* Effect.promise(() =>
    writeFile(join(localPackage, "index.ts"), "export default () => {}\n"),
  );
  yield* Effect.promise(() =>
    writeFile(
      join(localPackage, "node_modules", "local-development-only", "index.js"),
      "export {};\n",
    ),
  );
  return {
    loaded: {
      path: join(root, "scotty.toml"),
      config: {
        version: 1,
        sync: {
          skills: [skills],
          packages: [localPackage],
          tools: [tools],
          extensions: [extensions],
        },
        repos: { allowed: [] },
      },
      resolvedRoots: {
        skills: [skills],
        packages: [localPackage],
        tools: [tools],
        extensions: [extensions],
      },
    } satisfies LoadedScottyTomlConfig,
    localPackage,
    extension: join(extensions, "review", "index.ts"),
  };
});

const installFixturePackageDependencies = Effect.fnUntraced(function* (root: string) {
  const dependency = join(root, "node_modules", "runtime-dependency");
  yield* Effect.promise(() => mkdir(dependency, { recursive: true }));
  yield* Effect.promise(() => writeFile(join(dependency, "index.js"), "export {};\n"));
});

const buildFixtureBundle = (loaded: LoadedScottyTomlConfig) =>
  buildScottyTomlBundle(loaded, {
    installPackageDependencies: installFixturePackageDependencies,
  });

describe("TOML bundle preparation", () => {
  it("uses the locked Linux production npm command without hooks", () => {
    assert.deepStrictEqual(PI_PACKAGE_NPM_CI_ARGS, [
      "npm",
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--legacy-peer-deps",
      "--os=linux",
      "--cpu=x64",
    ]);
  });

  it.effect("copies packages into a prepared tree and keeps the archive deterministic", () =>
    withTempDirectory((root) =>
      Effect.gen(function* () {
        const { loaded, localPackage, extension } = yield* fixture(root);
        const sourcePackageJson = yield* Effect.promise(() =>
          readFile(join(localPackage, "package.json"), "utf8"),
        );
        const sourceNodeModule = join(
          localPackage,
          "node_modules",
          "local-development-only",
          "index.js",
        );
        const sourceNodeModuleContent = yield* Effect.promise(() =>
          readFile(sourceNodeModule, "utf8"),
        );
        const first = yield* buildFixtureBundle(loaded);
        const second = yield* buildFixtureBundle(loaded);
        assert.strictEqual(first.digest, second.digest);
        assert.deepStrictEqual(bundleItemSummaries(first.manifest), [
          { kind: "extension", name: "review" },
          { kind: "package", name: "@ogulcancelik/pi-codex-compaction" },
          { kind: "skill", name: "release-notes" },
          { kind: "tool", name: "hello" },
        ]);
        assert.strictEqual(first.manifest.schemaVersion, 2);
        assert.strictEqual(Result.isSuccess(validateSandboxArchive(first.archive)), true);
        const packageItem = first.manifest.items.find((item) => item.kind === "package");
        assert.ok(packageItem !== undefined);
        assert.ok(
          packageItem.files.some(
            (file) => file.path === "node_modules/runtime-dependency/index.js",
          ),
        );
        assert.ok(
          packageItem.files.every(
            (file) => file.path !== "node_modules/local-development-only/index.js",
          ),
        );
        assert.ok(packageItem.files.every((file) => !file.path.startsWith(".git/")));
        assert.ok(packageItem.files.some((file) => file.path === "package.json"));
        assert.ok(packageItem.files.every((file) => file.path !== "install-hook-ran"));
        assert.strictEqual(
          yield* Effect.promise(() => readFile(join(localPackage, "package.json"), "utf8")),
          sourcePackageJson,
        );
        assert.strictEqual(
          yield* Effect.promise(() => readFile(sourceNodeModule, "utf8")),
          sourceNodeModuleContent,
        );
        const members = success(parseSandboxTar(success(gunzipSandboxArchive(first.archive))));
        const packageJson = members.find(
          (member) => member.path === "pi-packages/@ogulcancelik/pi-codex-compaction/package.json",
        );
        assert.ok(packageJson !== undefined);
        assert.strictEqual(new TextDecoder().decode(packageJson.bytes), sourcePackageJson);

        yield* Effect.promise(() => writeFile(extension, "export default () => { }\n"));
        const changed = yield* buildFixtureBundle(loaded);
        assert.notStrictEqual(changed.digest, first.digest);
      }),
    ),
  );

  it.effect("does not require a lockfile or install when runtime dependencies are absent", () =>
    withTempDirectory((root) =>
      Effect.gen(function* () {
        const { loaded, localPackage } = yield* fixture(root);
        const packageJson = `${JSON.stringify({
          name: "@ogulcancelik/pi-codex-compaction",
          scripts: { install: "touch install-hook-ran" },
          pi: { extensions: ["./index.ts"] },
        })}\n`;
        yield* Effect.promise(() => writeFile(join(localPackage, "package.json"), packageJson));
        yield* Effect.promise(() => rm(join(localPackage, "package-lock.json")));
        let installs = 0;
        const built = yield* buildScottyTomlBundle(loaded, {
          installPackageDependencies: () =>
            Effect.sync(() => {
              installs += 1;
            }),
        });
        assert.strictEqual(installs, 0);
        const packageItem = built.manifest.items.find((item) => item.kind === "package");
        assert.ok(packageItem !== undefined);
        assert.ok(packageItem.files.some((file) => file.path === "package.json"));
        assert.ok(
          packageItem.files.every(
            (file) => !file.path.startsWith("node_modules/local-development-only/"),
          ),
        );
        assert.strictEqual(
          yield* Effect.promise(() => readFile(join(localPackage, "package.json"), "utf8")),
          packageJson,
        );
      }),
    ),
  );

  it.effect("reports a typed useful dependency install failure", () =>
    withTempDirectory((root) =>
      Effect.gen(function* () {
        const { loaded } = yield* fixture(root);
        let preparedRoot: string | undefined;
        const result = yield* Effect.result(
          buildScottyTomlBundle(loaded, {
            installPackageDependencies: (directory) => {
              preparedRoot = directory;
              return Effect.fail(
                new CliError(
                  "sandbox_package_unsupported",
                  "Could not install Pi package production dependencies",
                  "Check the package lock, then retry.",
                  2,
                ),
              );
            },
          }),
        );
        assert.ok(Result.isFailure(result));
        assert.instanceOf(result.failure, CliError);
        assert.strictEqual(result.failure.code, "sandbox_package_unsupported");
        assert.include(result.failure.message, "production dependencies");
        assert.ok(preparedRoot !== undefined);
        const staged = yield* Effect.result(
          Effect.tryPromise({
            try: () => stat(preparedRoot),
            catch: () => undefined,
          }),
        );
        assert.ok(Result.isFailure(staged));
      }),
    ),
  );

  it.effect("requires package.json Pi metadata before preparing a package", () =>
    withTempDirectory((root) =>
      Effect.gen(function* () {
        const { loaded, localPackage } = yield* fixture(root);
        yield* Effect.promise(() =>
          writeFile(
            join(localPackage, "package.json"),
            `${JSON.stringify({ name: "pi-subagents", scripts: { install: "touch install-hook-ran" } })}\n`,
          ),
        );
        const result = yield* Effect.result(buildScottyTomlBundle(loaded));
        assert.ok(Result.isFailure(result));
        assert.include(result.failure.message, "Pi package metadata");
        const hookMarker = yield* Effect.result(
          Effect.tryPromise({
            try: () => readFile(join(localPackage, "install-hook-ran")),
            catch: () => undefined,
          }),
        );
        assert.ok(Result.isFailure(hookMarker));
      }),
    ),
  );

  it.effect("rejects path-based sensitive names without scanning source content", () =>
    withTempDirectory((root) =>
      Effect.gen(function* () {
        for (const name of [
          "auth.json",
          "credentials.json",
          ".npmrc",
          ".env",
          ".env.local",
          "service.env",
          "id_ed25519",
          "private.key",
          "server.pem",
          ".bash_history",
          "run.log",
        ])
          assert.strictEqual(isSensitiveBundlePath(`nested/${name}`), true);
        assert.strictEqual(isSensitiveBundlePath("nested/ordinary.ts"), false);

        const { loaded } = yield* fixture(root);
        const ordinary = join(loaded.resolvedRoots.tools[0]!, "ordinary.ts");
        yield* Effect.promise(() => writeFile(ordinary, "token = 'not a path rule'\n"));
        const safe = yield* buildFixtureBundle(loaded);
        assert.strictEqual(safe.manifest.schemaVersion, 2);
        yield* Effect.promise(() => rm(ordinary));
        yield* Effect.promise(() =>
          writeFile(join(loaded.resolvedRoots.tools[0]!, ".env.local"), "not a secret"),
        );
        const result = yield* Effect.result(buildFixtureBundle(loaded));
        assert.ok(Result.isFailure(result));
        assert.instanceOf(result.failure, CliError);
        assert.strictEqual(result.failure.code, "sandbox_source_invalid");
      }),
    ),
  );
});
