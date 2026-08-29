import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CONTAINER_CONTEXT_PATH,
  prepareContainerContext,
} from "../cli/src/deployment-packaging.mjs";

export const CLEAN_ROOM_CLI_IMAGE = "scotty-cli-build:clean-room";
export const CLEAN_ROOM_CLI_PLATFORM = "linux/amd64";
export const CLEAN_ROOM_CLI_TARGET = "scotty-cli-build";
export const CLEAN_ROOM_CLI_VERIFY = Object.freeze(["--version"]);
export const CLEAN_ROOM_CACHE_SCOPE = "scotty-cli-build";

export const cleanRoomCliPlan = (root = process.cwd(), environment = process.env) => {
  const context = resolve(root, CONTAINER_CONTEXT_PATH);
  const useGhaCache =
    environment.GITHUB_ACTIONS === "true" && typeof environment.ACTIONS_CACHE_URL === "string";
  return {
    context,
    dockerfile: resolve(context, "worker/container/Dockerfile"),
    platform: CLEAN_ROOM_CLI_PLATFORM,
    target: CLEAN_ROOM_CLI_TARGET,
    image: CLEAN_ROOM_CLI_IMAGE,
    verifyEntrypoint: "/out/scotty",
    verifyArgs: CLEAN_ROOM_CLI_VERIFY,
    cache: useGhaCache
      ? {
          from: `type=gha,scope=${CLEAN_ROOM_CACHE_SCOPE}`,
          to: `type=gha,mode=max,scope=${CLEAN_ROOM_CACHE_SCOPE},ignore-error=true`,
        }
      : undefined,
  };
};

export const cleanRoomBuildArgs = (plan) => [
  "buildx",
  "build",
  "--platform",
  plan.platform,
  "--target",
  plan.target,
  "--load",
  "-t",
  plan.image,
  "-f",
  plan.dockerfile,
  ...(plan.cache === undefined
    ? []
    : ["--cache-from", plan.cache.from, "--cache-to", plan.cache.to]),
  plan.context,
];

export const cleanRoomVerifyArgs = (plan) => [
  "run",
  "--rm",
  "--platform",
  plan.platform,
  "--entrypoint",
  plan.verifyEntrypoint,
  plan.image,
  ...plan.verifyArgs,
];

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? "null"}`);
  }
};

export const checkCliCleanRoom = async ({
  root = process.cwd(),
  environment = process.env,
  prepare = prepareContainerContext,
  docker = run,
} = {}) => {
  const plan = cleanRoomCliPlan(root, environment);
  await prepare(root);
  docker("docker", cleanRoomBuildArgs(plan));
  docker("docker", cleanRoomVerifyArgs(plan));
  return plan;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await checkCliCleanRoom();
}
