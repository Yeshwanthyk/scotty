import { createHash, createHmac } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  SECRET_VALUE_MAX_BYTES,
  SecretOwnerKey,
  SecretSource,
  type SecretSnapshot,
} from "./write-only-secret.ts";

export const CODEX_AUTH_SOURCE_ID = "scotty/codex-auth";
export const GITHUB_TOKEN_SOURCE_ID = "scotty/github-token";
export const SCOTTY_TOKEN_SOURCE_ID = "scotty/http-auth";
export const RETAIN_PREVIOUS_OWNER_KEY = "SCOTTY_RETAIN_PREVIOUS_OWNER_KEY";
export const MAX_PREVIOUS_OWNER_KEYS = 1;

export interface LocalSecretPaths {
  readonly codexAuthPath: string;
  readonly scottyTokenPath?: string;
  readonly rootKeyPath: string;
  readonly recoveryReceiptPath?: string;
  readonly previousRootKeyPaths?: readonly string[];
  readonly expectedUid: number;
}

export class LocalSecretSourceFailure extends Data.TaggedError("LocalSecretSourceFailure")<{
  readonly operation:
    | "configure"
    | "resolve"
    | "read-auth"
    | "read-github"
    | "read-root"
    | "read-scotty"
    | "decode-auth"
    | "decode-github"
    | "decode-root"
    | "decode-scotty"
    | "verify-recovery";
  readonly code:
    | "unknown-source"
    | "open-failed"
    | "not-regular-file"
    | "wrong-owner"
    | "insecure-mode"
    | "value-too-large"
    | "read-failed"
    | "command-failed"
    | "invalid-auth"
    | "invalid-github"
    | "invalid-root"
    | "invalid-scotty"
    | "ci-forbidden"
    | "invalid-path"
    | "recovery-required"
    | "recovery-mismatch"
    | "too-many-previous-keys";
}> {}

const fail = (
  operation: LocalSecretSourceFailure["operation"],
  code: LocalSecretSourceFailure["code"],
): LocalSecretSourceFailure => new LocalSecretSourceFailure({ operation, code });

const NonEmpty = Schema.NonEmptyString;
const ApiKeyAuth = Schema.Struct({ OPENAI_API_KEY: NonEmpty });
const TokenAuth = Schema.Struct({ tokens: Schema.Struct({ access_token: NonEmpty }) });
const CodexAuth = Schema.Union([ApiKeyAuth, TokenAuth]);
const decodeCodexAuth = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexAuth));
const GithubToken = Schema.String.check(Schema.isPattern(/^\S+$/u));
const decodeGithubToken = Schema.decodeUnknownEffect(GithubToken);
const ScottyToken = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64,}$/u));
const decodeScottyToken = Schema.decodeUnknownEffect(ScottyToken);
const RecoveryReceipt = Schema.Struct({
  version: Schema.Literal(1),
  rootKeyFingerprint: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  escrowId: NonEmpty,
});
const decodeRecoveryReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(RecoveryReceipt));

type ReadOperation = "read-auth" | "read-root" | "read-scotty";

const close = (handle: FileHandle, operation: ReadOperation) =>
  Effect.tryPromise({
    try: () => handle.close(),
    catch: () => fail(operation, "read-failed"),
  }).pipe(Effect.ignore);

const readSecureFile = Effect.fnUntraced(function* (
  path: string,
  expectedUid: number,
  maximumBytes: number,
  operation: ReadOperation,
) {
  const handle = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW),
      catch: () => fail(operation, "open-failed"),
    }),
    (handle) => close(handle, operation),
  );
  const stat = yield* Effect.tryPromise({
    try: () => handle.stat(),
    catch: () => fail(operation, "read-failed"),
  });
  if (!stat.isFile()) {
    return yield* fail(operation, "not-regular-file");
  }
  if (stat.uid !== expectedUid) {
    return yield* fail(operation, "wrong-owner");
  }
  if ((stat.mode & 0o777) !== 0o600) {
    return yield* fail(operation, "insecure-mode");
  }
  if (stat.size > maximumBytes) {
    return yield* fail(operation, "value-too-large");
  }
  const bytes = Buffer.alloc(maximumBytes + 1);
  const result = yield* Effect.tryPromise({
    try: () => handle.read(bytes, 0, bytes.length, 0),
    catch: () => fail(operation, "read-failed"),
  });
  if (result.bytesRead > maximumBytes) {
    return yield* fail(operation, "value-too-large");
  }
  return bytes.toString("utf8", 0, result.bytesRead);
});

export interface LocalSecretKeys {
  readonly digestKey: Uint8Array;
  readonly ownerKey: Uint8Array;
}

