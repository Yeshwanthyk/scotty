import { Context, Data, Effect, Layer, Option, Result, Schema } from "effect";
import type { PiSettings, SandboxToolCommand } from "../../protocol/sandbox-config";
import { sha256BytesHex } from "./digest";
import { validateSandboxArchive } from "./sandbox-archive";
import { SandboxBundleStore, type SandboxBundleFailure } from "./sandbox-bundle-store";
import {
  DeployedSnapshotSchema,
  DigestSchema,
  type DeployedPlugin,
} from "./sandbox-config-contracts";
import { SandboxRuntime, shellQuote, type SandboxRuntimeFailure } from "./sandbox-runtime";
import { sessionRoot } from "./workspace";

export const SANDBOX_BUNDLE_MANIFEST_VERSION = 1;

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
  readonly revision: number;
  readonly digest: string;
  readonly pi: PiSettings;
  readonly extensionPaths: ReadonlyArray<string>;
  readonly skillPaths: ReadonlyArray<{ readonly name: string; readonly path: string }>;
  readonly toolCommands: ReadonlyArray<SandboxToolCommand & { readonly path: string }>;
  readonly bundleRoot: string;
}

interface MaterializeInput {
  readonly sessionId: string;
  readonly revision: number;
  readonly digest: string;
}

const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(DeployedSnapshotSchema), {
  onExcessProperty: "error",
});

