import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import {
  SANDBOX_MAX_FILE_BYTES,
  SandboxArchiveInvalid,
  validateSandboxArchive,
} from "./sandbox-archive";
import { SandboxBundleStore, type SandboxBundleFailure } from "./sandbox-bundle-store";
import {
  SandboxBundleManifestSchema,
  SandboxDigestSchema,
  type SandboxBundleItemKind,
  type SandboxBundleManifest,
} from "./sandbox-config-contracts";
import { SandboxRuntime, shellQuote, type SandboxRuntimeFailure } from "./sandbox-runtime";
import { sessionRoot } from "./workspace";

export const SANDBOX_BUNDLE_MANIFEST_VERSION = 2;

export type SandboxBundleMaterializationFailureReason =
  | "missing"
  | "invalid_archive"
  | "digest_mismatch"
  | "too_large"
  | "runtime"
  | "upstream";

export class SandboxBundleMaterializationFailure extends Data.TaggedError(
  "SandboxBundleMaterializationFailure",
)<{
  readonly reason: SandboxBundleMaterializationFailureReason;
  readonly message: string;
}> {}

export interface MaterializedSandboxBundle {
  readonly digest: string | null;
  readonly items: ReadonlyArray<{
    readonly kind: SandboxBundleItemKind;
    readonly name: string;
  }>;
  readonly bundleRoot: string | undefined;
}

interface MaterializeInput {
  readonly sessionId: string;
  readonly digest: string | null;
}

const emptyMaterialized = (digest: null): MaterializedSandboxBundle => ({
  digest,
  items: [],
  bundleRoot: undefined,
});

const materializedFromManifest = (
  sessionId: string,
  digest: string,
  manifest: SandboxBundleManifest,
): MaterializedSandboxBundle => ({
  digest,
  items:
    manifest.schemaVersion === 1
      ? [
          ...manifest.skills.map((item) => ({ kind: "skill" as const, name: item.name })),
          ...manifest.piPackages.map((item) => ({ kind: "package" as const, name: item.name })),
        ]
      : manifest.items.map(({ kind, name }) => ({ kind, name })),
  bundleRoot: sandboxBundleRoot(sessionId, digest),
});

const decodeMaterializedManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SandboxBundleManifestSchema),
  { onExcessProperty: "error" },
);

const VerifiedMarkerSchema = Schema.Struct({
  digest: SandboxDigestSchema,
  manifestVersion: Schema.Literals([1, SANDBOX_BUNDLE_MANIFEST_VERSION]),
});

const decodeVerifiedMarker = Schema.decodeUnknownOption(
  Schema.fromJsonString(VerifiedMarkerSchema),
  { onExcessProperty: "error" },
);

interface SandboxBundleMaterializerShape {
  readonly materialize: (
    input: MaterializeInput,
  ) => Effect.Effect<MaterializedSandboxBundle, SandboxBundleMaterializationFailure>;
}

export class SandboxBundleMaterializer extends Context.Service<
  SandboxBundleMaterializer,
  SandboxBundleMaterializerShape
>()("scotty/SandboxBundleMaterializer") {}

export const sandboxBundleRoot = (sessionId: string, digest: string): string =>
  `${sessionRoot(sessionId)}/.scotty/sandbox/${digest}`;

export const sandboxBundleStagingRoot = (sessionId: string, nonce: string): string =>
  `${sessionRoot(sessionId)}/.scotty/sandbox/.staging-${nonce}`;

const verifiedMarkerPath = (root: string): string => `${root}/.verified`;

const verifiedMarkerText = (digest: string): string =>
  `${JSON.stringify({ digest, manifestVersion: SANDBOX_BUNDLE_MANIFEST_VERSION })}\n`;

const stagingNonce = (): string => crypto.randomUUID().replaceAll("-", "").slice(0, 8);

const materializationMessage = (reason: SandboxBundleMaterializationFailureReason): string => {
  if (reason === "missing") return "Sandbox bundle is missing";
  if (reason === "digest_mismatch") return "Sandbox bundle archive digest does not match";
  if (reason === "too_large") return "Sandbox bundle exceeds the size limit";
  if (reason === "runtime") return "Sandbox bundle materialization runtime failed";
  if (reason === "upstream") return "Sandbox bundle storage failed";
  return "Sandbox bundle archive is invalid";
};

const archiveFailureReason = (
  error: SandboxArchiveInvalid,
): SandboxBundleMaterializationFailureReason => {
  // oxlint-disable scotty/no-unknown-error-message -- SandboxArchiveInvalid owns the archive validation message used to classify materialization failures
  const message = error.message;
  // oxlint-enable scotty/no-unknown-error-message
  if (message.includes("digest does not match")) return "digest_mismatch";
  if (message.includes("size limit")) return "too_large";
  return "invalid_archive";
};

