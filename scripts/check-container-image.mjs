import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CONTAINER_CONTEXT_PATH,
  inspectContainerImageBudget,
  prepareContainerContext,
} from "../cli/src/deployment-packaging.mjs";
import { CLEAN_ROOM_CACHE_SCOPE, CLEAN_ROOM_CLI_PLATFORM } from "./check-cli-clean-room.mjs";

export const CONTAINER_IMAGE = "scotty-container:ci";
export const CONTAINER_IMAGE_PLATFORM = CLEAN_ROOM_CLI_PLATFORM;
export const CONTAINER_IMAGE_CACHE_SCOPE = "scotty-container-image";
export const CONTAINER_IMAGE_ABSENT_COMMANDS = Object.freeze(["codex"]);
export const CONTAINER_IMAGE_PI_PACKAGES = Object.freeze(["pi-subagents"]);
export const CONTAINER_IMAGE_ABSENT_PI_PACKAGES = Object.freeze(["pi-tasks"]);

const ghaCacheEnabled = (environment) =>
  environment.GITHUB_ACTIONS === "true" && typeof environment.ACTIONS_CACHE_URL === "string";

export const containerImagePlan = (root = process.cwd(), environment = process.env) => {
  const context = resolve(root, CONTAINER_CONTEXT_PATH);
  return {
    context,
    dockerfile: resolve(context, "worker/container/Dockerfile"),
    platform: CONTAINER_IMAGE_PLATFORM,
    image: CONTAINER_IMAGE,
    cache: ghaCacheEnabled(environment)
      ? {
          from: [
            `type=gha,scope=${CONTAINER_IMAGE_CACHE_SCOPE}`,
            `type=gha,scope=${CLEAN_ROOM_CACHE_SCOPE}`,
          ],
          to: `type=gha,mode=max,scope=${CONTAINER_IMAGE_CACHE_SCOPE},ignore-error=true`,
        }
      : undefined,
  };
};

const cacheArgs = (cache) => {
  if (cache === undefined) return [];
  return [...cache.from.flatMap((from) => ["--cache-from", from]), "--cache-to", cache.to];
};

export const containerImageBuildArgs = (plan) => [
  "buildx",
  "build",
  "--platform",
  plan.platform,
  "--load",
  "-t",
  plan.image,
  "-f",
  plan.dockerfile,
  ...cacheArgs(plan.cache),
  plan.context,
];

export const containerImageRunArgs = (plan, entrypoint, args, extra = []) => [
  "run",
  "--rm",
  "--platform",
  plan.platform,
  ...extra,
  "--entrypoint",
  entrypoint,
  plan.image,
  ...args,
];

export const containerImagePiVersionArgs = (plan) =>
  containerImageRunArgs(plan, "pi", ["--version"]);
const absentPiPackageListAssertion = (name) =>
  `if grep -F -- ${JSON.stringify(name)} /tmp/scotty-pi-packages.list >/dev/null; then echo "unexpected ${name}" >&2; exit 1; else grep_status=$?; test "$grep_status" -eq 1; fi`;

export const containerImagePiPackagesSmokeArgs = (plan) =>
  containerImageRunArgs(plan, "sh", [
    "-c",
    [
      "set -eu",
      "mkdir -p /tmp/scotty-pi-agent",
      "cp /opt/scotty/pi-packages/settings.json /tmp/scotty-pi-agent/settings.json",
      "PI_CODING_AGENT_DIR=/tmp/scotty-pi-agent PI_OFFLINE=1 pi list >/tmp/scotty-pi-packages.list",
      ...CONTAINER_IMAGE_ABSENT_PI_PACKAGES.map(absentPiPackageListAssertion),
      ...CONTAINER_IMAGE_ABSENT_PI_PACKAGES.map(
        (name) => `test ! -e ${JSON.stringify(`/opt/scotty/pi-packages/sources/${name}`)}`,
      ),
      ...CONTAINER_IMAGE_PI_PACKAGES.map(
        (name) => `grep -F ${JSON.stringify(name)} /tmp/scotty-pi-packages.list >/dev/null`,
      ),
      "test ! -d /tmp/scotty-pi-agent/git",
    ].join(" && "),
  ]);

export const containerImageAbsentToolchainArgs = (plan) =>
  containerImageRunArgs(plan, "sh", [
    "-c",
    `set -eu; for command_name in ${CONTAINER_IMAGE_ABSENT_COMMANDS.join(" ")}; do if command -v "\${command_name}" >/dev/null; then echo "unexpected \${command_name}" >&2; exit 1; fi; done`,
  ]);

export const containerImageInspectArgs = (plan) => [
  "image",
  "inspect",
  plan.image,
  "--format",
  "{{.Size}}",
];

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? "null"}`);
  }
};

const capture = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status ?? "null"}: ${result.stderr}`,
    );
  }
  return { stdout: result.stdout };
};

export const checkContainerImage = async ({
  root = process.cwd(),
  environment = process.env,
  prepare = prepareContainerContext,
  docker = run,
  inspect = inspectContainerImageBudget,
} = {}) => {
  const plan = containerImagePlan(root, environment);
  await prepare(root);
  docker("docker", containerImageBuildArgs(plan));
  docker("docker", containerImagePiVersionArgs(plan));
  docker("docker", containerImagePiPackagesSmokeArgs(plan));
  docker("docker", containerImageAbsentToolchainArgs(plan));
  await inspect(plan.image, {
    exec: async (_command, args) => capture("docker", args),
    inspectArgs: containerImageInspectArgs(plan),
  });
  return plan;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await checkContainerImage();
}