export const deriveLocalSecretKeys = (root: Uint8Array): LocalSecretKeys => ({
  digestKey: createHmac("sha256", root).update("scotty/digest-v1\0").digest(),
  ownerKey: createHmac("sha256", root).update("scotty/owner-v1\0").digest(),
});

export const keyedSecretDigest = (plaintext: string, digestKey: Uint8Array): string =>
  `hmac-sha256:v1:${createHmac("sha256", digestKey).update(plaintext).digest("hex")}`;

const readRoot = Effect.fnUntraced(function* (config: LocalSecretPaths, rootKeyPath: string) {
  const encoded = yield* readSecureFile(rootKeyPath, config.expectedUid, 64, "read-root").pipe(
    Effect.scoped,
  );
  const root = Buffer.from(encoded, "base64url");
  if (root.length !== 32 || root.toString("base64url") !== encoded) {
    return yield* fail("decode-root", "invalid-root");
  }
  return { root, keys: deriveLocalSecretKeys(root) } as const;
});

const validateGithubToken = (stdout: string) => {
  const plaintext = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (Buffer.byteLength(plaintext) > SECRET_VALUE_MAX_BYTES) {
    return Effect.fail(fail("read-github", "value-too-large"));
  }
  return decodeGithubToken(plaintext).pipe(
    Effect.mapError(() => fail("decode-github", "invalid-github")),
  );
};

const validateScottyToken = (plaintext: string) =>
  decodeScottyToken(plaintext).pipe(Effect.mapError(() => fail("decode-scotty", "invalid-scotty")));

const readGithubToken = Effect.fnUntraced(function* (
  environment: Readonly<Record<string, string | undefined>>,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  const command = ChildProcess.make("gh", ["auth", "token"], {
    env: {
      HOME: environment.HOME,
      PATH: environment.PATH,
      XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME,
      GH_CONFIG_DIR: environment.GH_CONFIG_DIR,
    },
    extendEnv: false,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(command);
      const collected = yield* handle.stdout.pipe(
        Stream.runFold(
          () => ({ bytes: Buffer.alloc(0), oversized: false }),
          (state, chunk) =>
            state.oversized || state.bytes.length + chunk.length > SECRET_VALUE_MAX_BYTES + 1
              ? { bytes: state.bytes, oversized: true }
              : { bytes: Buffer.concat([state.bytes, chunk]), oversized: false },
        ),
        Effect.mapError(() => fail("read-github", "command-failed")),
      );
      const exitCode = yield* handle.exitCode.pipe(
        Effect.mapError(() => fail("read-github", "command-failed")),
      );
      if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
        return yield* fail("read-github", "command-failed");
      }
      if (collected.oversized) {
        return yield* fail("read-github", "value-too-large");
      }
      return collected.bytes.toString("utf8");
    }),
  ).pipe(
    Effect.mapError((error) =>
      error instanceof LocalSecretSourceFailure ? error : fail("read-github", "command-failed"),
    ),
  );
  return yield* validateGithubToken(stdout);
});

const verifyRecoveryReceipt = Effect.fnUntraced(function* (
  config: LocalSecretPaths,
  rootKeyPath: string,
  root: Uint8Array,
) {
  const receiptPath =
    rootKeyPath === config.rootKeyPath
      ? config.recoveryReceiptPath
      : `${rootKeyPath}.recovery.json`;
  if (receiptPath === undefined) {
    return yield* fail("verify-recovery", "recovery-required");
  }
  const encoded = yield* readSecureFile(receiptPath, config.expectedUid, 1024, "read-root").pipe(
    Effect.scoped,
  );
  const receipt = yield* decodeRecoveryReceipt(encoded).pipe(
    Effect.mapError(() => fail("verify-recovery", "recovery-mismatch")),
  );
  const fingerprint = createHash("sha256").update(root).digest("hex");
  if (receipt.rootKeyFingerprint !== fingerprint) {
    return yield* fail("verify-recovery", "recovery-mismatch");
  }
});

const resolve = Effect.fnUntraced(function* (
  config: LocalSecretPaths,
  expectedSourceId: string,
  sourceId: string,
) {
  if (sourceId !== expectedSourceId) {
    return yield* fail("resolve", "unknown-source");
  }
  const { keys } = yield* readRoot(config, config.rootKeyPath);
  const plaintext = yield* readSecureFile(
    config.codexAuthPath,
    config.expectedUid,
    SECRET_VALUE_MAX_BYTES,
    "read-auth",
  ).pipe(Effect.scoped);
  yield* decodeCodexAuth(plaintext).pipe(
    Effect.mapError(() => fail("decode-auth", "invalid-auth")),
  );
  return {
    plaintext,
    keyedDigest: keyedSecretDigest(plaintext, keys.digestKey),
  } satisfies SecretSnapshot;
});