const mapArchiveFailure = (error: SandboxArchiveInvalid): SandboxBundleMaterializationFailure => {
  const reason = archiveFailureReason(error);
  return new SandboxBundleMaterializationFailure({
    reason,
    message: materializationMessage(reason),
  });
};

const mapStoreFailure = (error: SandboxBundleFailure): SandboxBundleMaterializationFailure => {
  const reason: SandboxBundleMaterializationFailureReason =
    error.reason === "missing"
      ? "missing"
      : error.reason === "metadata_mismatch"
        ? "digest_mismatch"
        : error.reason === "too_large"
          ? "too_large"
          : "upstream";
  return new SandboxBundleMaterializationFailure({
    reason,
    message: materializationMessage(reason),
  });
};

const mapRuntimeFailure = (_error: SandboxRuntimeFailure): SandboxBundleMaterializationFailure =>
  new SandboxBundleMaterializationFailure({
    reason: "runtime",
    message: materializationMessage("runtime"),
  });

const readVerifiedMarker = Effect.fnUntraced(function* (
  runtime: SandboxRuntime["Service"],
  root: string,
) {
  const markerPath = verifiedMarkerPath(root);
  const bytes = yield* runtime
    .readFile(markerPath, 4_096)
    .pipe(Effect.catchTag("SandboxRuntimeFailure", () => Effect.succeed(undefined)));
  if (bytes === undefined) return undefined;
  return decodeVerifiedMarker(new TextDecoder().decode(bytes)).pipe(Option.getOrUndefined);
});

const extractValidatedArchive = Effect.fnUntraced(function* (
  runtime: SandboxRuntime["Service"],
  stagingRoot: string,
  archive: Uint8Array,
) {
  const archivePath = `${stagingRoot}.tar.gz`;
  yield* runtime.mkdir(stagingRoot, { recursive: true });
  yield* runtime.writeFile(archivePath, archive);
  yield* runtime.execChecked(
    `tar -xzf ${shellQuote(archivePath)} -C ${shellQuote(stagingRoot)} && rm -f ${shellQuote(archivePath)}`,
  );
});

const promoteStagingTree = Effect.fnUntraced(function* (
  runtime: SandboxRuntime["Service"],
  stagingRoot: string,
  finalRoot: string,
) {
  yield* runtime.execChecked(`chmod -R a-w ${shellQuote(stagingRoot)}`);
  yield* runtime.execChecked(
    `rm -rf ${shellQuote(finalRoot)} && mv ${shellQuote(stagingRoot)} ${shellQuote(finalRoot)}`,
  );
});

const materializeDigest = Effect.fnUntraced(function* (
  runtime: SandboxRuntime["Service"],
  store: SandboxBundleStore["Service"],
  sessionId: string,
  digest: string,
) {
  const finalRoot = sandboxBundleRoot(sessionId, digest);
  const existing = yield* readVerifiedMarker(runtime, finalRoot);
  if (existing?.digest === digest) {
    const manifestBytes = yield* runtime.readFile(
      `${finalRoot}/manifest.json`,
      SANDBOX_MAX_FILE_BYTES,
    );
    const manifest = yield* decodeMaterializedManifest(
      new TextDecoder().decode(manifestBytes),
    ).pipe(
      Effect.mapError(
        () =>
          new SandboxBundleMaterializationFailure({
            reason: "invalid_archive",
            message: materializationMessage("invalid_archive"),
          }),
      ),
    );
    return materializedFromManifest(sessionId, digest, manifest);
  }

  const bundle = yield* store.getBundle(digest).pipe(Effect.mapError(mapStoreFailure));
  const validated = yield* validateSandboxArchive(bundle.gzipBytes, digest).pipe(
    Effect.mapError(mapArchiveFailure),
  );

  const stagingRoot = sandboxBundleStagingRoot(sessionId, stagingNonce());
  yield* extractValidatedArchive(runtime, stagingRoot, bundle.gzipBytes);
  yield* runtime.writeFile(verifiedMarkerPath(stagingRoot), verifiedMarkerText(validated.digest));
  yield* promoteStagingTree(runtime, stagingRoot, finalRoot);
  return materializedFromManifest(sessionId, validated.digest, validated.manifest);
});

export const sandboxBundleMaterializerLayer = Layer.effect(
  SandboxBundleMaterializer,
  Effect.gen(function* () {
    const runtime = yield* SandboxRuntime;
    const store = yield* SandboxBundleStore;
    return SandboxBundleMaterializer.of({
      materialize: Effect.fnUntraced(function* (input: MaterializeInput) {
        if (input.digest === null) return emptyMaterialized(null);
        return yield* materializeDigest(runtime, store, input.sessionId, input.digest).pipe(
          Effect.catchTag("SandboxRuntimeFailure", mapRuntimeFailure),
        );
      }),
    });
  }),
);
