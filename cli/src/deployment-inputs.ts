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
  "worker/package.json",
  "worker/src",
  "worker/public",
  "worker/container",
] as const;

export const CONTAINER_INPUTS = [
  "package.json",
  "package-lock.json",
  "cli/scotty.ts",
  "cli/src",
  "infra",
  "protocol",
  "worker/package.json",
  "worker/src",
  "worker/container",
] as const;
