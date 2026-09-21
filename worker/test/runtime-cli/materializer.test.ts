import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, vi } from "vitest";
import { runtimeImageCompatibilityBytes } from "../../../protocol/runtime/runtime-image-compatibility";
import {
  RuntimeCliMaterializer,
  runtimeCliMaterializerLayer,
} from "../../src/runtime-cli/materializer";
import { runtimeCliExecutable, runtimeCliPath } from "../../src/runtime-cli/paths";
import { sandboxRuntimeLayer } from "../../src/sandbox/runtime";
import { runtimeCliPin } from "./fixtures";

const sessionId = "a0b1c2d3e4f5";
const bytes = new TextEncoder().encode("#!/bin/sh\nexit 0\n");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const pin = {
  ...runtimeCliPin,
  descriptor: {
    ...runtimeCliPin.descriptor,
    artifact: { ...runtimeCliPin.descriptor.artifact, byteSize: bytes.byteLength, sha256 },
  },
};
const imageDigest = `sha256:${"d".repeat(64)}`;
const keys = generateKeyPairSync("ed25519");
const payload = { imageDigest, compatibility: pin.descriptor.compatibility };
const evidence = {
  ...payload,
  signature: Buffer.from(
    sign(null, runtimeImageCompatibilityBytes(payload), keys.privateKey),
  ).toString("base64"),
};
const trust = () => {
  const original = crypto;
  const key = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  vi.stubGlobal("crypto", {
    randomUUID: original.randomUUID.bind(original),
    subtle: {
      importKey: () =>
        original.subtle.importKey("raw", Uint8Array.from(key), "Ed25519", false, ["verify"]),
      verify: original.subtle.verify.bind(original.subtle),
    },
  });
};
afterEach(() => vi.unstubAllGlobals());

const fixture = (
  options: {
    missing?: boolean;
    corrupt?: boolean;
    installed?: boolean;
    commandFails?: string;
  } = {},
) => {
  const commands: string[] = [];
  const writes: string[] = [];
  let reads = 0;
  const bucket = {
    get: async () => {
      reads++;
      return options.missing
        ? null
        : {
            body: new Blob([bytes]).stream(),
            size: bytes.byteLength,
            checksums: {
              sha256: Uint8Array.from(Buffer.from(options.corrupt ? "e".repeat(64) : sha256, "hex"))
                .buffer,
              toJSON: () => ({ sha256 }),
            },
            httpMetadata: { contentType: "application/octet-stream" },
            customMetadata: {
              "scotty-runtime-cache-schema": "1",
              "scotty-runtime-byte-sha256": sha256,
              "scotty-runtime-byte-size": String(bytes.byteLength),
              "scotty-runtime-artifact-name": pin.descriptor.artifact.name,
            },
          };
    },
  };
  const runtime = sandboxRuntimeLayer({
    exec: async (command) => {
      commands.push(command);
      const success = command.startsWith("test -e ")
        ? options.installed === true
        : !command.includes(options.commandFails ?? "NEVER_FAIL");
      return {
        success,
        exitCode: success ? 0 : 1,
        stdout: "",
        stderr: "",
        command,
        duration: 1,
        timestamp: "2026-09-20T00:00:00.000Z",
      };
    },
    mkdir: async () => undefined,
    writeFile: async (path, content) => {
      writes.push(path);
      assert.ok(content instanceof ReadableStream);
      assert.deepEqual(new Uint8Array(await new Response(content).arrayBuffer()), bytes);
    },
    readFileStream: async () => new Blob([]).stream(),
    setEnvVars: async () => undefined,
  });
  const layer = runtimeCliMaterializerLayer(bucket, JSON.stringify(evidence), imageDigest).pipe(
    Layer.provide(runtime),
  );
  return { layer, runtime, bucket, commands, writes, reads: () => reads };
};
const materialize = (pinValue = pin) =>
  Effect.flatMap(RuntimeCliMaterializer, (service) => service.materialize(sessionId, pinValue));

describe("managed runtime CLI materialization", () => {
  it.effect(
    "streams exact bytes, verifies size/hash/mode, publishes create-only, starts absolute binary and cleans staging",
    () =>
      Effect.gen(function* () {
        trust();
        const test = fixture();
        yield* materialize().pipe(Effect.provide(test.layer));
        assert.equal(test.writes.length, 1);
        assert.ok(test.commands.some((command) => command.startsWith("ln ")));
        assert.ok(test.commands.some((command) => command.includes("sha256sum --check --strict")));
        assert.ok(test.commands.some((command) => command.includes("stat -c %a")));
        assert.include(test.commands, `'${runtimeCliExecutable(sessionId)}' --version`);
        assert.ok(test.commands.at(-1)?.startsWith("rm -f "));
        assert.equal(
          runtimeCliPath(sessionId, ["/user-tools"]).split(":")[0],
          `/workspace/${sessionId}/.scotty/runtime-cli/bin`,
        );
      }),
  );
  it.effect("resume checks R2 and exact existing executable without replacing it", () =>
    Effect.gen(function* () {
      trust();
      const test = fixture({ installed: true });
      yield* materialize().pipe(Effect.provide(test.layer));
      assert.equal(test.reads(), 1);
      assert.equal(test.writes.length, 0);
      assert.isFalse(test.commands.some((command) => command.startsWith("ln ")));
      assert.include(test.commands, `'${runtimeCliExecutable(sessionId)}' --version`);
    }),
  );
  for (const options of [{ missing: true }, { corrupt: true }]) {
    it.effect(
      `rejects ${options.missing ? "missing" : "corrupt"} R2 bytes even when installed`,
      () =>
        Effect.gen(function* () {
          trust();
          const test = fixture({ ...options, installed: true });
          const error = yield* materialize().pipe(Effect.provide(test.layer), Effect.flip);
          assert.equal(error.reason, options.missing ? "missing_artifact" : "artifact_integrity");
          assert.equal(test.commands.length, 0);
        }),
    );
  }
  for (const commandFails of ["sha256sum", " --version"]) {
    it.effect(
      `failed ${commandFails} blocks readiness, never invoking a PATH scotty substitute`,
      () =>
        Effect.gen(function* () {
          trust();
          const test = fixture({ commandFails });
          const error = yield* materialize().pipe(Effect.provide(test.layer), Effect.flip);
          assert.equal(error.reason, "runtime");
          assert.isFalse(test.commands.some((command) => command === "scotty --version"));
          assert.ok(test.commands.at(-1)?.startsWith("rm -f "));
        }),
    );
  }
  it.effect("changed image invalidates evidence before reading bytes", () =>
    Effect.gen(function* () {
      trust();
      const test = fixture();
      const layer = runtimeCliMaterializerLayer(
        test.bucket,
        JSON.stringify(evidence),
        `sha256:${"e".repeat(64)}`,
      ).pipe(Layer.provide(test.runtime));
      const error = yield* materialize().pipe(Effect.provide(layer), Effect.flip);
      assert.equal(error.reason, "unsupported_image");
      assert.equal(test.reads(), 0);
    }),
  );
});