const VerifiedMarkerSchema = Schema.Struct({
  snapshotDigest: DigestSchema,
  snapshotRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  pluginBundleDigest: DigestSchema,
});
const decodeVerifiedMarker = Schema.decodeUnknownOption(
  Schema.fromJsonString(VerifiedMarkerSchema),
  {
    onExcessProperty: "error",
  },
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
const stagingNonce = (): string => crypto.randomUUID().replaceAll("-", "").slice(0, 8);

const materializationFailure = (
  reason: SandboxBundleMaterializationFailureReason,
): SandboxBundleMaterializationFailure =>
  new SandboxBundleMaterializationFailure({
    reason,
    message:
      reason === "missing"
        ? "Pinned Sandbox snapshot input is missing"
        : reason === "digest_mismatch"
          ? "Pinned Sandbox snapshot input digest does not match"
          : reason === "too_large"
            ? "Pinned Sandbox snapshot input exceeds the size limit"
            : reason === "runtime"
              ? "Sandbox snapshot materialization runtime failed"
              : reason === "upstream"
                ? "Sandbox snapshot storage failed"
                : "Sandbox snapshot input is invalid",
  });

const mapStoreFailure = (error: SandboxBundleFailure): SandboxBundleMaterializationFailure =>
  materializationFailure(
    error.reason === "missing"
      ? "missing"
      : error.reason === "metadata_mismatch"
        ? "digest_mismatch"
        : error.reason === "too_large"
          ? "too_large"
          : "upstream",
  );

const mapRuntimeFailure = (_error: SandboxRuntimeFailure): SandboxBundleMaterializationFailure =>
  materializationFailure("runtime");

const readVerifiedMarker = Effect.fnUntraced(function* (
  runtime: SandboxRuntime["Service"],
  root: string,
) {
  const bytes = yield* runtime
    .readFile(verifiedMarkerPath(root), 4_096)
    .pipe(Effect.catchTag("SandboxRuntimeFailure", () => Effect.succeed(undefined)));
  if (bytes === undefined) return undefined;
  return decodeVerifiedMarker(new TextDecoder().decode(bytes)).pipe(Option.getOrUndefined);
});

const writeArchiveMembers = Effect.fnUntraced(function* (
  runtime: SandboxRuntime["Service"],
  stagingRoot: string,
  members: ReadonlyArray<{
    readonly path: string;
    readonly type: "file" | "directory";
    readonly bytes: Uint8Array;
  }>,
) {
  for (const member of members) {
    const target = `${stagingRoot}/${member.path}`;
    if (member.type === "directory") {
      yield* runtime.mkdir(target, { recursive: true });
      continue;
    }
    const parent = target.slice(0, target.lastIndexOf("/"));
    if (parent.length > stagingRoot.length) yield* runtime.mkdir(parent, { recursive: true });
    yield* runtime.writeFile(target, member.bytes);
  }
});

const pluginById = (
  plugins: ReadonlyArray<DeployedPlugin>,
  id: string,
  type: DeployedPlugin["type"],
): DeployedPlugin | undefined => plugins.find((plugin) => plugin.id === id && plugin.type === type);

const materializedFromSnapshot = (
  sessionId: string,
  digest: string,
  snapshot: typeof DeployedSnapshotSchema.Type,
): Result.Result<MaterializedSandboxBundle, SandboxBundleMaterializationFailure> => {
  const root = sandboxBundleRoot(sessionId, digest);
  const extensionPaths: string[] = [
    "/opt/scotty/pi-packages/sources/scotty-browser-test/index.ts",
    "/opt/scotty/pi-packages/sources/scotty-hatch/index.ts",
  ];
  const skillPaths: Array<{ readonly name: string; readonly path: string }> = [];
  const toolCommands: Array<SandboxToolCommand & { readonly path: string }> = [];
  for (const id of snapshot.sandboxSetup.piExtensions) {
    const plugin = pluginById(snapshot.plugins, id, "pi-extension");
    if (plugin?.type !== "pi-extension")
      return Result.fail(materializationFailure("invalid_archive"));
    const base =
      plugin.source.kind === "builtin"
        ? "/opt/scotty/pi-packages/sources/pi-subagents"
        : `${root}/plugins/${plugin.id}`;
    extensionPaths.push(
      ...plugin.manifest.entrypoints.map((entrypoint) => `${base}/${entrypoint}`),
    );
  }
  for (const id of snapshot.sandboxSetup.skills) {
    const plugin = pluginById(snapshot.plugins, id, "skill");
    if (plugin?.type !== "skill") return Result.fail(materializationFailure("invalid_archive"));
    skillPaths.push({
      name: plugin.manifest.name,
      path:
        plugin.source.kind === "builtin"
          ? "/opt/scotty/pi-packages/sources/pi-subagents/skills/subagents"
          : `${root}/plugins/${plugin.id}`,
    });
  }
  for (const id of snapshot.sandboxSetup.sandboxTools) {
    const plugin = pluginById(snapshot.plugins, id, "sandbox-tool");
    if (plugin?.type !== "sandbox-tool")
      return Result.fail(materializationFailure("invalid_archive"));
    if (plugin.source.kind === "builtin") continue;
    toolCommands.push(
      ...plugin.manifest.commands.map((command) => ({
        ...command,
        path: `${root}/plugins/${plugin.id}/${command.path}`,
      })),
    );
  }
  return Result.succeed({
    revision: snapshot.revision,
    digest,
    pi: snapshot.pi,
    extensionPaths,
    skillPaths,
    toolCommands,
    bundleRoot: root,
  });
};

const materializeSnapshot = Effect.fnUntraced(function* (
  runtime: SandboxRuntime["Service"],
  store: SandboxBundleStore["Service"],
  input: MaterializeInput,
) {
  const storedSnapshot = yield* store
    .getSnapshot(input.digest)
    .pipe(Effect.mapError(mapStoreFailure));
  const computed = yield* Effect.tryPromise({
    try: () =>
      sha256BytesHex(new TextEncoder().encode(storedSnapshot.snapshotJson)).then(
        (hex) => `sha256:${hex}`,
      ),
    catch: () => materializationFailure("digest_mismatch"),
  });
  if (computed !== input.digest) return yield* materializationFailure("digest_mismatch");
  const snapshot = yield* decodeSnapshot(storedSnapshot.snapshotJson).pipe(
    Effect.mapError(() => materializationFailure("invalid_archive")),
  );
  if (
    snapshot.revision !== input.revision ||
    snapshot.pluginBundleDigest !== storedSnapshot.pluginBundleDigest
  )
    return yield* materializationFailure("digest_mismatch");
  const finalRoot = sandboxBundleRoot(input.sessionId, input.digest);
  const existing = yield* readVerifiedMarker(runtime, finalRoot);
  if (
    existing?.snapshotDigest === input.digest &&
    existing.snapshotRevision === input.revision &&
    existing.pluginBundleDigest === snapshot.pluginBundleDigest
  )
    return yield* Effect.fromResult(
      materializedFromSnapshot(input.sessionId, input.digest, snapshot),
    );
  if (existing !== undefined) return yield* materializationFailure("digest_mismatch");

  const bundle = yield* store
    .getPluginBundle(snapshot.pluginBundleDigest)
    .pipe(Effect.mapError(mapStoreFailure));
  const validated = yield* validateSandboxArchive(
    bundle.gzipBytes,
    snapshot.pluginBundleDigest,
  ).pipe(Effect.mapError(() => materializationFailure("invalid_archive")));
  const stagingRoot = sandboxBundleStagingRoot(input.sessionId, stagingNonce());
  yield* runtime.mkdir(stagingRoot, { recursive: true });
  yield* writeArchiveMembers(runtime, stagingRoot, validated.members);
  yield* runtime.writeFile(
    verifiedMarkerPath(stagingRoot),
    `${JSON.stringify({
      snapshotDigest: input.digest,
      snapshotRevision: input.revision,
      pluginBundleDigest: snapshot.pluginBundleDigest,
    })}\n`,
  );
  yield* runtime.execChecked(`chmod -R a-w ${shellQuote(stagingRoot)}`);
  yield* runtime.execChecked(
    `test ! -e ${shellQuote(finalRoot)} && mv ${shellQuote(stagingRoot)} ${shellQuote(finalRoot)}`,
  );
  return yield* Effect.fromResult(
    materializedFromSnapshot(input.sessionId, input.digest, snapshot),
  );
});

export const sandboxBundleMaterializerLayer = Layer.effect(
  SandboxBundleMaterializer,
  Effect.gen(function* () {
    const runtime = yield* SandboxRuntime;
    const store = yield* SandboxBundleStore;
    return SandboxBundleMaterializer.of({
      materialize: (input) =>
        materializeSnapshot(runtime, store, input).pipe(
          Effect.catchTag("SandboxRuntimeFailure", mapRuntimeFailure),
        ),
    });
  }),
);
