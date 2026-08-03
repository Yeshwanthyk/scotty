import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  InvalidUpgradeDigestError,
  InvalidUpgradeSignatureError,
  MalformedUpgradeManifestError,
  UPGRADE_MANIFEST_SIGNING_CONTEXT,
  UpgradeTargetNotFoundError,
  canonicalUpgradeManifestBytes,
  selectUpgradeAsset,
  verifyUpgradeAsset,
  verifyUpgradeManifest,
  type UpgradeManifestPayload,
} from "../src/upgrade";

const textEncoder = new TextEncoder();

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const sha256 = Effect.fnUntraced(function* (bytes: Uint8Array) {
  const digest = yield* Effect.promise(() =>
    globalThis.crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
});

const makeFixture = Effect.fnUntraced(function* (assetBytes: Uint8Array) {
  const keyPair = yield* Effect.promise(() =>
    globalThis.crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]),
  );
  assert.isTrue("privateKey" in keyPair && "publicKey" in keyPair);
  if (!("privateKey" in keyPair) || !("publicKey" in keyPair)) {
    return yield* Effect.die("Expected an Ed25519 key pair");
  }

  const payload: UpgradeManifestPayload = {
    version: 1,
    releaseTag: "v1.2.3",
    assets: [
      {
        platform: "darwin",
        architecture: "arm64",
        name: "scotty-darwin-arm64",
        sha256: yield* sha256(assetBytes),
      },
    ],
  };
  const signature = yield* Effect.promise(() =>
    globalThis.crypto.subtle.sign(
      "Ed25519",
      keyPair.privateKey,
      toArrayBuffer(canonicalUpgradeManifestBytes(payload)),
    ),
  );
  const publicKey = yield* Effect.promise(() =>
    globalThis.crypto.subtle.exportKey("raw", keyPair.publicKey),
  );

  return {
    manifest: { ...payload, signature: bytesToBase64(new Uint8Array(signature)) },
    trustedManifestPublicKey: new Uint8Array(publicKey),
  };
});

describe("CLI upgrade verification", () => {
  it("canonicalizes asset order under the upgrade-manifest domain", () => {
    const payload: UpgradeManifestPayload = {
      version: 1,
      releaseTag: "v1.2.3",
      assets: [
        {
          platform: "linux",
          architecture: "x64",
          name: "scotty-linux-x64",
          sha256: "1".repeat(64),
        },
        {
          platform: "darwin",
          architecture: "arm64",
          name: "scotty-darwin-arm64",
          sha256: "2".repeat(64),
        },
      ],
    };
    const canonical = canonicalUpgradeManifestBytes(payload);
    const reordered = canonicalUpgradeManifestBytes({
      ...payload,
      assets: [...payload.assets].reverse(),
    });
    const contextLength = new DataView(canonical.buffer).getUint32(0, false);
    const context = new TextDecoder().decode(canonical.slice(4, 4 + contextLength));

    assert.deepStrictEqual(canonical, reordered);
    assert.strictEqual(context, UPGRADE_MANIFEST_SIGNING_CONTEXT);
  });

  it.effect("verifies a valid manifest signature and asset digest", () =>
    Effect.gen(function* () {
      const assetBytes = textEncoder.encode("signed scotty executable");
      const fixture = yield* makeFixture(assetBytes);
      const manifest = yield* verifyUpgradeManifest(fixture);
      const asset = yield* selectUpgradeAsset(manifest, {
        platform: "darwin",
        architecture: "arm64",
      });

      yield* verifyUpgradeAsset(asset, assetBytes);
      assert.strictEqual(asset.name, "scotty-darwin-arm64");
    }),
  );

  it.effect("rejects an invalid manifest signature", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture(textEncoder.encode("signed scotty executable"));
      const signature = fixture.manifest.signature;
      const manifest = {
        ...fixture.manifest,
        signature: `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`,
      };

      const error = yield* verifyUpgradeManifest({
        manifest,
        trustedManifestPublicKey: fixture.trustedManifestPublicKey,
      }).pipe(Effect.flip);
      assert.instanceOf(error, InvalidUpgradeSignatureError);
      assert.strictEqual(error.reason, "invalid_signature");
    }),
  );

  it.effect("rejects an invalid asset digest", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture(textEncoder.encode("expected executable"));
      const manifest = yield* verifyUpgradeManifest(fixture);
      const asset = yield* selectUpgradeAsset(manifest, {
        platform: "darwin",
        architecture: "arm64",
      });

      const error = yield* verifyUpgradeAsset(
        asset,
        textEncoder.encode("tampered executable"),
      ).pipe(Effect.flip);
      assert.instanceOf(error, InvalidUpgradeDigestError);
      assert.strictEqual(error.expectedSha256, asset.sha256);
    }),
  );

  it.effect("rejects a malformed manifest", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture(textEncoder.encode("signed scotty executable"));
      const malformed = {
        ...fixture.manifest,
        assets: [{ ...fixture.manifest.assets[0], unexpected: true }],
      };

      const error = yield* verifyUpgradeManifest({
        manifest: malformed,
        trustedManifestPublicKey: fixture.trustedManifestPublicKey,
      }).pipe(Effect.flip);
      assert.instanceOf(error, MalformedUpgradeManifestError);
      assert.strictEqual(error.reason, "schema");
    }),
  );

  it.effect("rejects a manifest without the requested target", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture(textEncoder.encode("signed scotty executable"));
      const manifest = yield* verifyUpgradeManifest(fixture);

      const error = yield* selectUpgradeAsset(manifest, {
        platform: "linux",
        architecture: "x64",
      }).pipe(Effect.flip);
      assert.instanceOf(error, UpgradeTargetNotFoundError);
      assert.strictEqual(error.platform, "linux");
      assert.strictEqual(error.architecture, "x64");
    }),
  );
});
