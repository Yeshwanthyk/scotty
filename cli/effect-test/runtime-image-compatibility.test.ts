import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, vi } from "vitest";
import { runtimeImageCompatibilityBytes } from "../../protocol/runtime-image-compatibility";
import { runtimeCliPin } from "../../worker/test/runtime-cli/fixtures";
import { fetchReleasedContainerImage, parseContainerImageSource } from "../src/container-image";

afterEach(() => vi.unstubAllGlobals());
it.effect(
  "released standard selection carries verified digest-bound evidence into deployment inputs",
  () =>
    Effect.gen(function* () {
      const imageDigest = `sha256:${"a".repeat(64)}`;
      const payload = { imageDigest, compatibility: runtimeCliPin.descriptor.compatibility };
      const keys = generateKeyPairSync("ed25519");
      const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
      const original = crypto.subtle;
      vi.stubGlobal("crypto", {
        subtle: {
          importKey: () =>
            original.importKey("raw", Uint8Array.from(publicKey), "Ed25519", false, ["verify"]),
          verify: original.verify.bind(original),
        },
      });
      const evidence = {
        ...payload,
        signature: Buffer.from(
          sign(null, runtimeImageCompatibilityBytes(payload), keys.privateKey),
        ).toString("base64"),
      };
      const manifest = {
        version: 1,
        releaseTag: "v0.3.19",
        image: {
          repository: "index.docker.io/example/scotty",
          digest: imageDigest,
          reference: `index.docker.io/example/scotty@${imageDigest}`,
          platform: "linux/amd64",
          configDigest: `sha256:${"b".repeat(64)}`,
          revision: "c".repeat(40),
        },
        runtimeCompatibility: evidence,
      };
      const selected = yield* fetchReleasedContainerImage("0.3.19", async () =>
        Response.json(manifest),
      );
      assert.deepEqual(selected.runtimeCompatibility, evidence);
      const mismatch = yield* fetchReleasedContainerImage("0.3.19", async () =>
        Response.json({
          ...manifest,
          runtimeCompatibility: { ...evidence, imageDigest: `sha256:${"d".repeat(64)}` },
        }),
      ).pipe(Effect.flip);
      assert.equal(mismatch.reason, "invalid_source");
      const unsigned = yield* fetchReleasedContainerImage("0.3.19", async () =>
        Response.json({ ...manifest, runtimeCompatibility: undefined }),
      ).pipe(Effect.flip);
      assert.equal(unsigned.reason, "invalid_source");
      // Custom source parsing/transfer inputs are preserved, but do not acquire standard evidence.
      assert.equal(
        parseContainerImageSource(manifest.image.reference).runtimeCompatibility,
        undefined,
      );
    }),
);
