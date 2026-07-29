export const DEPLOYMENT_INPUTS = [
  "package.json",
  "package-lock.json",
  "cli/scotty.ts",
  "cli/src",
  "cli/skills",
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
  "cli/skills",
  "protocol",
  "worker/package.json",
  "worker/container",
] as const;
