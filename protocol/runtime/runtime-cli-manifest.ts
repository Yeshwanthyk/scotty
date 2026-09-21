import { Effect, Schema } from "effect";

export const RUNTIME_CLI_SIGNING_CONTEXT = "scotty-runtime-cli-manifest-v1";
export const RUNTIME_CLI_ASSET_NAME = "scotty-runtime-linux-amd64";
export const RUNTIME_CLI_COMPILE_TARGET = "bun-linux-x64-baseline";

// Existing raw Ed25519 release trust root. Tests replace only the Web Crypto import boundary.
const SCOTTY_RELEASE_PUBLIC_KEY_BASE64 = "b+jhy/AX9PzwFWofyVVPDg/FR8YLVJ9FGIAAJVVPpPE=";
const LENGTH_PREFIX_BYTES = 4;
const textEncoder = new TextEncoder();

const SemverSchema = Schema.String.check(
  Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u),
);
const ReleaseTagSchema = Schema.String.check(
  Schema.isPattern(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u),
);
const RevisionSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const Sha256Schema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const PositiveSafeIntegerSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const CloudflareSandboxImageSchema = Schema.String.check(
  Schema.isPattern(/^docker\.io\/cloudflare\/sandbox:[^\s@]+@sha256:[0-9a-f]{64}$/u),
);
const CanonicalEd25519SignatureSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    if (!/^[A-Za-z0-9+/]{86}==$/u.test(value)) return false;
    const decoded = atob(value);
    return decoded.length === 64 && btoa(decoded) === value;
  }),
);

export const RuntimeCliArtifactSchema = Schema.Struct({
  name: Schema.Literal(RUNTIME_CLI_ASSET_NAME),
  cliVersion: SemverSchema,
  revision: RevisionSchema,
  target: Schema.Literal("linux/amd64"),
  byteSize: PositiveSafeIntegerSchema,
  sha256: Sha256Schema,
  installMode: Schema.Literal("0755"),
});
export type RuntimeCliArtifact = typeof RuntimeCliArtifactSchema.Type;

export const RuntimeCliCompatibilitySchema = Schema.Struct({
  bunVersion: SemverSchema,
  compileTarget: Schema.Literal(RUNTIME_CLI_COMPILE_TARGET),
  cpu: Schema.Literal("x86-64-baseline"),
  libc: Schema.Literal("glibc"),
  cloudflareSandbox: Schema.Struct({
    packageVersion: SemverSchema,
    image: CloudflareSandboxImageSchema,
  }).check(
    Schema.makeFilter(
      ({ packageVersion, image }) =>
        image.startsWith(`docker.io/cloudflare/sandbox:${packageVersion}@sha256:`),
      { expected: "a digest-pinned Cloudflare Sandbox image matching its package version" },
    ),
  ),
});
export type RuntimeCliCompatibility = typeof RuntimeCliCompatibilitySchema.Type;

const RuntimeCliArtifactDescriptorFields = {
  schemaVersion: Schema.Literal(1),
  releaseTag: ReleaseTagSchema,
  artifact: RuntimeCliArtifactSchema,
  compatibility: RuntimeCliCompatibilitySchema,
};
const RuntimeCliArtifactDescriptorStruct = Schema.Struct(RuntimeCliArtifactDescriptorFields);
const hasMatchingCliVersion = Schema.makeFilter(
  ({ releaseTag, artifact }: typeof RuntimeCliArtifactDescriptorStruct.Type) =>
    releaseTag === `v${artifact.cliVersion}`,
  { expected: "a release tag matching the runtime CLI version" },
);

export const RuntimeCliArtifactDescriptorSchema =
  RuntimeCliArtifactDescriptorStruct.check(hasMatchingCliVersion);
export type RuntimeCliArtifactDescriptor = typeof RuntimeCliArtifactDescriptorSchema.Type;

export const RuntimeCliManifestSchema = Schema.Struct({
  ...RuntimeCliArtifactDescriptorFields,
  signature: CanonicalEd25519SignatureSchema,
}).check(hasMatchingCliVersion);
export type RuntimeCliManifest = typeof RuntimeCliManifestSchema.Type;

