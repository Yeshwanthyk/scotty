// @ts-expect-error The release signer is an executable JavaScript module without declarations.
import { signRuntimeCliReleasePayload as signRuntimeCliReleasePayloadUntyped } from "../../../scripts/make-runtime-cli-release.mjs";
import { assert, describe, it } from "@effect/vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  canonicalRuntimeCliManifestBytes,
  RUNTIME_CLI_SIGNING_CONTEXT,
  type RuntimeCliArtifactDescriptor,
  type RuntimeCliManifest,
  verifyRuntimeCliManifest,
} from "../../../protocol/runtime/runtime-cli-manifest";
import { Effect } from "effect";
import { afterEach, vi } from "vitest";

const revision = "a".repeat(40);
const digest = "b".repeat(64);
const sandboxImage =
  "docker.io/cloudflare/sandbox:0.12.9@sha256:4a56a37a3cfd9b38d65bb4b5d0b341e6490a3a4c0226274ae4c1cca4948e85fe";

type RuntimeCliReleaseSigner = (options: {
  readonly payload: RuntimeCliArtifactDescriptor;
  readonly privateKeyPem: string;
  readonly trustedPublicKeyBase64: string;
}) => RuntimeCliManifest;

const signRuntimeCliReleasePayload: RuntimeCliReleaseSigner = signRuntimeCliReleasePayloadUntyped;

const descriptor = (): RuntimeCliArtifactDescriptor => ({
  schemaVersion: 1,
  releaseTag: "v0.3.19",
  artifact: {
    name: "scotty-runtime-linux-amd64",
    cliVersion: "0.3.19",
    revision,
    target: "linux/amd64",
    byteSize: 123,
    sha256: digest,
    installMode: "0755",
  },
  compatibility: {
    bunVersion: "1.3.13",
    compileTarget: "bun-linux-x64-baseline",
    cpu: "x86-64-baseline",
    libc: "glibc",
    cloudflareSandbox: {
      packageVersion: "0.12.9",
      image: sandboxImage,
    },
  },
});

const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const publicKeyBytes = Uint8Array.from(publicKeyDer.subarray(-32));
  return {
    privateKey,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: publicKeyBytes,
    publicKeyBase64: Buffer.from(publicKeyBytes).toString("base64"),
  };
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const useEphemeralTrustRoot = (publicKeyBytes: Uint8Array): void => {
  const subtle = crypto.subtle;
  vi.stubGlobal("crypto", {
    subtle: {
      importKey: () =>
        subtle.importKey("raw", toArrayBuffer(publicKeyBytes), "Ed25519", false, ["verify"]),
      verify: subtle.verify.bind(subtle),
    },
  });
};

const signedManifest = (
  value: RuntimeCliArtifactDescriptor,
  privateKey: ReturnType<typeof keyPair>["privateKey"],
  bytes = canonicalRuntimeCliManifestBytes(value),
): RuntimeCliManifest => ({
  ...value,
  signature: Buffer.from(sign(null, bytes, privateKey)).toString("base64"),
});

const outcome = (input: unknown) =>
  verifyRuntimeCliManifest(input).pipe(
    Effect.as("verified" as const),
    Effect.catchTags({
      MalformedRuntimeCliManifestError: () => Effect.succeed("malformed" as const),
      InvalidRuntimeCliManifestSignatureError: () => Effect.succeed("signature" as const),
      RuntimeCliManifestCryptoError: () => Effect.succeed("crypto" as const),
    }),
  );

afterEach(() => vi.unstubAllGlobals());