const resolveProduction = Effect.fnUntraced(function* (
  config: LocalSecretPaths,
  environment: Readonly<Record<string, string | undefined>>,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  sourceId: string,
) {
  if (
    sourceId !== CODEX_AUTH_SOURCE_ID &&
    sourceId !== GITHUB_TOKEN_SOURCE_ID &&
    sourceId !== SCOTTY_TOKEN_SOURCE_ID
  ) {
    return yield* fail("resolve", "unknown-source");
  }

  const { keys } = yield* readRoot(config, config.rootKeyPath);
  let plaintext: string;
  if (sourceId === CODEX_AUTH_SOURCE_ID) {
    plaintext = yield* readSecureFile(
      config.codexAuthPath,
      config.expectedUid,
      SECRET_VALUE_MAX_BYTES,
      "read-auth",
    ).pipe(Effect.scoped);
    yield* decodeCodexAuth(plaintext).pipe(
      Effect.mapError(() => fail("decode-auth", "invalid-auth")),
    );
  } else if (sourceId === GITHUB_TOKEN_SOURCE_ID) {
    plaintext = yield* readGithubToken(environment, spawner);
  } else {
    if (config.scottyTokenPath === undefined) {
      return yield* fail("configure", "invalid-path");
    }
    plaintext = yield* readSecureFile(
      config.scottyTokenPath,
      config.expectedUid,
      SECRET_VALUE_MAX_BYTES,
      "read-scotty",
    ).pipe(Effect.scoped);
    plaintext = yield* validateScottyToken(plaintext);
  }

  return {
    plaintext,
    keyedDigest: keyedSecretDigest(plaintext, keys.digestKey),
  } satisfies SecretSnapshot;
});

const localSecretSourceLayer = (
  config: LocalSecretPaths,
  expectedSourceId: string,
): Layer.Layer<SecretSource> =>
  Layer.succeed(SecretSource)({
    resolve: (sourceId) => resolve(config, expectedSourceId, sourceId),
  });

const isCiEnvironment = (environment: Readonly<Record<string, string | undefined>>): boolean =>
  ["CI", "GITHUB_ACTIONS", "BUILDKITE", "CIRCLECI", "GITLAB_CI", "TF_BUILD"].some(
    (name) => environment[name] !== undefined,
  );

/**
 * Exact production provenance mapping. CI is denied and paths are derived only
 * from HOME/CODEX_HOME; no caller-provided source path or source ID is accepted.
 */
export const localCodexSecretPathsFromEnvironment = Effect.fnUntraced(function* (
  environment: Readonly<Record<string, string | undefined>>,
  expectedUid: number,
) {
  if (isCiEnvironment(environment)) {
    return yield* fail("configure", "ci-forbidden");
  }
  const homeDirectory = environment.HOME;
  if (homeDirectory === undefined || !isAbsolute(homeDirectory)) {
    return yield* fail("configure", "invalid-path");
  }
  const codexHome = environment.CODEX_HOME ?? `${homeDirectory}/.codex`;
  if (
    !isAbsolute(codexHome) ||
    (environment[RETAIN_PREVIOUS_OWNER_KEY] !== undefined &&
      environment[RETAIN_PREVIOUS_OWNER_KEY] !== "1")
  ) {
    return yield* fail("configure", "invalid-path");
  }
  const rootKeyPath = `${homeDirectory}/.config/scotty/secrets/root-key`;
  return {
    codexAuthPath: `${codexHome}/auth.json`,
    rootKeyPath,
    recoveryReceiptPath: `${rootKeyPath}.recovery.json`,
    previousRootKeyPaths:
      environment[RETAIN_PREVIOUS_OWNER_KEY] === "1" ? [`${rootKeyPath}.previous`] : [],
    expectedUid,
  } satisfies LocalSecretPaths;
});

/** Lazy production source: validates provenance now, opens files only on resolve. */
export const localCodexSecretSourceLayer = (
  environment: Readonly<Record<string, string | undefined>>,
  expectedUid: number,
): Layer.Layer<SecretSource, LocalSecretSourceFailure> =>
  Layer.unwrap(
    Effect.map(localCodexSecretPathsFromEnvironment(environment, expectedUid), (config) =>
      localSecretSourceLayer(config, CODEX_AUTH_SOURCE_ID),
    ),
  );

const nodeChildProcessSpawnerLayer = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
);

