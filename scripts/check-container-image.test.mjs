import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CONTAINER_CONTEXT_PATH, CONTAINER_IMAGE_BUDGET } from "../cli/src/deployment-packaging.ts";
import { CLEAN_ROOM_CACHE_SCOPE, CLEAN_ROOM_CLI_TARGET } from "./check-cli-clean-room.mjs";
import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_ABSENT_COMMANDS,
  CONTAINER_IMAGE_ABSENT_PI_PACKAGES,
  CONTAINER_IMAGE_CACHE_SCOPE,
  CONTAINER_IMAGE_PI_PACKAGES,
  CONTAINER_IMAGE_PLATFORM,
  checkContainerImage,
  containerImageAbsentToolchainArgs,
  containerImageBuildArgs,
  containerImageInspectArgs,
  containerImagePiPackagesSmokeArgs,
  containerImagePiVersionArgs,
  containerImagePlan,
} from "./check-container-image.mjs";

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

describe("final container image gate", () => {
  it("builds and loads the final linux/amd64 image, then smokes Pi packages and inspects Size", async () => {
    const prepared = [];
    const dockerCalls = [];
    const inspected = [];
    const plan = await checkContainerImage({
      root: "/repo",
      environment: {},
      prepare: async (root) => {
        prepared.push(root);
      },
      docker: (command, args) => {
        dockerCalls.push({ command, args });
      },
      inspect: async (image, options) => {
        inspected.push({ image, options });
        return 1_038_798_880;
      },
    });

    assert.deepEqual(prepared, ["/repo"]);
    assert.equal(plan.context, `/repo/${CONTAINER_CONTEXT_PATH}`);
    assert.equal(plan.dockerfile, `/repo/${CONTAINER_CONTEXT_PATH}/worker/container/Dockerfile`);
    assert.equal(plan.platform, CONTAINER_IMAGE_PLATFORM);
    assert.equal(plan.image, CONTAINER_IMAGE);
    assert.equal(plan.target, undefined);
    assert.equal(plan.cache, undefined);
    assert.deepEqual(CONTAINER_IMAGE_PI_PACKAGES, [
      "pi-subagents",
      "@ogulcancelik/pi-codex-compaction",
      "scotty-browser-test",
      "scotty-hatch",
    ]);
    assert.deepEqual(CONTAINER_IMAGE_ABSENT_PI_PACKAGES, [
      "pi-tasks",
      "pi-workflows",
      "pi-background-terminals",
      "pi-askuser",
      "pi-web-access",
      "pi-amp-ui",
    ]);
    assert.deepEqual(dockerCalls, [
      { command: "docker", args: containerImageBuildArgs(plan) },
      { command: "docker", args: containerImagePiVersionArgs(plan) },
      { command: "docker", args: containerImagePiPackagesSmokeArgs(plan) },
      { command: "docker", args: containerImageAbsentToolchainArgs(plan) },
    ]);
    assert.deepEqual(containerImageBuildArgs(plan), [
      "buildx",
      "build",
      "--platform",
      "linux/amd64",
      "--load",
      "-t",
      "scotty-container:ci",
      "-f",
      plan.dockerfile,
      plan.context,
    ]);
    assert.equal(containerImageBuildArgs(plan).includes("--target"), false);
    assert.notEqual(CLEAN_ROOM_CLI_TARGET, undefined);
    assert.match(containerImagePiVersionArgs(plan).join(" "), /--entrypoint pi/u);
    const piPackagesSmokeCommand = containerImagePiPackagesSmokeArgs(plan).join(" ");
    assert.match(piPackagesSmokeCommand, /pi list/u);
    for (const name of CONTAINER_IMAGE_PI_PACKAGES) {
      assert.match(piPackagesSmokeCommand, new RegExp(name, "u"));
    }
    for (const name of CONTAINER_IMAGE_ABSENT_PI_PACKAGES) {
      assert.ok(
        piPackagesSmokeCommand.includes(
          `grep -F -- ${JSON.stringify(name)} /tmp/scotty-pi-packages.list`,
        ),
      );
      assert.ok(
        piPackagesSmokeCommand.includes(
          `test ! -e ${JSON.stringify(`/opt/scotty/pi-packages/sources/${name}`)}`,
        ),
      );
    }
    const dockerfile = read("worker/container/Dockerfile");
    assert.match(
      dockerfile,
      /node \/tmp\/project-container-pi-install\.mjs --assert-image --pi-packages \/opt\/scotty\/pi-packages/u,
    );
    for (const name of CONTAINER_IMAGE_ABSENT_PI_PACKAGES) {
      assert.ok(piPackagesSmokeCommand.includes(`grep -F -- ${JSON.stringify(name)}`));
      assert.ok(
        piPackagesSmokeCommand.includes(
          `test ! -e ${JSON.stringify(`/opt/scotty/pi-packages/sources/${name}`)}`,
        ),
      );
      assert.ok(dockerfile.includes(name));
    }
    for (const name of CONTAINER_IMAGE_PI_PACKAGES) assert.ok(dockerfile.includes(name));
    assert.doesNotMatch(dockerfile, /locks\/pi-web-access\/package-lock\.json/u);
    for (const name of CONTAINER_IMAGE_ABSENT_COMMANDS) {
      assert.match(containerImageAbsentToolchainArgs(plan).join(" "), new RegExp(name, "u"));
    }
    assert.deepEqual(containerImageInspectArgs(plan), [
      "image",
      "inspect",
      "scotty-container:ci",
      "--format",
      "{{.Size}}",
    ]);
    assert.deepEqual(
      inspected.map(({ image }) => image),
      ["scotty-container:ci"],
    );
    assert.deepEqual(inspected[0].options.inspectArgs, containerImageInspectArgs(plan));
  });

  it("fails closed when image inspect is missing or over budget", async () => {
    await assert.rejects(
      checkContainerImage({
        root: "/repo",
        environment: {},
        prepare: async () => {},
        docker: () => {},
        inspect: async () => {
          throw new Error(
            `Failed to ${CONTAINER_IMAGE_BUDGET.metric} for ${CONTAINER_IMAGE}: No such object`,
          );
        },
      }),
      /Failed to docker image inspect Size/u,
    );
    await assert.rejects(
      checkContainerImage({
        root: "/repo",
        environment: {},
        prepare: async () => {},
        docker: () => {},
        inspect: async () => {
          throw new Error(
            `Container image ${CONTAINER_IMAGE_BUDGET.metric} is ${CONTAINER_IMAGE_BUDGET.maxBytes + 1} bytes; budget is ${CONTAINER_IMAGE_BUDGET.maxBytes} bytes`,
          );
        },
      }),
      /docker image inspect Size is \d+ bytes; budget is/u,
    );
  });

  it("reuses the CLI-stage GHA cache and writes a distinct full-image scope", () => {
    const plan = containerImagePlan("/repo", {
      GITHUB_ACTIONS: "true",
      ACTIONS_CACHE_URL: "https://results.example/cache/",
    });
    assert.deepEqual(plan.cache, {
      from: [
        `type=gha,scope=${CONTAINER_IMAGE_CACHE_SCOPE}`,
        `type=gha,scope=${CLEAN_ROOM_CACHE_SCOPE}`,
      ],
      to: `type=gha,mode=max,scope=${CONTAINER_IMAGE_CACHE_SCOPE},ignore-error=true`,
    });
    const args = containerImageBuildArgs(plan);
    assert.equal(args.includes("--target"), false);
    assert.ok(args.includes("--cache-from"));
    assert.ok(args.includes("--cache-to"));
    assert.ok(args.includes(`type=gha,scope=${CLEAN_ROOM_CACHE_SCOPE}`));
    assert.ok(args.includes(`type=gha,scope=${CONTAINER_IMAGE_CACHE_SCOPE}`));
  });

  it("keeps the explicit full-image command available without running it in PR CI", () => {
    const pkg = JSON.parse(read("package.json"));
    const ci = read(".github/workflows/ci.yml");

    assert.equal(pkg.scripts["check:container-image"], "node scripts/check-container-image.mjs");
    assert.equal(pkg.scripts["check:cli-clean-room"], "node scripts/check-cli-clean-room.mjs");
    assert.doesNotMatch(pkg.scripts.check, /check:container-image/u);
    assert.doesNotMatch(pkg.scripts.check, /check:cli-clean-room/u);
    assert.match(ci, /npm run check:cli-clean-room/u);
    assert.match(ci, /cli-clean-room:/u);
    assert.doesNotMatch(ci, /container-image:/u);
    assert.doesNotMatch(ci, /npm run check:container-image/u);
  });
});
