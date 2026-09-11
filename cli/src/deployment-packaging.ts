export const DEPLOYMENT_ARCHIVE_NAME = "scotty-deployment.tar.gz" as const;
export const CONTAINER_CONTEXT_PATH = ".alchemy/scotty-container-context" as const;
export const DEPLOYMENT_EXCLUSIONS = Object.freeze(["node_modules", ".git"] as const);

export const DEPLOYMENT_PACKAGING_CATEGORIES = [
  "archive",
  "archivePublic",
  "cliSource",
  "containerRuntime",
  "containerStatic",
] as const;
export type DeploymentPackagingCategory = (typeof DEPLOYMENT_PACKAGING_CATEGORIES)[number];

const entry = (path: string, ...categories: readonly DeploymentPackagingCategory[]) =>
  Object.freeze({ path, categories: Object.freeze(categories) });

export type DeploymentPackagingEntry = ReturnType<typeof entry>;

export const DEPLOYMENT_ENTRIES = Object.freeze([
  entry("package.json", "archive", "containerStatic"),
  entry("package-lock.json", "archive", "containerStatic"),
  entry("cli/scotty.ts", "archive", "cliSource"),
  entry("cli/src", "archive", "cliSource"),
  entry("skills/scotty/SKILL.md", "archive", "containerStatic"),
  entry("skills/scotty-live-observability/SKILL.md", "archive", "containerStatic"),
  entry("infra", "archive", "cliSource"),
  entry("protocol", "archive", "cliSource"),
  entry("worker/package.json", "archive", "containerStatic"),
  entry("worker/src", "archive", "cliSource"),
  entry("worker/public", "archive", "archivePublic"),
  entry("worker/prebuilt", "archive"),
  entry("worker/container", "archive", "containerRuntime"),
  entry("scripts/apply-dependency-patches.mjs", "archive", "containerStatic"),
  entry("scripts/cloudflare-topology-data.mjs", "archive", "containerStatic"),
  entry("scripts/container-control-plane.mjs", "archive", "containerStatic"),
  entry("scripts/deploy-production.mjs", "archive", "containerStatic"),
  entry("scripts/is-direct-run.mjs", "archive", "containerStatic"),
  entry("patches/@cloudflare+sandbox+0.12.9.patch", "archive", "containerStatic"),
  entry("patches/alchemy+2.0.0-beta.76.patch", "archive", "containerStatic"),
  entry(
    "patches/@alchemy.run+cloudflare-runtime+2.0.0-beta.76.patch",
    "archive",
    "containerStatic",
  ),
]);

const project = (...categories: readonly DeploymentPackagingCategory[]) =>
  Object.freeze(
    DEPLOYMENT_ENTRIES.filter((item) =>
      categories.some((category) => item.categories.includes(category)),
    ).map((item) => item.path),
  );

export const DEPLOYMENT_INPUTS = project("archive");
export const CONTAINER_STATIC_INPUTS = project("containerStatic", "containerRuntime");
export const CONTAINER_INPUTS = project("containerStatic", "containerRuntime", "cliSource");
export const CLI_SOURCE_TREES = project("cliSource");
export const CONTAINER_RUNTIME_ASSETS = project("containerRuntime");
export const ARCHIVE_PUBLIC_ASSETS = project("archivePublic");

export const DEPLOYMENT_PACKAGING = Object.freeze({
  archiveName: DEPLOYMENT_ARCHIVE_NAME,
  contextPath: CONTAINER_CONTEXT_PATH,
  exclusions: DEPLOYMENT_EXCLUSIONS,
  entries: DEPLOYMENT_ENTRIES,
  archiveInputs: DEPLOYMENT_INPUTS,
  containerStaticInputs: CONTAINER_STATIC_INPUTS,
  containerInputs: CONTAINER_INPUTS,
  containerRuntimeAssets: CONTAINER_RUNTIME_ASSETS,
  archivePublicAssets: ARCHIVE_PUBLIC_ASSETS,
  cliSourceTrees: CLI_SOURCE_TREES,
});

// Discover all build roots, including both native Codex entries and their Effect graphs.
export const CONTAINER_BUILD_ENTRYPOINTS = Object.freeze([
  "cli/scotty.ts",
  "worker/src/agent/codex/main.ts",
  "worker/src/agent/codex/server.ts",
  "worker/src/sandbox/skill-commands.ts",
] as const);

export const CONTAINER_CONTEXT_BUDGET = Object.freeze({
  maxFiles: 2_000,
  maxBytes: 40 * 1024 * 1024,
} as const);

export const CONTAINER_IMAGE_BUDGET = Object.freeze({
  // Baseline 2026-09-11: 3,119,833,948 bytes for the final local linux/amd64 rootfs.
  // Equivalent-source CI classic-store and local containerd-store builds reported
  // 3,114,170,001 and 1,159,166,713 bytes through inspect; identical digests were not
  // established, so the gate measures visible content in-container.
  // Store distinction: https://docs.docker.com/engine/storage/containerd/
  baselineBytes: 3_119_833_948,
  maxBytes: 3_250 * 1024 * 1024,
  metric: "visible root filesystem apparent size (du -sbx /)",
} as const);

export const isDeploymentArchiveFileName = (value: string): boolean =>
  value === DEPLOYMENT_ARCHIVE_NAME ||
  /^scotty-deployment(?:-[a-z0-9]+)?\.tar(?:-[a-z0-9]+)?\.gz$/u.test(value);

export const normalizeProjectPath = (source: string): string => source.replaceAll("\\", "/");

export const isSafeProjectPath = (source: string): boolean => {
  const normalized = normalizeProjectPath(source);
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
};

export const isExcludedProjectPath = (source: string): boolean =>
  normalizeProjectPath(source)
    .split("/")
    .some((segment) => DEPLOYMENT_EXCLUSIONS.some((exclusion) => exclusion === segment));

export const isIncludedProjectPath = (source: string): boolean => !isExcludedProjectPath(source);

export const coversProjectPath = (input: string, source: string): boolean => {
  const normalizedInput = normalizeProjectPath(input);
  const normalizedSource = normalizeProjectPath(source);
  return normalizedSource === normalizedInput || normalizedSource.startsWith(`${normalizedInput}/`);
};

export const isCoveredByProjectInputs = (source: string, inputs: readonly string[]): boolean =>
  inputs.some((input) => coversProjectPath(input, source));

export const projectContainerContextInputs = (cliInputs: readonly string[]): readonly string[] =>
  Object.freeze([
    ...CONTAINER_STATIC_INPUTS,
    ...cliInputs.filter((source) => !isCoveredByProjectInputs(source, CONTAINER_STATIC_INPUTS)),
  ]);
