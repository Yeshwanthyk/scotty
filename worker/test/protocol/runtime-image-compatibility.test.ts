// @ts-expect-error Release signing is an executable JavaScript module without declarations.
import { signImageRuntimeCompatibility as untypedSigner } from "../../../scripts/make-image-release.mjs";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, vi } from "vitest";
import {
  verifyRuntimeImageCompatibility,
  type RuntimeImageCompatibilityEvidence,
} from "../../../protocol/runtime-image-compatibility";
import { runtimeCliPin } from "../runtime-cli/fixtures";

const signEvidence: (input: {
  imageDigest: string;
  compatibility: RuntimeImageCompatibilityEvidence["compatibility"];
  privateKeyPem: string;
  trustedPublicKeyBase64: string;
}) => RuntimeImageCompatibilityEvidence = untypedSigner;
const digest = `sha256:${"a".repeat(64)}`;
const fixture = () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const subtle = crypto.subtle;
  vi.stubGlobal("crypto", {
    subtle: {
      importKey: () =>
        subtle.importKey("raw", Uint8Array.from(publicKey), "Ed25519", false, ["verify"]),
      verify: subtle.verify.bind(subtle),
    },
  });
  return signEvidence({
    imageDigest: digest,
    compatibility: runtimeCliPin.descriptor.compatibility,
    privateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    trustedPublicKeyBase64: Buffer.from(publicKey).toString("base64"),
  });
};
afterEach(() => vi.unstubAllGlobals());
describe("signed standard-image runtime compatibility", () => {
  it.effect("release signer agrees with deployment and Worker verification", () =>
    Effect.gen(function* () {
      const evidence = fixture();
      assert.deepEqual(yield* verifyRuntimeImageCompatibility(evidence, digest), evidence);
    }),
  );
  it.effect("changing immutable image identity invalidates previous evidence", () =>
    Effect.gen(function* () {
      const evidence = fixture();
      const error = yield* verifyRuntimeImageCompatibility(
        evidence,
        `sha256:${"b".repeat(64)}`,
      ).pipe(Effect.flip);
      assert.equal(error.reason, "unsupported_image");
    }),
  );
  it.effect("changing the signed runtime tuple is rejected", () =>
    Effect.gen(function* () {
      const evidence = fixture();
      const error = yield* verifyRuntimeImageCompatibility(
        { ...evidence, compatibility: { ...evidence.compatibility, bunVersion: "9.0.0" } },
        digest,
      ).pipe(Effect.flip);
      assert.equal(error.reason, "invalid_evidence");
    }),
  );
  it.effect("an arbitrary/custom image digest is not evidence of runtime compatibility", () =>
    Effect.gen(function* () {
      const error = yield* verifyRuntimeImageCompatibility(undefined, digest).pipe(Effect.flip);
      assert.equal(error.reason, "unsupported_image");
    }),
  );
});
