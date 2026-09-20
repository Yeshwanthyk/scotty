import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  CLEAN_ROOM_CLI_PLATFORM,
  CLEAN_ROOM_RUNTIME_ARTIFACT,
  checkCliCleanRoom,
  cleanRoomBuildArgs,
  cleanRoomCliPlan,
  cleanRoomVerifyArgs,
} from "./check-cli-clean-room.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

describe("clean-room runtime CLI gate", () => {
  it("builds the dedicated runtime artifact and executes it on the exact pinned base", () => {
    const buildCalls = [];
    const dockerCalls = [];
    const plan = checkCliCleanRoom({
      root,
      build: (command, args, options) => buildCalls.push({ command, args, options }),
      docker: (command, args) => dockerCalls.push({ command, args }),
    });

    assert.equal(plan.platform, CLEAN_ROOM_CLI_PLATFORM);
    assert.match(plan.baseImage, /^docker\.io\/cloudflare\/sandbox:[^\s@]+@sha256:[0-9a-f]{64}$/u);
    assert.ok(plan.artifact.endsWith(CLEAN_ROOM_RUNTIME_ARTIFACT));
    assert.deepEqual(buildCalls, [
      { command: "bun", args: cleanRoomBuildArgs(plan), options: { cwd: root } },
    ]);
    assert.deepEqual(dockerCalls, [{ command: "docker", args: cleanRoomVerifyArgs(plan) }]);
    const verify = cleanRoomVerifyArgs(plan).join(" ");
    assert.match(verify, /--network=none/u);
    assert.match(verify, /test ! -e \/usr\/local\/bin\/scotty/u);
    assert.match(verify, /scotty-runtime --version/u);
    assert.match(verify, /embeddedDeployment/u);
  });

  it("does not rebuild the container image to prove the runtime CLI", () => {
    const plan = cleanRoomCliPlan(root);
    assert.deepEqual(cleanRoomBuildArgs(plan), ["scripts/build-runtime-cli.mjs", plan.artifact]);
    assert.equal(cleanRoomVerifyArgs(plan).includes("buildx"), false);
    assert.equal(cleanRoomVerifyArgs(plan).includes("--volume"), true);
  });
});
