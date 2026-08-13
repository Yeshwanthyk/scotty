export const DEPLOYMENT_ARCHIVE_NAME = "scotty-deployment.tar.gz";

export const isDeploymentArchiveFileName = (value: string): boolean =>
  value === DEPLOYMENT_ARCHIVE_NAME ||
  /^scotty-deployment(?:-[a-z0-9]+)?\.tar(?:-[a-z0-9]+)?\.gz$/u.test(value);

export const DEPLOYMENT_INPUTS = [
  "package.json",
  "package-lock.json",
  "cli/scotty.ts",
  "cli/src",
  "infra",
  "protocol",
  "tui/package.json",
  "tui/src",
  "worker/package.json",
  "worker/src",
  "worker/public",
  "worker/container",
  "scripts/apply-dependency-patches.mjs",
  "patches/alchemy+2.0.0-beta.67.patch",
  "patches/earendil-works+pi-coding-agent+0.84.0.patch",
] as const;

export const CONTAINER_INPUTS = [
  "package.json",
  "package-lock.json",
  "cli/scotty.ts",
  "cli/src",
  "infra",
  "protocol",
  "tui/package.json",
  "tui/src",
  "worker/package.json",
  "worker/src",
  "worker/container",
  "scripts/apply-dependency-patches.mjs",
  "patches/alchemy+2.0.0-beta.67.patch",
  "patches/earendil-works+pi-coding-agent+0.84.0.patch",
] as const;
