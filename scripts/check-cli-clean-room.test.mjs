import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

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
    assert.match(plan.baseImage, /^docker\.io\/cloudflare\/sandbox:0\.12\.9@sha256:[0-9a-f]{64}$/u);
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

  it("keeps standalone and runtime release checks while the image has no baked CLI", () => {
    const pkg = JSON.parse(read("package.json"));
    const ci = read(".github/workflows/ci.yml");
    const dockerfile = read("worker/container/Dockerfile");
    const release = read(".github/workflows/release-cli.yml");

    assert.equal(pkg.scripts["check:cli-clean-room"], "node scripts/check-cli-clean-room.mjs");
    assert.equal(
      pkg.scripts["check:cli-standalone-deploy"],
      "node scripts/check-cli-standalone-deploy.mjs",
    );
    assert.match(ci, /npm run check:cli-clean-room/u);
    assert.match(ci, /npm run check:cli-standalone-deploy/u);
    assert.match(release, /test ! -e \/usr\/local\/bin\/scotty/u);
    assert.match(
      dockerfile,
      /FROM docker\.io\/cloudflare\/sandbox:0\.12\.9@sha256:[0-9a-f]{64} AS scotty-codex-server-build/u,
    );
    assert.doesNotMatch(dockerfile, /bun build cli\/scotty\.ts|\/out\/scotty(?:\s|\\)/u);
    assert.doesNotMatch(dockerfile, /COPY --from=.*\/out\/scotty(?:\s|$)/mu);
  });
});