const localProductionSecretPathsFromEnvironment = Effect.fnUntraced(function* (
  environment: Readonly<Record<string, string | undefined>>,
  expectedUid: number,
) {
  const config = yield* localCodexSecretPathsFromEnvironment(environment, expectedUid);
  return {
    ...config,
    scottyTokenPath: `${dirname(config.rootKeyPath)}/scotty-token`,
  } satisfies LocalSecretPaths;
});

/** Lazy production source for the exact Codex, GitHub, and Scotty source IDs. */
export const localProductionSecretSourceLayer = (
  environment: Readonly<Record<string, string | undefined>>,
  expectedUid: number,
): Layer.Layer<SecretSource, LocalSecretSourceFailure> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* localProductionSecretPathsFromEnvironment(environment, expectedUid);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return Layer.succeed(SecretSource)({
        resolve: (sourceId) => resolveProduction(config, environment, spawner, sourceId),
      });
    }),
  ).pipe(Layer.provide(nodeChildProcessSpawnerLayer));

/** Disposable synthetic-canary/test boundary; never use for real credentials. */
export const disposableLocalSecretSourceLayer = (
  config: LocalSecretPaths,
  syntheticSourceId: string,
): Layer.Layer<SecretSource> => localSecretSourceLayer(config, syntheticSourceId);

/**
 * Explicit pre-plan sync boundary. Reads the source and projects metadata;
 * Alchemy stack construction and planning must consume only its output.
 */
export const syncLocalSecretMetadata = Effect.fnUntraced(function* (
  sourceId = CODEX_AUTH_SOURCE_ID,
) {
  const source = yield* SecretSource;
  const snapshot = yield* source.resolve(sourceId);
  return { sourceId, keyedDigest: snapshot.keyedDigest } as const;
});

/** Stable active owner key plus explicitly retained keys for rotation. */
export const localSecretOwnerKeyLayer = (
  config: LocalSecretPaths,
): Layer.Layer<SecretOwnerKey, LocalSecretSourceFailure> =>
  Layer.effect(
    SecretOwnerKey,
    Effect.gen(function* () {
      const previousRootKeyPaths = config.previousRootKeyPaths ?? [];
      if (previousRootKeyPaths.length > MAX_PREVIOUS_OWNER_KEYS) {
        return yield* fail("configure", "too-many-previous-keys");
      }
      const active = yield* readRoot(config, config.rootKeyPath);
      yield* verifyRecoveryReceipt(config, config.rootKeyPath, active.root);
      const previous = yield* Effect.forEach(previousRootKeyPaths, (rootKeyPath) =>
        Effect.gen(function* () {
          const retained = yield* readRoot(config, rootKeyPath);
          yield* verifyRecoveryReceipt(config, rootKeyPath, retained.root);
          return retained.keys.ownerKey;
        }),
      );
      return { active: active.keys.ownerKey, previous };
    }),
  );

/** Stable production owner key with mandatory matching recovery evidence. */
export const localCodexSecretOwnerKeyLayer = (
  environment: Readonly<Record<string, string | undefined>>,
  expectedUid: number,
): Layer.Layer<SecretOwnerKey, LocalSecretSourceFailure> =>
  Layer.unwrap(
    Effect.map(localCodexSecretPathsFromEnvironment(environment, expectedUid), (config) =>
      localSecretOwnerKeyLayer(config),
    ),
  );

/** Disposable canary-only owner key; no recovery escrow is required. */
export const disposableLocalSecretOwnerKeyLayer = (
  config: LocalSecretPaths,
): Layer.Layer<SecretOwnerKey, LocalSecretSourceFailure> =>
  Layer.effect(
    SecretOwnerKey,
    Effect.map(readRoot(config, config.rootKeyPath), ({ keys }) => ({
      active: keys.ownerKey,
      previous: [],
    })),
  );

/** Reads validated synthetic markers solely for local plan/output disclosure scans. */
export const disposableLocalSecretScanMarkers = Effect.fnUntraced(function* (
  config: LocalSecretPaths,
  syntheticSourceId: string,
) {
  const snapshot = yield* resolve(config, syntheticSourceId, syntheticSourceId);
  const decoded = yield* decodeCodexAuth(snapshot.plaintext).pipe(
    Effect.mapError(() => fail("decode-auth", "invalid-auth")),
  );
  const credential =
    "OPENAI_API_KEY" in decoded ? decoded.OPENAI_API_KEY : decoded.tokens.access_token;
  const root = yield* readSecureFile(config.rootKeyPath, config.expectedUid, 64, "read-root").pipe(
    Effect.scoped,
  );
  return [snapshot.plaintext, credential, root] as const;
});
