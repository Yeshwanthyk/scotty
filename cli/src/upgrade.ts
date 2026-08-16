import { Effect, Schema } from "effect";

export const UPGRADE_MANIFEST_SIGNING_CONTEXT = "scotty-cli-upgrade-manifest-v1";
// Raw Ed25519 public key for manifests produced by the Scotty release workflow.
export const SCOTTY_RELEASE_PUBLIC_KEY_BASE64 = "b+jhy/AX9PzwFWofyVVPDg/FR8YLVJ9FGIAAJVVPpPE=";

const ED25519_PUBLIC_KEY_BYTES = 32;
const LENGTH_PREFIX_BYTES = 4;

export const UpgradePlatformSchema = Schema.Literals(["darwin", "linux", "win32"]);
export type UpgradePlatform = typeof UpgradePlatformSchema.Type;

export const UpgradeArchitectureSchema = Schema.Literals(["arm64", "x64"]);
export type UpgradeArchitecture = typeof UpgradeArchitectureSchema.Type;

export const UpgradeTargetSchema = Schema.Struct({
  platform: UpgradePlatformSchema,
  architecture: UpgradeArchitectureSchema,
});
export type UpgradeTarget = typeof UpgradeTargetSchema.Type;

const ReleaseTagSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const GitHubAssetNameSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u),
);
const Sha256Schema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

export const UpgradeAssetSchema = Schema.Struct({
  ...UpgradeTargetSchema.fields,
  name: GitHubAssetNameSchema,
  sha256: Sha256Schema,
});
export type UpgradeAsset = typeof UpgradeAssetSchema.Type;

export const UpgradeManifestPayloadSchema = Schema.Struct({
  version: Schema.Literal(1),
  releaseTag: ReleaseTagSchema,
  assets: Schema.Array(UpgradeAssetSchema).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
});
export type UpgradeManifestPayload = typeof UpgradeManifestPayloadSchema.Type;

const isCanonicalEd25519Signature = (value: string): boolean => {
  if (!/^[A-Za-z0-9+/]{86}==$/u.test(value)) return false;
  const decoded = atob(value);
  return decoded.length === 64 && btoa(decoded) === value;
};

export const UpgradeManifestSchema = Schema.Struct({
  ...UpgradeManifestPayloadSchema.fields,
  signature: Schema.String.check(Schema.makeFilter(isCanonicalEd25519Signature)),
});
export type UpgradeManifest = typeof UpgradeManifestSchema.Type;

export class MalformedUpgradeManifestError extends Schema.TaggedError<MalformedUpgradeManifestError>(
  "MalformedUpgradeManifestError",
)("MalformedUpgradeManifestError", {
  reason: Schema.Literals(["schema", "duplicate_asset_name", "duplicate_target"]),
}) {
  override readonly message = "The CLI upgrade manifest is malformed";
}

export class InvalidUpgradeSignatureError extends Schema.TaggedError<InvalidUpgradeSignatureError>(
  "InvalidUpgradeSignatureError",
)("InvalidUpgradeSignatureError", {
  reason: Schema.Literals(["invalid_public_key", "invalid_signature"]),
}) {
  override readonly message = "The CLI upgrade manifest signature is invalid";
}

export class UpgradeCryptoError extends Schema.TaggedError<UpgradeCryptoError>(
  "UpgradeCryptoError",
)("UpgradeCryptoError", {
  operation: Schema.Literals(["import_public_key", "verify_signature", "sha256"]),
  cause: Schema.Unknown,
}) {
  override readonly message = "CLI upgrade cryptography failed";
}

export class UpgradeTargetNotFoundError extends Schema.TaggedError<UpgradeTargetNotFoundError>(
  "UpgradeTargetNotFoundError",
)("UpgradeTargetNotFoundError", UpgradeTargetSchema) {
  override readonly message = "The CLI upgrade manifest has no asset for this target";
}

export class InvalidUpgradeDigestError extends Schema.TaggedError<InvalidUpgradeDigestError>(
  "InvalidUpgradeDigestError",
)("InvalidUpgradeDigestError", {
  expectedSha256: Sha256Schema,
  actualSha256: Sha256Schema,
}) {
  override readonly message = "The downloaded CLI upgrade asset digest is invalid";
}

const decodeUpgradeManifest = Schema.decodeUnknownEffect(UpgradeManifestSchema, {
  onExcessProperty: "error",
});

const textEncoder = new TextEncoder();

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareAssets = (left: UpgradeAsset, right: UpgradeAsset): number =>
  compareText(left.platform, right.platform) ||
  compareText(left.architecture, right.architecture) ||
  compareText(left.name, right.name) ||
  compareText(left.sha256, right.sha256);

