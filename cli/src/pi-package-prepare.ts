import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { Effect } from "effect";
import { sandboxPackageUnsupported } from "./sandbox-bundle";

export const PI_PACKAGE_NPM_CI_ARGS = [
  "npm",
  "ci",
  "--omit=dev",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--legacy-peer-deps",
  "--os=linux",
  "--cpu=x64",
] as const;

export type PiPackageDependencyInstaller = (
  root: string,
) => Effect.Effect<void, ReturnType<typeof sandboxPackageUnsupported>>;

const isLocalPackageArtifact = (source: string, candidate: string): boolean => {
  const path = relative(source, candidate);
  if (path.length === 0) return false;
  return path.split(sep).some((part) => part === ".git" || part === "node_modules");
};

const runNpmCi = async (root: string): Promise<number> => {
  const child = Bun.spawn([...PI_PACKAGE_NPM_CI_ARGS], {
    cwd: root,
    stdout: "ignore",
    stderr: "ignore",
  });
  return child.exited;
};

export const installPiPackageDependencies: PiPackageDependencyInstaller = Effect.fnUntraced(
  function* (root: string) {
    const exitCode = yield* Effect.tryPromise({
      try: () => runNpmCi(root),
      catch: () =>
        sandboxPackageUnsupported(
          "Could not start the Pi package dependency install",
          `Check that npm is installed, then retry ${root}.`,
        ),
    });
    if (exitCode !== 0)
      return yield* sandboxPackageUnsupported(
        "Could not install Pi package production dependencies",
        `Check package.json and package-lock.json in ${root}, then retry.`,
      );
  },
);

export const usePreparedPiPackage = <A, E, R>(
  source: string,
  needsInstall: boolean,
  install: PiPackageDependencyInstaller,
  use: (root: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ReturnType<typeof sandboxPackageUnsupported>, R> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "scotty-pi-package-")),
      catch: () =>
        sandboxPackageUnsupported(
          "Could not create a temporary Pi package directory",
          `Checked ${source}.`,
        ),
    }),
    (temporary) => {
      const prepared = join(temporary, "package");
      return Effect.tryPromise({
        try: () =>
          cp(source, prepared, {
            recursive: true,
            filter: (candidate) => !isLocalPackageArtifact(source, candidate),
          }),
        catch: () =>
          sandboxPackageUnsupported("Could not prepare the local Pi package", `Checked ${source}.`),
      }).pipe(
        Effect.andThen(needsInstall ? install(prepared) : Effect.void),
        Effect.andThen(use(prepared)),
      );
    },
    (temporary) =>
      Effect.tryPromise({
        try: () => rm(temporary, { recursive: true, force: true }),
        catch: () =>
          sandboxPackageUnsupported(
            "Could not clean up the temporary Pi package directory",
            `Remove ${temporary} after checking local disk space, then retry.`,
          ),
      }),
  );
