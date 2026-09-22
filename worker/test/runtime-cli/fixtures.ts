import { Effect, Layer } from "effect";
import { RuntimeCliMaterializer } from "../../src/runtime-cli/materializer";
import type { RuntimeCliPin } from "../../../protocol/runtime/runtime-cli-pin";

export const runtimeCliPin: RuntimeCliPin = {
  descriptor: {
    schemaVersion: 1,
    releaseTag: "v0.3.19",
    artifact: {
      name: "scotty-runtime-linux-amd64",
      cliVersion: "0.3.19",
      revision: "a".repeat(40),
      target: "linux/amd64",
      byteSize: 20,
      sha256: "b".repeat(64),
      installMode: "0755",
    },
    compatibility: {
      bunVersion: "1.3.13",
      compileTarget: "bun-linux-x64-baseline",
      cpu: "x86-64-baseline",
      libc: "glibc",
      cloudflareSandbox: {
        packageVersion: "0.12.9",
        image: `docker.io/cloudflare/sandbox:0.12.9@sha256:${"c".repeat(64)}`,
      },
    },
  },
  verifiedAt: 0,
  freshness: "github_verified",
};

export const sessionIdentityPin = {
  selection: { agent: "pi" as const },
  configuration: {
    runtimeCli: runtimeCliPin,
    revision: 0,
    bundleDigest: null,
    agentInstructions: "",
    environment: {},
  },
};
// Lifecycle unit tests replace installation; production materialization has its own contract tests.
export const runtimeCliMaterializerTestLayer = Layer.succeed(RuntimeCliMaterializer)({
  materialize: () => Effect.void,
});
