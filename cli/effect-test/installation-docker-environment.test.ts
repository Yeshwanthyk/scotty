import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  resolveInstallationDockerHost,
  type InstallationDockerInspect,
} from "../src/installation-deployment.ts";

const DOCKER_CONTEXT_INSPECT_ARGS = [
  "context",
  "inspect",
  "--format",
  "{{json .Endpoints.docker.Host}}",
] as const;

describe("installation deployment docker environment", () => {
  it.effect("preserves an explicit Docker host without invoking docker", () =>
    Effect.gen(function* () {
      let invoked = false;
      const inspect: InstallationDockerInspect = async () => {
        invoked = true;
        return '"unix:///should-not-run"\n';
      };
      const endpoint = yield* resolveInstallationDockerHost(
        { DOCKER_HOST: "unix:///explicit/docker.sock" },
        inspect,
      );
      assert.strictEqual(endpoint, undefined);
      assert.isFalse(invoked);
    }),
  );

  it.effect("resolves the active Docker context when DOCKER_HOST is unset", () =>
    Effect.gen(function* () {
      let invoked = false;
      const endpoint = yield* resolveInstallationDockerHost(
        { PATH: "/usr/bin" },
        async (command, args) => {
          invoked = true;
          assert.strictEqual(command, "docker");
          assert.deepStrictEqual(args, DOCKER_CONTEXT_INSPECT_ARGS);
          return '"unix:///Users/test/.colima/default/docker.sock"\n';
        },
      );
      assert.isTrue(invoked);
      assert.strictEqual(endpoint, "unix:///Users/test/.colima/default/docker.sock");
    }),
  );

  it.effect("leaves Docker host unset when context inspection fails", () =>
    Effect.gen(function* () {
      const missing: InstallationDockerInspect = async () =>
        Promise.reject(new Error("docker not found"));
      const endpoint = yield* resolveInstallationDockerHost({ PATH: "/usr/bin" }, missing);
      assert.strictEqual(endpoint, undefined);
    }),
  );
});