describe("runtime CLI manifest verification", () => {
  it.effect("strictly decodes, authenticates, and returns the verified descriptor", () =>
    Effect.gen(function* () {
      const keys = keyPair();
      useEphemeralTrustRoot(keys.publicKey);
      const expected = descriptor();
      const verified = yield* verifyRuntimeCliManifest(signedManifest(expected, keys.privateKey));
      assert.deepStrictEqual(verified, expected);
    }),
  );

  it.effect("verifies output from the exported release signer", () =>
    Effect.gen(function* () {
      const keys = keyPair();
      useEphemeralTrustRoot(keys.publicKey);
      const expected = descriptor();
      const signed = signRuntimeCliReleasePayload({
        payload: expected,
        privateKeyPem: keys.privateKeyPem,
        trustedPublicKeyBase64: keys.publicKeyBase64,
      });
      assert.deepStrictEqual(yield* verifyRuntimeCliManifest(signed), expected);
    }),
  );

  it("matches the release signer's exact length-prefixed serialization", () => {
    assert.strictEqual(RUNTIME_CLI_SIGNING_CONTEXT, "scotty-runtime-cli-manifest-v1");
    assert.strictEqual(
      Buffer.from(canonicalRuntimeCliManifestBytes(descriptor())).toString("base64"),
      "AAAAHnNjb3R0eS1ydW50aW1lLWNsaS1tYW5pZmVzdC12MQAAAAExAAAAB3YwLjMuMTkAAAAac2NvdHR5LXJ1bnRpbWUtbGludXgtYW1kNjQAAAAGMC4zLjE5AAAAKGFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEAAAALbGludXgvYW1kNjQAAAADMTIzAAAAQGJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmIAAAAEMDc1NQAAAAYxLjMuMTMAAAAWYnVuLWxpbnV4LXg2NC1iYXNlbGluZQAAAA94ODYtNjQtYmFzZWxpbmUAAAAFZ2xpYmMAAAAGMC4xMi45AAAAa2RvY2tlci5pby9jbG91ZGZsYXJlL3NhbmRib3g6MC4xMi45QHNoYTI1Njo0YTU2YTM3YTNjZmQ5YjM4ZDY1YmI0YjVkMGIzNDFlNjQ5MGEzYTRjMDIyNjI3NGFlNGMxY2NhNDk0OGU4NWZl",
    );
  });

  it.effect("rejects tampering, a wrong key, and a different signing context", () =>
    Effect.gen(function* () {
      const trusted = keyPair();
      const untrusted = keyPair();
      useEphemeralTrustRoot(trusted.publicKey);
      const value = descriptor();
      const signed = signedManifest(value, trusted.privateKey);
      const wrongContextBytes = canonicalRuntimeCliManifestBytes(value).slice();
      wrongContextBytes[4] ^= 1;

      for (const candidate of [
        { ...signed, artifact: { ...signed.artifact, byteSize: 124 } },
        signedManifest(value, untrusted.privateKey),
        signedManifest(value, trusted.privateKey, wrongContextBytes),
      ]) {
        assert.strictEqual(yield* outcome(candidate), "signature");
      }
    }),
  );

  it.effect("rejects malformed or unsupported artifact and compatibility claims", () =>
    Effect.gen(function* () {
      const keys = keyPair();
      useEphemeralTrustRoot(keys.publicKey);
      const value = descriptor();
      const signature = signedManifest(value, keys.privateKey).signature;
      const malformed: ReadonlyArray<unknown> = [
        { ...value, schemaVersion: 2, signature },
        { ...value, releaseTag: "v0.3.20", signature },
        { ...value, extra: true, signature },
        { ...value, artifact: { ...value.artifact, target: "linux/arm64" }, signature },
        { ...value, artifact: { ...value.artifact, installMode: "0777" }, signature },
        { ...value, artifact: { ...value.artifact, byteSize: 0 }, signature },
        { ...value, artifact: { ...value.artifact, byteSize: 1.5 }, signature },
        {
          ...value,
          artifact: { ...value.artifact, byteSize: Number.MAX_SAFE_INTEGER + 1 },
          signature,
        },
        { ...value, artifact: { ...value.artifact, sha256: "B".repeat(64) }, signature },
        { ...value, compatibility: { ...value.compatibility, bunVersion: "latest" }, signature },
        {
          ...value,
          compatibility: { ...value.compatibility, compileTarget: "bun-linux-x64" },
          signature,
        },
        { ...value, compatibility: { ...value.compatibility, cpu: "x86-64-v3" }, signature },
        { ...value, compatibility: { ...value.compatibility, libc: "musl" }, signature },
        {
          ...value,
          compatibility: {
            ...value.compatibility,
            cloudflareSandbox: {
              ...value.compatibility.cloudflareSandbox,
              packageVersion: "0.13.0",
            },
          },
          signature,
        },
        {
          ...value,
          compatibility: {
            ...value.compatibility,
            cloudflareSandbox: {
              ...value.compatibility.cloudflareSandbox,
              packageVersion: "00.12.9",
            },
          },
          signature,
        },
        {
          ...value,
          compatibility: {
            ...value.compatibility,
            cloudflareSandbox: {
              ...value.compatibility.cloudflareSandbox,
              extra: true,
            },
          },
          signature,
        },
        {
          ...value,
          compatibility: {
            ...value.compatibility,
            cloudflareSandbox: {
              ...value.compatibility.cloudflareSandbox,
              image: "docker.io/cloudflare/sandbox:latest",
            },
          },
          signature,
        },
        { ...value, signature: "not-base64" },
      ];

      for (const candidate of malformed) {
        assert.strictEqual(yield* outcome(candidate), "malformed");
      }
    }),
  );

  it.effect("accepts positive safe-integer executable sizes without an arbitrary cap", () =>
    Effect.gen(function* () {
      const keys = keyPair();
      useEphemeralTrustRoot(keys.publicKey);
      const value = descriptor();
      const large = {
        ...value,
        artifact: { ...value.artifact, byteSize: 128 * 1024 * 1024 + 1 },
      };
      assert.strictEqual(yield* outcome(signedManifest(large, keys.privateKey)), "verified");
    }),
  );
});
