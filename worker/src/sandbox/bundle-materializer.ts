import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import { SANDBOX_MAX_FILE_BYTES, SANDBOX_MAX_UNCOMPRESSED_BYTES } from "./archive";
import { SandboxBundleStore, type SandboxBundleFailure } from "./bundle-store";
import {
  SandboxBundleManifestSchema,
  SandboxDigestSchema,
  type SandboxBundleItemKind,
  type SandboxBundleManifest,
} from "./config-contracts";
import { SandboxRuntime, shellQuote, type SandboxRuntimeFailure } from "./runtime";
import { sessionRoot } from "./workspace";

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
  items: manifest.items.map(({ kind, name }) => ({ kind, name })),
  bundleRoot: sandboxBundleRoot(sessionId, digest),
});

const decodeMaterializedManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SandboxBundleManifestSchema),
  { onExcessProperty: "error" },
);

const VerifiedMarkerSchema = Schema.Struct({
  digest: SandboxDigestSchema,
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

const verifiedMarkerText = (digest: string): string => `${JSON.stringify({ digest })}\n`;

const stagingNonce = (): string => crypto.randomUUID().replaceAll("-", "").slice(0, 8);

const materializationMessage = (reason: SandboxBundleMaterializationFailureReason): string => {
  if (reason === "missing") return "Sandbox bundle is missing";
  if (reason === "digest_mismatch") return "Sandbox bundle archive digest does not match";
  if (reason === "too_large") return "Sandbox bundle exceeds the size limit";
  if (reason === "runtime") return "Sandbox bundle materialization runtime failed";
  if (reason === "upstream") return "Sandbox bundle storage failed";
  return "Sandbox bundle archive is invalid";
};

const archiveFailure = (
  reason: Extract<
    SandboxBundleMaterializationFailureReason,
    "digest_mismatch" | "invalid_archive" | "too_large"
  >,
): SandboxBundleMaterializationFailure =>
  new SandboxBundleMaterializationFailure({
    reason,
    message: materializationMessage(reason),
  });

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
  digest: string,
  archive: ReadableStream<Uint8Array>,
) {
  const archivePath = `${stagingRoot}.tar.gz`;
  const tarPath = `${stagingRoot}.tar`;
  const cleanup = runtime
    .exec(`rm -rf ${shellQuote(stagingRoot)} ${shellQuote(archivePath)} ${shellQuote(tarPath)}`)
    .pipe(Effect.ignore);
  const extract = Effect.gen(function* () {
    yield* runtime.mkdir(stagingRoot, { recursive: true });
    yield* runtime.writeFile(archivePath, archive);
    yield* runtime.execChecked(
      `gzip -dc ${shellQuote(archivePath)} | head -c ${SANDBOX_MAX_UNCOMPRESSED_BYTES + 1} > ${shellQuote(tarPath)}`,
    );
    const bounded = yield* runtime.exec(
      `test "$(wc -c < ${shellQuote(tarPath)})" -le ${SANDBOX_MAX_UNCOMPRESSED_BYTES}`,
    );
    if (!bounded.success) return yield* archiveFailure("too_large");
    const gzip = yield* runtime.exec(`gzip -t ${shellQuote(archivePath)}`);
    if (!gzip.success) return yield* archiveFailure("invalid_archive");
    // Upload validation owns the full archive/manifest contract. The immutable R2 object is safe to
    // extract only after its uncompressed TAR matches that content-addressed digest exactly.
    const matchesDigest = yield* runtime.exec(
      `printf '%s  %s\\n' ${shellQuote(digest)} ${shellQuote(tarPath)} | sha256sum --check --strict`,
    );
    if (!matchesDigest.success) return yield* archiveFailure("digest_mismatch");
    const validTar = yield* runtime.exec(`tar -tf ${shellQuote(tarPath)} >/dev/null`);
    if (!validTar.success) return yield* archiveFailure("invalid_archive");
    const ordinaryMembers = yield* runtime.exec(
      `tar -tvf ${shellQuote(tarPath)} | awk 'substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { exit 1 }'`,
    );
    if (!ordinaryMembers.success) return yield* archiveFailure("invalid_archive");
    const extracted = yield* runtime.exec(
      `tar -xf ${shellQuote(tarPath)} -C ${shellQuote(stagingRoot)}`,
    );
    if (!extracted.success) return yield* archiveFailure("invalid_archive");
    yield* runtime.execChecked(`rm -f ${shellQuote(archivePath)} ${shellQuote(tarPath)}`);
  });
  return yield* extract.pipe(Effect.tapError(() => cleanup));
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
  const stagingRoot = sandboxBundleStagingRoot(sessionId, stagingNonce());
  yield* extractValidatedArchive(runtime, stagingRoot, digest, bundle.gzipStream);
  const manifestBytes = yield* runtime.readFile(
    `${stagingRoot}/manifest.json`,
    SANDBOX_MAX_FILE_BYTES,
  );
  const manifest = yield* decodeMaterializedManifest(new TextDecoder().decode(manifestBytes)).pipe(
    Effect.mapError(() => archiveFailure("invalid_archive")),
  );
  yield* runtime.writeFile(verifiedMarkerPath(stagingRoot), verifiedMarkerText(digest));
  yield* promoteStagingTree(runtime, stagingRoot, finalRoot);
  return materializedFromManifest(sessionId, digest, manifest);
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
