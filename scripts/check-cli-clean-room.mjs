import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CLEAN_ROOM_CLI_PLATFORM = "linux/amd64";
export const CLEAN_ROOM_RUNTIME_ARTIFACT = "dist/clean-room/scotty-runtime-linux-amd64";

const readSandboxBaseImage = (root) => {
  const dockerfile = readFileSync(resolve(root, "worker/container/Dockerfile"), "utf8");
  const match =
    /^FROM (docker\.io\/cloudflare\/sandbox:[^\s]+) AS scotty-codex-server-build$/mu.exec(
      dockerfile,
    );
  if (match?.[1] === undefined) throw new Error("Pinned Sandbox base image was not found.");
  return match[1];
};

export const cleanRoomCliPlan = (root = process.cwd()) => {
  const artifact = resolve(root, CLEAN_ROOM_RUNTIME_ARTIFACT);
  const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  return {
    root,
    platform: CLEAN_ROOM_CLI_PLATFORM,
    baseImage: readSandboxBaseImage(root),
    artifact,
    version,
  };
};

export const cleanRoomBuildArgs = (plan) => ["scripts/build-runtime-cli.mjs", plan.artifact];

export const cleanRoomVerifyArgs = (plan) => [
  "run",
  "--rm",
  "--platform",
  plan.platform,
  "--network=none",
  "--volume",
  `${plan.artifact}:/tmp/scotty-runtime:ro`,
  "--entrypoint",
  "sh",
  plan.baseImage,
  "-c",
  [
    "set -eu",
    "test ! -e /usr/local/bin/scotty",
    "test -x /tmp/scotty-runtime",
    `test "$(/tmp/scotty-runtime --version)" = ${JSON.stringify(plan.version)}`,
    '/tmp/scotty-runtime --build-info | node --input-type=module -e \'import assert from "node:assert/strict"; let input=""; for await (const chunk of process.stdin) input += chunk; const info=JSON.parse(input); assert.equal(info.version, ' +
      `${JSON.stringify(plan.version)}); assert.equal(info.embeddedDeployment, false)'`,
  ].join(" && "),
];

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? "null"}`);
  }
};

export const checkCliCleanRoom = ({ root = process.cwd(), build = run, docker = run } = {}) => {
  const plan = cleanRoomCliPlan(root);
  rmSync(plan.artifact, { force: true });
  build("bun", cleanRoomBuildArgs(plan), { cwd: root });
  docker("docker", cleanRoomVerifyArgs(plan));
  return plan;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  checkCliCleanRoom();
}