const encodeLengthPrefixedFields = (fields: ReadonlyArray<Uint8Array>): Uint8Array => {
  const length = fields.reduce((total, field) => total + LENGTH_PREFIX_BYTES + field.byteLength, 0);
  const output = new Uint8Array(length);
  const view = new DataView(output.buffer);
  let offset = 0;

  for (const field of fields) {
    view.setUint32(offset, field.byteLength, false);
    offset += LENGTH_PREFIX_BYTES;
    output.set(field, offset);
    offset += field.byteLength;
  }

  return output;
};

/** Bytes signed by the release process and verified by the CLI. */
export const canonicalUpgradeManifestBytes = (manifest: UpgradeManifestPayload): Uint8Array => {
  const assets = [...manifest.assets].sort(compareAssets);
  const fields = [
    UPGRADE_MANIFEST_SIGNING_CONTEXT,
    String(manifest.version),
    manifest.releaseTag,
    String(assets.length),
    ...assets.flatMap((asset) => [asset.platform, asset.architecture, asset.name, asset.sha256]),
  ].map((field) => textEncoder.encode(field));

  return encodeLengthPrefixedFields(fields);
};

const targetKey = (target: UpgradeTarget): string =>
  `${target.platform}\u0000${target.architecture}`;

const validateUniqueAssets = Effect.fnUntraced(function* (manifest: UpgradeManifest) {
  const names = new Set<string>();
  const targets = new Set<string>();

  for (const asset of manifest.assets) {
    if (names.has(asset.name)) {
      return yield* new MalformedUpgradeManifestError({ reason: "duplicate_asset_name" });
    }
    names.add(asset.name);

    const target = targetKey(asset);
    if (targets.has(target)) {
      return yield* new MalformedUpgradeManifestError({ reason: "duplicate_target" });
    }
    targets.add(target);
  }
});

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const decodeSignature = (signature: string): Uint8Array => {
  const binary = atob(signature);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const bytesToHex = (bytes: Uint8Array): string => {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
};

/** Strictly decodes and authenticates release metadata before it can select an asset. */
export const verifyUpgradeManifest = Effect.fnUntraced(function* (options: {
  readonly manifest: unknown;
  readonly trustedManifestPublicKey: Uint8Array;
}) {
  const manifest = yield* decodeUpgradeManifest(options.manifest).pipe(
    Effect.mapError(() => new MalformedUpgradeManifestError({ reason: "schema" })),
  );
  yield* validateUniqueAssets(manifest);

  if (options.trustedManifestPublicKey.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
    return yield* new InvalidUpgradeSignatureError({ reason: "invalid_public_key" });
  }

  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    return yield* new UpgradeCryptoError({
      operation: "import_public_key",
      cause: "globalThis.crypto.subtle is unavailable",
    });
  }

  const publicKey = yield* Effect.tryPromise({
    try: () =>
      subtle.importKey("raw", toArrayBuffer(options.trustedManifestPublicKey), "Ed25519", false, [
        "verify",
      ]),
    catch: (cause) => new UpgradeCryptoError({ operation: "import_public_key", cause }),
  });
  const valid = yield* Effect.tryPromise({
    try: () =>
      subtle.verify(
        "Ed25519",
        publicKey,
        toArrayBuffer(decodeSignature(manifest.signature)),
        toArrayBuffer(canonicalUpgradeManifestBytes(manifest)),
      ),
    catch: (cause) => new UpgradeCryptoError({ operation: "verify_signature", cause }),
  });

  if (!valid) {
    return yield* new InvalidUpgradeSignatureError({ reason: "invalid_signature" });
  }
  return manifest;
});

/** Selects the one signed GitHub release asset for the current CLI target. */
export const selectUpgradeAsset = (
  manifest: UpgradeManifest,
  target: UpgradeTarget,
): Effect.Effect<UpgradeAsset, UpgradeTargetNotFoundError> => {
  const asset = manifest.assets.find(
    (candidate) =>
      candidate.platform === target.platform && candidate.architecture === target.architecture,
  );
  return asset === undefined
    ? Effect.fail(new UpgradeTargetNotFoundError(target))
    : Effect.succeed(asset);
};

/** Verifies caller-supplied asset bytes without reading from the network or filesystem. */
export const verifyUpgradeAsset = Effect.fnUntraced(function* (
  asset: UpgradeAsset,
  assetBytes: Uint8Array,
) {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    return yield* new UpgradeCryptoError({
      operation: "sha256",
      cause: "globalThis.crypto.subtle is unavailable",
    });
  }

  const digest = yield* Effect.tryPromise({
    try: () => subtle.digest("SHA-256", toArrayBuffer(assetBytes)),
    catch: (cause) => new UpgradeCryptoError({ operation: "sha256", cause }),
  });
  const actualSha256 = bytesToHex(new Uint8Array(digest));
  if (actualSha256 !== asset.sha256) {
    return yield* new InvalidUpgradeDigestError({
      expectedSha256: asset.sha256,
      actualSha256,
    });
  }
});