export class MalformedRuntimeCliManifestError extends Schema.TaggedError<MalformedRuntimeCliManifestError>(
  "MalformedRuntimeCliManifestError",
)("MalformedRuntimeCliManifestError", {}) {
  override readonly message = "The runtime CLI manifest is malformed";
}

export class InvalidRuntimeCliManifestSignatureError extends Schema.TaggedError<InvalidRuntimeCliManifestSignatureError>(
  "InvalidRuntimeCliManifestSignatureError",
)("InvalidRuntimeCliManifestSignatureError", {}) {
  override readonly message = "The runtime CLI manifest signature is invalid";
}

export class RuntimeCliManifestCryptoError extends Schema.TaggedError<RuntimeCliManifestCryptoError>(
  "RuntimeCliManifestCryptoError",
)("RuntimeCliManifestCryptoError", {
  operation: Schema.Literals(["import_public_key", "verify_signature"]),
  cause: Schema.Unknown,
}) {
  override readonly message = "Runtime CLI manifest cryptography failed";
}

const decodeRuntimeCliManifest = Schema.decodeUnknownEffect(RuntimeCliManifestSchema, {
  onExcessProperty: "error",
});

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

/** Exact field order and framing authenticated by the runtime release signer. */
export const canonicalRuntimeCliManifestBytes = (
  descriptor: RuntimeCliArtifactDescriptor,
): Uint8Array =>
  encodeLengthPrefixedFields(
    [
      RUNTIME_CLI_SIGNING_CONTEXT,
      String(descriptor.schemaVersion),
      descriptor.releaseTag,
      descriptor.artifact.name,
      descriptor.artifact.cliVersion,
      descriptor.artifact.revision,
      descriptor.artifact.target,
      String(descriptor.artifact.byteSize),
      descriptor.artifact.sha256,
      descriptor.artifact.installMode,
      descriptor.compatibility.bunVersion,
      descriptor.compatibility.compileTarget,
      descriptor.compatibility.cpu,
      descriptor.compatibility.libc,
      descriptor.compatibility.cloudflareSandbox.packageVersion,
      descriptor.compatibility.cloudflareSandbox.image,
    ].map((field) => textEncoder.encode(field)),
  );

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const trustedManifestPublicKey = decodeBase64(SCOTTY_RELEASE_PUBLIC_KEY_BASE64);

/**
 * Strictly decodes and authenticates one runtime CLI manifest with Scotty's release trust root.
 * Compatibility is returned as an authenticated claim; this verifier does not assume that custom
 * images are compatible or choose a consumer compatibility policy.
 */
export const verifyRuntimeCliManifest = Effect.fnUntraced(function* (input: unknown) {
  const manifest = yield* decodeRuntimeCliManifest(input).pipe(
    Effect.mapError(() => new MalformedRuntimeCliManifestError({})),
  );
  const subtle = typeof crypto === "undefined" ? undefined : crypto.subtle;
  if (subtle === undefined) {
    return yield* new RuntimeCliManifestCryptoError({
      operation: "import_public_key",
      cause: "globalThis.crypto.subtle is unavailable",
    });
  }
  const publicKey = yield* Effect.tryPromise({
    try: () =>
      subtle.importKey("raw", toArrayBuffer(trustedManifestPublicKey), "Ed25519", false, [
        "verify",
      ]),
    catch: (cause) => new RuntimeCliManifestCryptoError({ operation: "import_public_key", cause }),
  });
  const valid = yield* Effect.tryPromise({
    try: () =>
      subtle.verify(
        "Ed25519",
        publicKey,
        toArrayBuffer(decodeBase64(manifest.signature)),
        toArrayBuffer(canonicalRuntimeCliManifestBytes(manifest)),
      ),
    catch: (cause) => new RuntimeCliManifestCryptoError({ operation: "verify_signature", cause }),
  });
  if (!valid) return yield* new InvalidRuntimeCliManifestSignatureError({});
  return {
    schemaVersion: manifest.schemaVersion,
    releaseTag: manifest.releaseTag,
    artifact: manifest.artifact,
    compatibility: manifest.compatibility,
  } satisfies RuntimeCliArtifactDescriptor;
});
