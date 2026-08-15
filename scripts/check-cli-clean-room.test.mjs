import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CONTAINER_CONTEXT_PATH } from "../cli/src/deployment-packaging.ts";
import {
  CLEAN_ROOM_CLI_IMAGE,
  CLEAN_ROOM_CLI_PLATFORM,
  CLEAN_ROOM_CLI_TARGET,
  checkCliCleanRoom,
  cleanRoomBuildArgs,
  cleanRoomCliPlan,
  cleanRoomVerifyArgs,
} from "./check-cli-clean-room.mjs";

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

describe("clean-room CLI image gate", () => {
  it("prepares the isolated context and builds only scotty-cli-build for linux/amd64", async () => {
    const prepared = [];
    const dockerCalls = [];
    const plan = await checkCliCleanRoom({
      root: "/repo",
      environment: {},
      prepare: async (root) => {
        prepared.push(root);
      },
      docker: (command, args) => {
        dockerCalls.push({ command, args });
      },
    });

    assert.deepEqual(prepared, ["/repo"]);
    assert.equal(plan.context, `/repo/${CONTAINER_CONTEXT_PATH}`);
    assert.equal(plan.dockerfile, `/repo/${CONTAINER_CONTEXT_PATH}/worker/container/Dockerfile`);
    assert.equal(plan.platform, CLEAN_ROOM_CLI_PLATFORM);
    assert.equal(plan.target, CLEAN_ROOM_CLI_TARGET);
    assert.equal(plan.image, CLEAN_ROOM_CLI_IMAGE);
    assert.deepEqual(plan.verifyArgs, ["tui", "--help"]);
    assert.equal(plan.cache, undefined);
    assert.deepEqual(dockerCalls, [
      { command: "docker", args: cleanRoomBuildArgs(plan) },
      { command: "docker", args: cleanRoomVerifyArgs(plan) },
    ]);
    assert.deepEqual(cleanRoomBuildArgs(plan), [
      "buildx",
      "build",
      "--platform",
      "linux/amd64",
      "--target",
      "scotty-cli-build",
      "--load",
      "-t",
      "scotty-cli-build:clean-room",
      "-f",
      plan.dockerfile,
      plan.context,
    ]);
    assert.deepEqual(cleanRoomVerifyArgs(plan), [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--entrypoint",
      "/out/scotty",
      "scotty-cli-build:clean-room",
      "tui",
      "--help",
    ]);
  });

  it("enables GitHub Actions layer cache only when the cache backend is present", () => {
    const plan = cleanRoomCliPlan("/repo", {
      GITHUB_ACTIONS: "true",
      ACTIONS_CACHE_URL: "https://results.example/cache/",
    });
    assert.deepEqual(plan.cache, {
      from: "type=gha,scope=scotty-cli-build",
      to: "type=gha,mode=max,scope=scotty-cli-build,ignore-error=true",
    });
    assert.ok(cleanRoomBuildArgs(plan).includes("--cache-from"));
    assert.ok(cleanRoomBuildArgs(plan).includes("--cache-to"));
  });

  it("is invoked from PR CI with the pinned Bun file and a reusable npm script", () => {
    const pkg = JSON.parse(read("package.json"));
    const ci = read(".github/workflows/ci.yml");
    const dockerfile = read("worker/container/Dockerfile");
    const bunVersion = read(".bun-version").trim();
    const release = read(".github/workflows/release-cli.yml");

    assert.equal(pkg.scripts["check:cli-clean-room"], "node scripts/check-cli-clean-room.mjs");
    assert.equal(pkg.scripts["check:patches"], "node scripts/apply-dependency-patches.mjs --check");
    assert.match(pkg.scripts.check, /check:patches/u);
    assert.doesNotMatch(pkg.scripts.check, /check:cli-clean-room/u);
    assert.equal(bunVersion, "1.3.13");
    assert.match(ci, /bun-version-file: \.bun-version/u);
    assert.match(ci, /npm run check:cli-clean-room/u);
    assert.match(ci, /cli-clean-room:/u);
    assert.match(ci, /timeout-minutes: 30/u);
    assert.match(ci, /docker\/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c/u);
    assert.match(release, /bun-version-file: \.bun-version/u);
    assert.doesNotMatch(release, /bun-version: 1\.3\.13/u);
    assert.match(release, /Smoke native compiled release artifact/u);
    assert.match(release, /dist\/release\/scotty-linux-x64 tui --help/u);
    assert.match(
      dockerfile,
      /FROM docker\.io\/cloudflare\/sandbox:0\.12\.3@sha256:[0-9a-f]{64} AS scotty-cli-build/u,
    );
    assert.doesNotMatch(dockerfile, /bun-version/u);
    assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts --no-audit --no-fund/u);
    assert.match(dockerfile, /RUN node scripts\/apply-dependency-patches\.mjs$/mu);
    assert.doesNotMatch(dockerfile, /apply-dependency-patches\.mjs --check/u);
  });
});
